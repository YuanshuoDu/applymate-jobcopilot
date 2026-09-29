import {
  AGENT_STREAM_SCHEMA_VERSION,
  parseTaskGraphSnapshot,
  TASK_GRAPH_MAX_IDENTIFIER_LENGTH,
  TASK_GRAPH_SCHEMA_VERSION,
  type TaskGraphSnapshot,
} from '@jobcopilot/agent-protocol'
import { redactSensitiveText, redactSensitiveValue } from '@jobcopilot/shared'

const TASK_GRAPH_PROPOSAL_KEYS = ['kind', 'fingerprint', 'receipt', 'revision', 'item'] as const
const TASK_GRAPH_PROPOSAL_CONTENT_KEYS = [...TASK_GRAPH_PROPOSAL_KEYS, 'content'] as const
const TASK_GRAPH_LIFECYCLE_KEYS = ['kind', 'event', 'revision', 'item'] as const
const TASK_GRAPH_ITEM_KEYS = [
  'schemaVersion', 'id', 'sessionId', 'turnId', 'stepId', 'taskId', 'type', 'status', 'phase', 'revision',
  'content', 'startedAt', 'completedAt', 'createdAt', 'updatedAt',
] as const
// Worker task IDs use root-${turnId} for leased roots and subagent-${randomUUID()} otherwise.
const SUBAGENT_TASK_ID = /^subagent-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

type StreamItemIdentity = Readonly<{
  sessionId: string
  turnId: string
  itemId: string | null
  taskId: string | null
}>
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
  const item = (payload as Record<string, unknown>).item as Record<string, unknown>
  const generatedTaskIds = isGeneratedRootTaskId(item.taskId, item.turnId)
    && snapshot.nodes.every(node => SUBAGENT_TASK_ID.test(node.taskId))
  // Noncanonical IDs may still be shown only when the ordinary redactor leaves them unchanged.
  if (!generatedTaskIds && [item.taskId, ...snapshot.nodes.map(node => node.taskId)]
    .some(taskId => typeof taskId !== 'string' || redactSensitiveText(taskId) !== taskId)) return redacted

  return {
    ...redacted,
    item: {
      ...redacted.item,
      id: identity.itemId,
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      ...(generatedTaskIds ? { taskId: item.taskId } : {}),
      content: redactTaskGraphSnapshot(snapshot, generatedTaskIds),
    },
  }
}

function taskGraphSnapshotFromEvent(eventType: string, payload: unknown, identity: StreamItemIdentity): TaskGraphSnapshot | null {
  if (!isRecord(payload) || !identity.itemId || !identity.taskId) return null
  const proposal = payload.kind === 'proposal' && (isExactRecord(payload, TASK_GRAPH_PROPOSAL_KEYS)
    || (eventType === 'item.delta' && isExactRecord(payload, TASK_GRAPH_PROPOSAL_CONTENT_KEYS)))
  const lifecycle = eventType === 'item.delta' && payload.kind === 'lifecycle' && isExactRecord(payload, TASK_GRAPH_LIFECYCLE_KEYS)
  if ((!proposal && !lifecycle) || !Number.isSafeInteger(payload.revision) || !isExactRecord(payload.item, TASK_GRAPH_ITEM_KEYS)) return null
  const item = payload.item
  if (item.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION || item.id !== identity.itemId || item.sessionId !== identity.sessionId
    || item.turnId !== identity.turnId || !boundedText(item.taskId, TASK_GRAPH_MAX_IDENTIFIER_LENGTH)
    || item.type !== 'task_graph' || item.revision !== payload.revision) return null
  const snapshot = parseTaskGraphSnapshot(item.content)
  if (!snapshot) return null
  if (proposal) return item.taskId === identity.taskId ? snapshot : null

  const event = payload.event
  if (!isRecord(event) || !Object.hasOwn(event, 'nodeKey') || typeof event.nodeKey !== 'string') return null
  const node = snapshot.nodes.find(candidate => candidate.key === event.nodeKey)
  return node?.taskId === identity.taskId ? snapshot : null
}

function redactTaskGraphSnapshot(snapshot: TaskGraphSnapshot, preserveGeneratedTaskIds: boolean): Record<string, unknown> {
  return {
    schemaVersion: redactSensitiveText(TASK_GRAPH_SCHEMA_VERSION),
    nodes: snapshot.nodes.map(node => ({
      key: redactSensitiveText(node.key),
      templateId: redactSensitiveText(node.templateId),
      goal: redactSensitiveText(node.goal),
      successCriteria: node.successCriteria.map(redactSensitiveText),
      dependsOn: node.dependsOn.map(redactSensitiveText),
      depth: node.depth,
      taskId: preserveGeneratedTaskIds ? node.taskId : redactSensitiveText(node.taskId),
    })),
  }
}

function isGeneratedRootTaskId(taskId: unknown, turnId: unknown): boolean {
  const boundedTaskId = boundedText(taskId, TASK_GRAPH_MAX_IDENTIFIER_LENGTH)
  const boundedTurnId = boundedText(turnId, TASK_GRAPH_MAX_IDENTIFIER_LENGTH)
  if (boundedTaskId === null) return false
  if (SUBAGENT_TASK_ID.test(boundedTaskId)) return true
  return boundedTurnId !== null && boundedTaskId === `root-${boundedTurnId}`
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

function boundedText(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum ? value : null
}
