const TASK_GRAPH_SCHEMA_VERSION = 'agent-harness.v2.task-graph'
const MAX_SNAPSHOT_BYTES = 40_000
const MAX_NODES = 8
const MAX_DEPTH = 8
const MAX_SUCCESS_CRITERIA = 8
const MAX_DEPENDENCIES = 8
const MAX_GOAL_LENGTH = 1_200
const MAX_CRITERION_LENGTH = 320
export const TASK_GRAPH_MAX_IDENTIFIER_LENGTH = 128

export type TaskGraphSnapshotNode = Readonly<{
  key: string
  templateId: string
  goal: string
  successCriteria: readonly string[]
  dependsOn: readonly string[]
  depth: number
  taskId: string
}>
export type TaskGraphSnapshot = Readonly<{ nodes: readonly TaskGraphSnapshotNode[] }>

export function parseTaskGraphSnapshot(value: unknown): TaskGraphSnapshot | null {
  try {
    const content = typeof value === 'string' ? JSON.parse(value) as unknown : value
    if (!isExactRecord(content, ['nodes', 'schemaVersion']) || content.schemaVersion !== TASK_GRAPH_SCHEMA_VERSION
      || !Array.isArray(content.nodes) || content.nodes.length > MAX_NODES) return null

    const nodes: TaskGraphSnapshotNode[] = []
    const keys = new Set<string>()
    const taskIds = new Set<string>()
    for (const value of content.nodes) {
      if (!isExactRecord(value, ['dependsOn', 'depth', 'goal', 'key', 'successCriteria', 'taskId', 'templateId'])) return null
      const key = boundedText(value.key, TASK_GRAPH_MAX_IDENTIFIER_LENGTH)
      const templateId = boundedText(value.templateId, TASK_GRAPH_MAX_IDENTIFIER_LENGTH)
      const goal = boundedText(value.goal, MAX_GOAL_LENGTH)
      const taskId = boundedText(value.taskId, TASK_GRAPH_MAX_IDENTIFIER_LENGTH)
      const successCriteria = parseTextList(value.successCriteria, 1, MAX_SUCCESS_CRITERIA, MAX_CRITERION_LENGTH)
      const dependsOn = parseTextList(value.dependsOn, 0, MAX_DEPENDENCIES, TASK_GRAPH_MAX_IDENTIFIER_LENGTH)
      if (!key || !templateId || !goal || !taskId || !successCriteria || !dependsOn
        || !Number.isSafeInteger(value.depth) || Number(value.depth) < 1 || Number(value.depth) > MAX_DEPTH
        || new Set(dependsOn).size !== dependsOn.length || keys.has(key) || taskIds.has(taskId)) return null
      keys.add(key)
      taskIds.add(taskId)
      nodes.push({ key, templateId, goal, successCriteria, dependsOn, depth: Number(value.depth), taskId })
    }
    if (nodes.some(node => node.dependsOn.some(key => !keys.has(key))) || !isAcyclic(nodes)) return null
    const snapshot = { nodes }
    return new TextEncoder().encode(canonicalJson({ schemaVersion: TASK_GRAPH_SCHEMA_VERSION, ...snapshot })).byteLength <= MAX_SNAPSHOT_BYTES
      ? snapshot
      : null
  } catch {
    return null
  }
}

function isAcyclic(nodes: readonly TaskGraphSnapshotNode[]): boolean {
  const indegree = new Map(nodes.map(node => [node.key, node.dependsOn.length] as const))
  const children = new Map<string, string[]>()
  for (const node of nodes) for (const dependency of node.dependsOn) {
    children.set(dependency, [...(children.get(dependency) ?? []), node.key])
  }
  const queue = nodes.filter(node => indegree.get(node.key) === 0).map(node => node.key)
  let processed = 0
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const key = queue[cursor]!
    processed++
    for (const child of children.get(key) ?? []) {
      const next = indegree.get(child)! - 1
      indegree.set(child, next)
      if (next === 0) queue.push(child)
    }
  }
  return processed === nodes.length
}

function parseTextList(value: unknown, minimum: number, maximum: number, maxTextLength: number): string[] | null {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return null
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== value.length + 1) return null
  const result: string[] = []
  for (const ownKey of ownKeys) {
    if (ownKey === 'length') continue
    if (typeof ownKey !== 'string') return null
    const index = Number(ownKey)
    if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== ownKey) return null
    const text = boundedText(value[index], maxTextLength)
    if (!text) return null
    result.push(text)
  }
  return result
}

function isExactRecord(value: unknown, expectedKeys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  const ownKeys = Reflect.ownKeys(value)
  return (prototype === Object.prototype || prototype === null)
    && ownKeys.every((key): key is string => typeof key === 'string')
    && ownKeys.sort().join(',') === [...expectedKeys].sort().join(',')
}

function boundedText(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum ? value : null
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new TypeError('task_graph_snapshot_invalid')
  return encoded
}
