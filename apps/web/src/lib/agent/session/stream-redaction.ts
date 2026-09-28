import { AGENT_STREAM_SCHEMA_VERSION } from '@jobcopilot/agent-protocol'
import { redactSensitiveText, redactSensitiveValue } from '@jobcopilot/shared'

const TASK_GRAPH_SCHEMA_VERSION = 'agent-harness.v2.task-graph'
const MAX_SNAPSHOT_BYTES = 40_000
const MAX_NODES = 8
const MAX_DEPTH = 8
const MAX_SUCCESS_CRITERIA = 8
const MAX_DEPENDENCIES = 8
const MAX_GOAL_LENGTH = 1_200
const MAX_CRITERION_LENGTH = 320
const MAX_IDENTIFIER_LENGTH = 128
const TASK_GRAPH_PROPOSAL_KEYS = ['kind', 'fingerprint', 'receipt', 'revision', 'item'] as const
const TASK_GRAPH_PROPOSAL_CONTENT_KEYS = [...TASK_GRAPH_PROPOSAL_KEYS, 'content'] as const
const TASK_GRAPH_LIFECYCLE_KEYS = ['kind', 'event', 'revision', 'item'] as const
const TASK_GRAPH_ITEM_KEYS = [
  'schemaVersion', 'id', 'sessionId', 'turnId', 'stepId', 'taskId', 'type', 'status', 'phase', 'revision',
  'content', 'startedAt', 'completedAt', 'createdAt', 'updatedAt',
] as const

type StreamItemIdentity = Readonly<{
  sessionId: string
  turnId: string
  itemId: string | null
  taskId: string | null
}>
type TaskGraphSnapshotNode = Readonly<{
  key: string
  templateId: string
  goal: string
  successCriteria: readonly string[]
  dependsOn: readonly string[]
  depth: number
  taskId: string
}>
type TaskGraphSnapshot = Readonly<{ nodes: readonly TaskGraphSnapshotNode[] }>

export function redactStreamString(value: string): string {
  return redactSensitiveText(value)
}

export function redactStreamValue(value: unknown, key: string | null = null, depth = 0): unknown {
  return redactSensitiveValue(value, key, depth, 6)
}

export function redactStreamEventPayload(eventType: string, payload: unknown, identity: StreamItemIdentity): unknown {
  const redacted = redactStreamValue(payload)
  if (eventType !== 'item.started' && eventType !== 'item.delta') return redacted

  const snapshot = taskGraphSnapshotFromEvent(eventType, payload, identity)
  if (!snapshot || !isRecord(redacted) || !isRecord(redacted.item)) return redacted
  return { ...redacted, item: { ...redacted.item, content: redactTaskGraphSnapshot(snapshot) } }
}

function taskGraphSnapshotFromEvent(eventType: string, payload: unknown, identity: StreamItemIdentity): TaskGraphSnapshot | null {
  if (!isRecord(payload) || !identity.itemId || !identity.taskId) return null
  const proposal = payload.kind === 'proposal' && (isExactRecord(payload, TASK_GRAPH_PROPOSAL_KEYS)
    || (eventType === 'item.delta' && isExactRecord(payload, TASK_GRAPH_PROPOSAL_CONTENT_KEYS)))
  const lifecycle = eventType === 'item.delta' && payload.kind === 'lifecycle' && isExactRecord(payload, TASK_GRAPH_LIFECYCLE_KEYS)
  if ((!proposal && !lifecycle) || !Number.isSafeInteger(payload.revision) || !isExactRecord(payload.item, TASK_GRAPH_ITEM_KEYS)) return null
  const item = payload.item
  if (item.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION || item.id !== identity.itemId || item.sessionId !== identity.sessionId
    || item.turnId !== identity.turnId || item.taskId !== identity.taskId || item.type !== 'task_graph' || item.revision !== payload.revision) return null
  return parseTaskGraphSnapshot(item.content)
}

function redactTaskGraphSnapshot(snapshot: TaskGraphSnapshot): Record<string, unknown> {
  return {
    schemaVersion: redactSensitiveText(TASK_GRAPH_SCHEMA_VERSION),
    nodes: snapshot.nodes.map(node => ({
      key: redactSensitiveText(node.key),
      templateId: redactSensitiveText(node.templateId),
      goal: redactSensitiveText(node.goal),
      successCriteria: node.successCriteria.map(redactSensitiveText),
      dependsOn: node.dependsOn.map(redactSensitiveText),
      depth: node.depth,
      taskId: redactSensitiveText(node.taskId),
    })),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isExactRecord(value: unknown, expectedKeys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const keys = Reflect.ownKeys(value)
  return keys.length === expectedKeys.length && keys.every((key): key is string => typeof key === 'string' && expectedKeys.includes(key))
}

function parseTaskGraphSnapshot(value: unknown): TaskGraphSnapshot | null {
  try {
    const content = typeof value === 'string' ? JSON.parse(value) as unknown : value
    if (!isExactRecord(content, ['nodes', 'schemaVersion']) || content.schemaVersion !== TASK_GRAPH_SCHEMA_VERSION
      || !Array.isArray(content.nodes) || content.nodes.length > MAX_NODES) return null
    const nodes: TaskGraphSnapshotNode[] = []
    const keys = new Set<string>(), taskIds = new Set<string>()
    for (const raw of content.nodes as unknown[]) {
      if (!isExactRecord(raw, ['dependsOn', 'depth', 'goal', 'key', 'successCriteria', 'taskId', 'templateId'])) return null
      const key = boundedText(raw.key, MAX_IDENTIFIER_LENGTH), templateId = boundedText(raw.templateId, MAX_IDENTIFIER_LENGTH)
      const goal = boundedText(raw.goal, MAX_GOAL_LENGTH), taskId = boundedText(raw.taskId, MAX_IDENTIFIER_LENGTH)
      const successCriteria = parseTextList(raw.successCriteria, 1, MAX_SUCCESS_CRITERIA, MAX_CRITERION_LENGTH)
      const dependsOn = parseTextList(raw.dependsOn, 0, MAX_DEPENDENCIES, MAX_IDENTIFIER_LENGTH)
      if (!key || !templateId || !goal || !taskId || !successCriteria || !dependsOn
        || !Number.isSafeInteger(raw.depth) || Number(raw.depth) < 1 || Number(raw.depth) > MAX_DEPTH
        || new Set(dependsOn).size !== dependsOn.length || keys.has(key) || taskIds.has(taskId)) return null
      keys.add(key); taskIds.add(taskId)
      nodes.push({ key, templateId, goal, successCriteria, dependsOn, depth: Number(raw.depth), taskId })
    }
    if (nodes.some(node => node.dependsOn.some(key => !keys.has(key))) || !isAcyclic(nodes)) return null
    const serialized = JSON.stringify({ schemaVersion: TASK_GRAPH_SCHEMA_VERSION, nodes })
    if (serialized === undefined) return null
    const encoded = new TextEncoder().encode(serialized)
    return encoded.byteLength <= MAX_SNAPSHOT_BYTES ? { nodes } : null
  } catch { return null }
}

function parseTextList(value: unknown, minimum: number, maximum: number, maxTextLength: number): string[] | null {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return null
  const values = value as unknown[]
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== value.length + 1) return null
  const result: string[] = []
  for (const ownKey of ownKeys) {
    if (ownKey === 'length') continue
    if (typeof ownKey !== 'string') return null
    const index = Number(ownKey)
    if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== ownKey) return null
    const text = boundedText(values[index], maxTextLength)
    if (!text) return null
    result.push(text)
  }
  return result
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

function boundedText(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum ? value : null
}
