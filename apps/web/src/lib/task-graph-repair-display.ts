import {
  parsePlanLedger,
  parseTaskGraphSnapshot,
  TASK_GRAPH_SCHEMA_VERSION,
  type PlanLedger,
  type TaskGraphVerificationDisplayNode,
  type TaskGraphVerificationSummary,
} from '@jobcopilot/agent-protocol'

type PlanLedgerNode = PlanLedger['nodes'][number]
export type PlanLedgerWithRepairTargetGoals = Omit<PlanLedger, 'nodes'> & {
  nodes: readonly (PlanLedgerNode & { repairTargetGoal?: string; repairTargetNodeIndex?: number })[]
}

/** Adds only safe target details from a strictly matched same-root repair relation. */
export function decoratePlanLedgerRepairTargets(
  projection: PlanLedger,
  rawGraph: unknown,
  trustedRootTaskId: string | null,
): PlanLedgerWithRepairTargetGoals {
  const graph = parseTaskGraphSnapshot(rawGraph)
  const raw = parseRecord(rawGraph)
  if (!graph || !raw || !trustedRootTaskId || !Array.isArray(raw.nodes)
    || raw.nodes.length !== graph.nodes.length || projection.nodes.length !== graph.nodes.length
    || graph.nodes.some((node, index) => projection.nodes[index]?.key !== node.key)) return projection

  const repairTargets = new Map<string, { goal: string; nodeIndex: number }>()
  for (let index = 0; index < graph.nodes.length; index += 1) {
    const source = graph.nodes[index]
    const rawNode = record(raw.nodes[index])
    const relation = record(rawNode?.repairOf)
    if (!source || !relation || relation.graphRootTaskId !== trustedRootTaskId
      || typeof relation.nodeKey !== 'string' || typeof relation.taskId !== 'string') continue
    const targets = graph.nodes.filter(node => node.key === relation.nodeKey && node.taskId === relation.taskId)
    const target = targets[0]
    const targetNodeIndex = target ? graph.nodes.indexOf(target) : -1
    const targetProjection = projection.nodes[targetNodeIndex]
    if (targets.length !== 1 || !target || targetNodeIndex === index || target.key === source.key || target.taskId === source.taskId
      || targetProjection?.key !== target.key) continue
    const targetGoal = targetProjection.goal
    if (typeof targetGoal === 'string' && targetGoal.trim() === targetGoal && targetGoal.length > 0 && targetGoal.length <= 240) {
      repairTargets.set(source.key, { goal: targetGoal, nodeIndex: targetNodeIndex })
    }
  }
  if (repairTargets.size === 0) return projection
  return {
    ...projection,
    nodes: projection.nodes.map(node => {
      const target = repairTargets.get(node.key)
      return target ? { ...node, repairTargetGoal: target.goal, repairTargetNodeIndex: target.nodeIndex } : node
    }),
  }
}

/** Parses both legacy PlanLedger and the narrowly extended display-only form. */
export function parsePlanLedgerWithRepairTargets(value: unknown): PlanLedgerWithRepairTargetGoals | null {
  const parsed = parseJson(value)
  const row = record(parsed)
  if (!row || !Array.isArray(row.nodes)) return null
  const rawNodes = row.nodes
  const goals = new Map<number, string>()
  const targetIndices = new Map<number, number>()
  let malformedDecoration = false
  const nodes = rawNodes.map((node, index) => {
    const item = record(node)
    if (!item || !Object.hasOwn(item, 'repairTargetGoal') && !Object.hasOwn(item, 'repairTargetNodeIndex')) return node
    const hasGoal = Object.hasOwn(item, 'repairTargetGoal')
    const goal = item.repairTargetGoal
    if (hasGoal && typeof goal === 'string') goals.set(index, goal)
    else if (hasGoal) malformedDecoration = true
    if (Object.hasOwn(item, 'repairTargetNodeIndex')) {
      const targetIndex = item.repairTargetNodeIndex
      if (!hasGoal || typeof goal !== 'string' || !Number.isSafeInteger(targetIndex)
        || Number(targetIndex) < 0 || Number(targetIndex) >= rawNodes.length || targetIndex === index) malformedDecoration = true
      else targetIndices.set(index, Number(targetIndex))
    }
    const baseNode = { ...item }
    delete baseNode.repairTargetGoal
    delete baseNode.repairTargetNodeIndex
    return baseNode
  })
  if (malformedDecoration) return null

  const base = parsePlanLedger({ ...row, nodes })
  if (!base) return null
  const projectedNodes: Array<PlanLedgerNode & { repairTargetGoal?: string; repairTargetNodeIndex?: number }> = []
  for (let index = 0; index < base.nodes.length; index += 1) {
    const node = base.nodes[index]!
    const repairTargetGoal = goals.get(index)
    if (repairTargetGoal === undefined) {
      projectedNodes.push(node)
    } else {
      const repairTargetNodeIndex = targetIndices.get(index)
      if (repairTargetNodeIndex === undefined) {
        if (!base.nodes.some(target => target.key !== node.key && target.goal === repairTargetGoal)) return null
        projectedNodes.push({ ...node, repairTargetGoal })
      } else {
        const target = base.nodes[repairTargetNodeIndex]
        if (!target || target.key === node.key || target.goal !== repairTargetGoal) return null
        projectedNodes.push({ ...node, repairTargetGoal, repairTargetNodeIndex })
      }
    }
  }
  return { ...base, nodes: projectedNodes }
}

/** Projects only allowlisted unmet checks from the indexed target in the matched ledger. */
export function projectRepairAttentionSummaries(
  projection: PlanLedgerWithRepairTargetGoals,
  summary: TaskGraphVerificationSummary | null,
): readonly TaskGraphVerificationDisplayNode[] {
  if (!summary || summary.nodes.length !== projection.nodes.length) return projection.nodes.map(() => null)
  return projection.nodes.map((node, index) => {
    const targetIndex = node.repairTargetNodeIndex
    if (targetIndex === undefined || !Number.isSafeInteger(targetIndex) || targetIndex < 0
      || targetIndex >= projection.nodes.length || targetIndex === index || !node.repairTargetGoal) return null
    const targetPlanNode = projection.nodes[targetIndex]
    if (!targetPlanNode || targetPlanNode.key === node.key || targetPlanNode.goal !== node.repairTargetGoal) return null
    const target = summary.nodes[targetIndex]
    if (!target || target.status === 'unavailable') return null
    const checks = target.checks.filter(check => check.status !== 'passed')
    if (checks.length === 0) return null
    const failedCount = checks.filter(check => check.status === 'failed').length
    const unverifiedCount = checks.filter(check => check.status === 'unverified').length
    return { status: failedCount > 0 ? 'failed' : 'unverified', checks, totalCount: checks.length, passedCount: 0, failedCount, unverifiedCount }
  })
}

/** Uses the strict public graph projection for task_graph timeline items. */
export function redactTaskGraphTimelineContent(
  itemType: string,
  content: unknown,
  existingRedactor: (value: unknown) => unknown,
): unknown {
  if (itemType !== 'task_graph') return existingRedactor(content)
  const snapshot = parseTaskGraphSnapshot(content)
  if (!snapshot) return null
  const normalized = {
    schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
    nodes: snapshot.nodes.map(node => ({
      key: redactedText(node.key, existingRedactor),
      templateId: redactedText(node.templateId, existingRedactor),
      goal: redactedText(node.goal, existingRedactor),
      successCriteria: node.successCriteria.map(value => redactedText(value, existingRedactor)),
      dependsOn: node.dependsOn.map(value => redactedText(value, existingRedactor)),
      depth: node.depth,
      taskId: redactedText(node.taskId, existingRedactor),
    })),
  }
  return parseTaskGraphSnapshot(normalized) ? normalized : null
}

function redactedText(value: string, redact: (value: unknown) => unknown): string {
  const result = redact(value)
  return typeof result === 'string' ? result : '[REDACTED]'
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) as unknown } catch { return null }
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  return record(parseJson(value))
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    const keys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null)
      || keys.some(key => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key))) return null
    return value as Record<string, unknown>
  } catch { return null }
}
