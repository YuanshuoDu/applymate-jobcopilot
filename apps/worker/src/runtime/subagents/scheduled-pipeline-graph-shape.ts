export type ScheduledPipelineGraphVersion = "v1" | "v2"
export type ScheduledPipelineGraphStage = "analyze" | "prepare" | "gate" | "audit"
export type ScheduledPipelineGraphNode = Readonly<{
  key: string
  templateId: string
  depth: number
  dependsOn: readonly string[]
}>

type Base<Node, Stage extends ScheduledPipelineGraphStage> = Readonly<{
  version: ScheduledPipelineGraphVersion
  stage: Stage
  scouts: readonly Node[]
  analyst: Node
}>
export type ScheduledPipelineAnalyzeProjection<Node> = Base<Node, "analyze">
export type ScheduledPipelinePrepareProjection<Node> = Base<Node, "prepare"> & Readonly<{ prepare: Node }>
export type ScheduledPipelineGateProjection<Node> = Base<Node, "gate"> & Readonly<{ prepare: Node; gate: Node }>
export type ScheduledPipelineAuditProjection<Node> = Base<Node, "audit"> & Readonly<{ prepare: Node; gate: Node; audit: Node }>
export type ScheduledPipelineGraphProjection<Node> = ScheduledPipelineAnalyzeProjection<Node>
  | ScheduledPipelinePrepareProjection<Node> | ScheduledPipelineGateProjection<Node> | ScheduledPipelineAuditProjection<Node>

export function projectScheduledPipelineGraph<Node extends ScheduledPipelineGraphNode>(
  nodes: readonly Node[], version: ScheduledPipelineGraphVersion, stage: "analyze",
): ScheduledPipelineAnalyzeProjection<Node> | null
export function projectScheduledPipelineGraph<Node extends ScheduledPipelineGraphNode>(
  nodes: readonly Node[], version: ScheduledPipelineGraphVersion, stage: "prepare",
): ScheduledPipelinePrepareProjection<Node> | null
export function projectScheduledPipelineGraph<Node extends ScheduledPipelineGraphNode>(
  nodes: readonly Node[], version: ScheduledPipelineGraphVersion, stage: "gate",
): ScheduledPipelineGateProjection<Node> | null
export function projectScheduledPipelineGraph<Node extends ScheduledPipelineGraphNode>(
  nodes: readonly Node[], version: ScheduledPipelineGraphVersion, stage: "audit",
): ScheduledPipelineAuditProjection<Node> | null
export function projectScheduledPipelineGraph<Node extends ScheduledPipelineGraphNode>(
  nodes: readonly Node[], version: ScheduledPipelineGraphVersion, stage: ScheduledPipelineGraphStage,
): ScheduledPipelineGraphProjection<Node> | null
export function projectScheduledPipelineGraph<Node extends ScheduledPipelineGraphNode>(
  nodes: readonly Node[], version: ScheduledPipelineGraphVersion, stage: ScheduledPipelineGraphStage,
): ScheduledPipelineGraphProjection<Node> | null {
  if ((version !== "v1" && version !== "v2") || !["analyze", "prepare", "gate", "audit"].includes(stage)
    || !Array.isArray(nodes) || nodes.length > 8 || nodes.some(node => !validNode(node))
    || new Set(nodes.map(node => node.key)).size !== nodes.length) return null
  let scoutCount = 0
  while (scoutCount < nodes.length && nodes[scoutCount]?.templateId === "scout") scoutCount++
  if (version === "v1" ? scoutCount !== 1 : scoutCount < 2 || scoutCount > 4) return null
  const suffixCount = stage === "analyze" ? 0 : stage === "prepare" ? 1 : stage === "gate" ? 2 : 3
  if (nodes.length !== scoutCount + 1 + suffixCount) return null
  const scouts = nodes.slice(0, scoutCount), analyst = nodes[scoutCount]
  if (!scouts.every(node => node.depth === 1 && node.dependsOn.length === 0)
    || !analyst || analyst.templateId !== "analyst" || analyst.depth !== 2
    || !sameKeySet(analyst.dependsOn, scouts.map(node => node.key))) return null
  const base = { version, scouts: Object.freeze(scouts), analyst }
  if (stage === "analyze") return Object.freeze({ ...base, stage })
  const prepare = nodes[scoutCount + 1]
  if (!validSuffix(prepare, "prepare", "prepare", 3, analyst.key)) return null
  if (stage === "prepare") return Object.freeze({ ...base, stage, prepare })
  const gate = nodes[scoutCount + 2]
  if (!validSuffix(gate, "gate", "gate", 4, prepare.key)) return null
  if (stage === "gate") return Object.freeze({ ...base, stage, prepare, gate })
  const audit = nodes[scoutCount + 3]
  return validSuffix(audit, "scheduled_audit", "scheduled_audit", 5, gate.key)
    ? Object.freeze({ ...base, stage, prepare, gate, audit }) : null
}

/** V2-only contract check; legacy v1 selector eligibility stays with its existing verifier. */
export function scheduledPipelineV2ScoutMembershipMatches(
  keys: readonly string[], scouts: readonly ScheduledPipelineGraphNode[],
): boolean {
  return Array.isArray(keys) && Array.isArray(scouts) && scouts.length >= 2 && scouts.length <= 4 && scouts.every(validNode)
    && keys.every(validKey) && sameKeySet(keys, scouts.map(node => node.key))
}

/** Infers only a fully valid persisted stage; callers still verify owner-bound receipts separately. */
export function projectScheduledPipelineGraphAtCurrentStage<Node extends ScheduledPipelineGraphNode>(
  nodes: readonly Node[],
): Readonly<{ version: ScheduledPipelineGraphVersion; projection: ScheduledPipelineGraphProjection<Node> }> | null {
  let scoutCount = 0
  while (scoutCount < nodes.length && nodes[scoutCount]?.templateId === "scout") scoutCount++
  const version: ScheduledPipelineGraphVersion | null = scoutCount === 1 ? "v1"
    : scoutCount >= 2 && scoutCount <= 4 ? "v2" : null
  const suffix = nodes.length - scoutCount - 1
  const stage: ScheduledPipelineGraphStage | undefined = ["analyze", "prepare", "gate", "audit"][suffix] as ScheduledPipelineGraphStage | undefined
  if (!version || !stage) return null
  const projection = projectScheduledPipelineGraph(nodes, version, stage)
  return projection ? { version, projection } : null
}

function validSuffix<Node extends ScheduledPipelineGraphNode>(
  node: Node | undefined, key: string, templateId: string, depth: number, dependency: string,
): node is Node {
  return !!node && node.key === key && node.templateId === templateId && node.depth === depth
    && node.dependsOn.length === 1 && node.dependsOn[0] === dependency
}
function validNode(value: unknown): value is ScheduledPipelineGraphNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const node = value as ScheduledPipelineGraphNode
  return validKey(node.key) && validKey(node.templateId) && Number.isSafeInteger(node.depth)
    && Array.isArray(node.dependsOn) && node.dependsOn.every(validKey)
}
function validKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
}
function sameKeySet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && new Set(right).size === right.length
    && left.every(key => right.includes(key))
}
