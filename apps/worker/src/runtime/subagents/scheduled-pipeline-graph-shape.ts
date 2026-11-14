import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"

export type ScheduledPipelineGraphVersion = "v1" | "v2"
export type ScheduledPipelineGraphStage = "analyze" | "prepare" | "gate" | "audit"
export type ScheduledPipelineGraphNode = Readonly<{
  key: string
  templateId: string
  depth: number
  dependsOn: readonly string[]
  packageRefs?: readonly string[]
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
export type ScheduledPipelineAuditProjection<Node> = Base<Node, "audit"> & Readonly<{
  prepare: Node
  gate: Node
  executes: readonly Node[]
  audit: Node
}>
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
    || !Array.isArray(nodes) || nodes.length > TASK_GRAPH_LIMITS.maxPersistedNodes || nodes.some(node => !validNode(node))
    || new Set(nodes.map(node => node.key)).size !== nodes.length) return null
  let scoutCount = 0
  while (scoutCount < nodes.length && nodes[scoutCount]?.templateId === "scout") scoutCount++
  if (version === "v1" ? scoutCount !== 1 : scoutCount < 2 || scoutCount > 4) return null
  const prefixLength = scoutCount + 1
  const expectedLength = stage === "analyze" ? prefixLength : stage === "prepare" ? prefixLength + 1
    : stage === "gate" ? prefixLength + 2 : undefined
  if (expectedLength !== undefined && nodes.length !== expectedLength) return null
  if (stage === "audit" && (nodes.length < prefixLength + 3 || nodes.length > prefixLength + 6)) return null
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
  const executes = nodes.slice(scoutCount + 3, -1), audit = nodes[nodes.length - 1]
  if (executes.length === 0) {
    return validSuffix(audit, "scheduled_audit", "scheduled_audit", 5, gate.key)
      ? Object.freeze({ ...base, stage, prepare, gate, executes: Object.freeze([]), audit }) : null
  }
  const packageRefs = executes.flatMap(node => [...(node.packageRefs ?? [])])
  if (version !== "v2" || executes.length > 3 || executes.length > 1 && executes.some(node => node.packageRefs?.length === 0)
    || new Set(packageRefs).size !== packageRefs.length || packageRefs.length > TASK_GRAPH_LIMITS.maxScheduledPackageRefs
    || !executes.every(node => node.templateId === "scheduled.application.execute" && node.depth === 5
    && node.dependsOn.length === 1 && node.dependsOn[0] === gate.key)
    || !audit || audit.key !== "scheduled.post_gate_audit" || audit.templateId !== "scheduled.post_gate_audit" || audit.depth !== 6
    || !sameKeySet(audit.dependsOn, executes.map(node => node.key))) return null
  return Object.freeze({ ...base, stage, prepare, gate, executes: Object.freeze(executes), audit })
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
  if (!Array.isArray(nodes)) return null
  let scoutCount = 0
  while (scoutCount < nodes.length && nodes[scoutCount]?.templateId === "scout") scoutCount++
  const version: ScheduledPipelineGraphVersion | null = scoutCount === 1 ? "v1"
    : scoutCount >= 2 && scoutCount <= 4 ? "v2" : null
  const suffix = nodes.length - scoutCount - 1
  const stage: ScheduledPipelineGraphStage | undefined = suffix === 0 ? "analyze" : suffix === 1 ? "prepare"
    : suffix === 2 ? "gate" : suffix >= 3 && suffix <= 6 ? "audit" : undefined
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
  const hasPackageRefs = Object.hasOwn(value, "packageRefs")
  return validKey(node.key) && validKey(node.templateId) && Number.isSafeInteger(node.depth)
    && Array.isArray(node.dependsOn) && node.dependsOn.every(validKey)
    && (node.templateId === "scheduled.application.execute"
      ? hasPackageRefs && validPackageRefs(node.packageRefs)
      : !hasPackageRefs)
}
function validPackageRefs(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > TASK_GRAPH_LIMITS.maxScheduledPackageRefs) return false
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1 || !keys.every(key => key === "length"
    || typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)) return false
  return value.every(ref => typeof ref === "string" && ref.length > 0 && ref.length <= 256 && ref.trim() === ref
    && !/[\u0000-\u001f\u007f]/.test(ref)) && new Set(value).size === value.length
}
function validKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
}
function sameKeySet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && new Set(right).size === right.length
    && left.every(key => right.includes(key))
}
