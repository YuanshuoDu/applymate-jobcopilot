import {
  parsePlanLedger,
  parseTaskGraphSnapshot,
  TASK_GRAPH_SCHEMA_VERSION,
  type PlanLedger,
} from '@jobcopilot/agent-protocol'

type PlanLedgerNode = PlanLedger['nodes'][number]
export type PlanLedgerWithRepairTargetGoals = Omit<PlanLedger, 'nodes'> & {
  nodes: readonly (PlanLedgerNode & { repairTargetGoal?: string })[]
}

/** Adds only the already-redacted goal for a strictly matched same-root repair target. */
export function decoratePlanLedgerRepairTargets(
  projection: PlanLedger,
  rawGraph: unknown,
  trustedRootTaskId: string | null,
): PlanLedgerWithRepairTargetGoals {
  const graph = parseTaskGraphSnapshot(rawGraph)
  const raw = parseRecord(rawGraph)
  if (!graph || !raw || !trustedRootTaskId || !Array.isArray(raw.nodes)) return projection

  const repairGoals = new Map<string, string>()
  for (let index = 0; index < graph.nodes.length; index += 1) {
    const source = graph.nodes[index]
    const rawNode = record(raw.nodes[index])
    const relation = record(rawNode?.repairOf)
    if (!source || !relation || relation.graphRootTaskId !== trustedRootTaskId
      || typeof relation.nodeKey !== 'string' || typeof relation.taskId !== 'string') continue
    const targets = graph.nodes.filter(node => node.key === relation.nodeKey && node.taskId === relation.taskId)
    if (targets.length !== 1 || targets[0]?.key === source.key || targets[0]?.taskId === source.taskId) continue
    const targetGoal = projection.nodes.find(node => node.key === targets[0]?.key)?.goal
    if (typeof targetGoal === 'string' && targetGoal.trim() === targetGoal && targetGoal.length > 0 && targetGoal.length <= 240) {
      repairGoals.set(source.key, targetGoal)
    }
  }
  if (repairGoals.size === 0) return projection
  return {
    ...projection,
    nodes: projection.nodes.map(node => {
      const repairTargetGoal = repairGoals.get(node.key)
      return repairTargetGoal ? { ...node, repairTargetGoal } : node
    }),
  }
}

/** Parses both legacy PlanLedger and the narrowly extended display-only form. */
export function parsePlanLedgerWithRepairTargets(value: unknown): PlanLedgerWithRepairTargetGoals | null {
  const parsed = parseJson(value)
  const row = record(parsed)
  if (!row || !Array.isArray(row.nodes)) return null
  const goals = new Map<number, string>()
  const nodes = row.nodes.map((node, index) => {
    const item = record(node)
    if (!item || !Object.hasOwn(item, 'repairTargetGoal')) return node
    const goal = item.repairTargetGoal
    if (typeof goal !== 'string') return node
    goals.set(index, goal)
    const baseNode = { ...item }
    delete baseNode.repairTargetGoal
    return baseNode
  })
  if ([...row.nodes].some((node, index) => Object.hasOwn(record(node) ?? {}, 'repairTargetGoal') && !goals.has(index))) return null

  const base = parsePlanLedger({ ...row, nodes })
  if (!base) return null
  const projectedNodes: Array<PlanLedgerNode & { repairTargetGoal?: string }> = []
  for (let index = 0; index < base.nodes.length; index += 1) {
    const node = base.nodes[index]!
    const repairTargetGoal = goals.get(index)
    if (repairTargetGoal === undefined) {
      projectedNodes.push(node)
    } else {
      if (!base.nodes.some(target => target.key !== node.key && target.goal === repairTargetGoal)) return null
      projectedNodes.push({ ...node, repairTargetGoal })
    }
  }
  return { ...base, nodes: projectedNodes }
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
