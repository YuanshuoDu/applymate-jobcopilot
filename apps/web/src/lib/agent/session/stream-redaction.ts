import {
  AGENT_STREAM_SCHEMA_VERSION,
  parseTaskGraphSnapshot,
  TASK_GRAPH_MAX_IDENTIFIER_LENGTH,
  TASK_GRAPH_SCHEMA_VERSION,
  type TaskGraphSnapshot,
} from '@jobcopilot/agent-protocol'
import { redactSensitiveText, redactSensitiveValue } from '@jobcopilot/shared'
import { projectFinalAnswerContent } from './final-answer-evidence-projection'
import { isCanonicalTaskGraphSourceManifest } from './final-task-graph-source-detail'
import { parseFinalTaskGraphSourceManifest } from './final-task-graph-source-manifest'

const TASK_GRAPH_PROPOSAL_KEYS = ['kind', 'fingerprint', 'receipt', 'revision', 'item'] as const
const TASK_GRAPH_PROPOSAL_CONTENT_KEYS = [...TASK_GRAPH_PROPOSAL_KEYS, 'content'] as const
const TASK_GRAPH_LIFECYCLE_KEYS = ['kind', 'event', 'revision', 'item'] as const
// Terminal hydration and its item API currently accept IDs up to 256 characters.
const MAX_TERMINAL_ID_LENGTH = 256
// Mirror the shared structural-ID credential check; some prefixes are not handled by redactSensitiveText.
const ID_CREDENTIAL_PREFIX = /(?<![a-z0-9])(?:bearer\b|sk[-_]|xox[baprs]-|gh[pousr]_|github_pat_|ghs_|secret[_:-]|password[_:-]|api[_-]?key[_:-]|token[_:-])|(?:password|secret|token|api[_-]?key)=/i
const EMBEDDED_ID_CREDENTIAL_MARKER = /(?:glpat-|AIza|ya29\.)/i
const EMBEDDED_ID_CREDENTIAL_TOKEN = /(?:Bearer\s+|(?:sk[-_]|gh[pousr]_|github_pat_|xox[baprs]-))[a-z0-9._~+/=-]{8,}/i
const UUID_V4_COMPONENT = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu
// Capture any non-ASCII-alphanumeric delimiter and preserve it during equal-length UUID masking.
const UUID_V4_COMPONENTS = /(^|[^A-Za-z0-9])([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?=$|[^A-Za-z0-9])/giu
const STABLE_ID_COMPONENT = /(^|[:._-])([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{32,64})(?=$|[:._-])/gi
const PHONE_SHAPED_UNDERSCORE_ID_COMPONENT = /_(\+?[\d\s().-]*\d)(?=$|[_:.-])/g
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

export function isPrivateNativeVerificationEventType(type: string): boolean {
  return type.startsWith('native_verification.')
}

export function redactStreamEventPayload(eventType: string, payload: unknown, identity: StreamItemIdentity): unknown {
  if (isPrivateNativeVerificationEventType(eventType)) return {}
  const finalContent = projectCompletedFinalContent(eventType, payload, identity)
  if (finalContent) return finalContent
  const redacted = redactStreamValue(payload)
  if (eventType === 'turn.completed') return projectCompletedTurnIdentity(payload, redacted, identity)
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

function projectCompletedTurnIdentity(payload: unknown, redacted: unknown, identity: StreamItemIdentity): unknown {
  if (!isRecord(redacted)) return redacted
  const output = { ...redacted }
  for (const key of ['turnId', 'taskId', 'finalItemId'] as const) delete output[key]
  if (!isRecord(payload)) return output

  const turnId = payload.turnId, taskId = payload.taskId, finalItemId = payload.finalItemId
  if (!isSafeTerminalIdentity(turnId) || !isSafeTerminalIdentity(taskId) || !isSafeTerminalIdentity(finalItemId)) return output
  if (turnId !== identity.turnId || taskId !== identity.taskId || finalItemId !== identity.itemId) return output

  if (![turnId, taskId, finalItemId].every(isSafeTerminalIdentityContent)) return output
  output.turnId = turnId
  output.taskId = taskId
  output.finalItemId = finalItemId
  return output
}

function isSafeTerminalIdentityContent(value: string): boolean {
  if (ID_CREDENTIAL_PREFIX.test(value) || EMBEDDED_ID_CREDENTIAL_MARKER.test(value) || EMBEDDED_ID_CREDENTIAL_TOKEN.test(value)
    || hasPhoneShapedUnderscoreIdComponent(value) || hasUnseparatedUuidComponent(value)) return false
  const safeText = value.replace(UUID_V4_COMPONENTS, (_match, separator: string, component: string) => `${separator}${'a'.repeat(component.length)}`)
  return redactSensitiveText(safeText) === safeText
}

function hasUnseparatedUuidComponent(value: string): boolean {
  return Array.from(value.matchAll(UUID_V4_COMPONENT)).some(match => {
    const start = match.index ?? 0, end = start + match[0].length
    return !isIdentityDelimiter(value[start - 1]) || !isIdentityDelimiter(value[end])
  })
}

function isIdentityDelimiter(value: string | undefined): boolean {
  return value === undefined || !/[A-Za-z0-9]/u.test(value)
}

function hasPhoneShapedUnderscoreIdComponent(value: string): boolean {
  const withoutStableId = value.replace(STABLE_ID_COMPONENT, '$1opaque')
  return Array.from(withoutStableId.matchAll(PHONE_SHAPED_UNDERSCORE_ID_COMPONENT))
    .some(([, component]) => !!component && component.replace(/\D/g, '').length >= 10)
}

function isSafeTerminalIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TERMINAL_ID_LENGTH
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)
}

function projectCompletedFinalContent(eventType: string, payload: unknown, identity: StreamItemIdentity): unknown | null {
  if (eventType !== 'item.completed' || !identity.itemId || !isExactRecord(payload, ['itemId', 'status', 'content'])
    || payload.itemId !== identity.itemId || payload.status !== 'completed' || !isRecord(payload.content)) return null
  const rawContent = payload.content
  const text = ownDataValue(rawContent, 'text'), final = ownDataValue(rawContent, 'final')
  const content = projectFinalAnswerContent({ text, final })
  if (!content) {
    if (!Object.hasOwn(rawContent, 'taskGraphSources')) return null
    return { itemId: identity.itemId, status: 'completed', content: { text: typeof text === 'string' ? redactSensitiveText(text) : '' } }
  }
  const manifest = parseFinalTaskGraphSourceManifest(ownDataValue(rawContent, 'taskGraphSources'))
  const taskGraphSources = manifest && isCanonicalTaskGraphSourceManifest(identity.itemId, manifest) ? manifest : undefined
  return { itemId: identity.itemId, status: 'completed', content: { ...content, ...(taskGraphSources ? { taskGraphSources } : {}) } }
}

function ownDataValue(value: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
  } catch { return undefined }
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
