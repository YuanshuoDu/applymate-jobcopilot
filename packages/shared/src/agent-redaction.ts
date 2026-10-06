import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"

const SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|private[_-]?key|credential|token|nonce|email|phone|address|linkedin|github|resume|cv|raw[_-]?(?:content|text|data)|content|value|question|answer|draft|sensitive|confirmed[_-]?answers|\bname\b)/i
const SENSITIVE_TOKEN = /\bBearer\s+[a-z0-9._~+/=-]{8,}/gi
const SENSITIVE_KEY_TOKEN = /\b(?:sk[-_]|gh[pousr]_|github_pat_|xox[baprs]-)[a-z0-9._~+/=-]{8,}/gi
const SENSITIVE_EMAIL = /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi
const SENSITIVE_PHONE = /(?<!\w)(?:\+?\d[\d\s().-]{7,}\d)(?!\w)/g
const SENSITIVE_ASSIGNMENT = /\b(password|secret|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi
const EVENT_SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|private[_-]?key|credential|token|nonce|email|phone|address|linkedin|github|(?:full[_-]?)?resume(?:[_-]?(?:text|content|data))?|cv(?:[_-]?(?:text|content|data))?|raw[_-]?(?:content|text|data)|content|value|question|answer|sensitive|confirmed[_-]?answers)/i
const EVENT_SAFE_KEY = new Set(["approvalid", "draft", "id", "receiptnonce", "scopehash"])
const UUID_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const HASH_ID = /^[0-9a-f]{32,64}$/i
const PREFIXED_ID = /^[a-z][a-z0-9._:-]{0,63}[_:.-][a-z0-9][a-z0-9._:-]{0,191}$/i
const CUID_ID = /^c[a-z0-9]{23,31}$/i
const SECRET_ID = /^(?:bearer\b|sk[-_]|xox[baprs]-|gh[pousr]_|github_pat_|ghs_|glpat-|AIza|ya29\.|secret[_:-]|password[_:-]|api[_-]?key[_:-]|token[_:-])|(?:password|secret|token|api[_-]?key)=/i
const STABLE_ID_COMPONENT = /(^|[:._-])([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{32,64})(?=$|[:._-])/gi

type WaitKind = "approval" | "question"
type RoutingTuple = {
  sessionId: string; turnId: string; itemId: string | null; taskId: string | null
  actor: string; correlationId: string; causationId: string | null; outboxTopic: string
}
type JsonRecord = Record<string, unknown>

/** Trusted only when supplied by a server writer or recovered from a complete canonical event envelope. */
export type AgentEventRoutingContext = RoutingTuple

function record(value: unknown): JsonRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as JsonRecord : null
}

function opaqueId(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256 || value.trim() !== value || SECRET_ID.test(value)) return false
  const stable = UUID_ID.test(value) || HASH_ID.test(value) || CUID_ID.test(value)
    || /(?:^|[:._-])[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
    || /(?:^|[:._-])[0-9a-f]{32,64}$/i.test(value)
  return (stable || PREFIXED_ID.test(value)) && (stable || redactSensitiveText(value) === value)
}

function nullableId(value: unknown): value is string | null { return value === null || opaqueId(value) }
function validIdempotencyKey(value: unknown): boolean {
  return value === null || typeof value === "string" && value.length > 0 && value.length <= 256
}

function safeMetadataId(value: string): boolean {
  const scrubbed = value.replace(STABLE_ID_COMPONENT, "$1opaque")
  return value.length <= 256 && value.trim() === value && !SECRET_ID.test(scrubbed)
    && (UUID_ID.test(value) || HASH_ID.test(value) || CUID_ID.test(value) || PREFIXED_ID.test(value))
    && redactSensitiveText(scrubbed) === scrubbed
}

function safeWaitIdempotencyKey(type: string, value: unknown, route: RoutingTuple): value is string {
  if (typeof value !== "string" || !validIdempotencyKey(value)) return false
  const scrubbed = value.replace(STABLE_ID_COMPONENT, "$1opaque")
  if (SECRET_ID.test(scrubbed) || redactSensitiveText(scrubbed) !== scrubbed) return false
  if (type === "item.started") {
    const item = route.itemId?.match(/^agent-wait:(question|approval):(.+)$/)
    return Boolean(item && safeMetadataId(item[2]!) && value === `agent-wait:${route.itemId}:started`)
  }
  const prefix = "agent-wait-command:"
  if (!value.startsWith(prefix)) return false
  const suffix = type === "turn.wakeup" ? ":wakeup" : ""
  if (suffix && !value.endsWith(suffix)) return false
  if (!suffix && type !== "question.answered" && type !== "approval.resolved") return false
  const messageId = value.slice(prefix.length, suffix ? -suffix.length : undefined)
  return safeMetadataId(messageId)
}

function validSequence(value: unknown): boolean {
  return value === null || typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    || typeof value === "string" && /^(0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
}

function validRouting(value: unknown): value is RoutingTuple {
  const row = record(value)
  return !!row && opaqueId(row.sessionId) && opaqueId(row.turnId) && nullableId(row.itemId) && nullableId(row.taskId)
    && (row.actor === "user" || row.actor === "orchestrator" || row.actor === "system")
    && opaqueId(row.correlationId) && nullableId(row.causationId)
    && (row.outboxTopic === "agent.session.event" || row.outboxTopic === "agent.turn.wakeup")
}

function fullEnvelope(type: string, value: unknown): { row: JsonRecord; routing: RoutingTuple } | null {
  const row = record(value)
  if (!row || row.schemaVersion !== "agent-harness.v2" || row.type !== type || !opaqueId(row.id) || !opaqueId(row.sessionId) || !opaqueId(row.turnId)
    || !nullableId(row.itemId) || !nullableId(row.taskId) || !opaqueId(row.correlationId)
    || !nullableId(row.causationId) || !validIdempotencyKey(row.idempotencyKey) || !record(row.payload)) return null
  if (!validSequence(row.sequence) || (row.createdAt !== undefined && !validTimestamp(row.createdAt))) return null
  const outboxTopic = type === "turn.wakeup" ? "agent.turn.wakeup" : "agent.session.event"
  const routing = { sessionId: row.sessionId, turnId: row.turnId, itemId: row.itemId, taskId: row.taskId,
    actor: row.actor, correlationId: row.correlationId, causationId: row.causationId, outboxTopic }
  return validRouting(routing) && waitPayloadFields(type, row.payload as JsonRecord, routing) ? { row, routing } : null
}

function waitKind(value: unknown): value is WaitKind { return value === "approval" || value === "question" }
function answerFlagMatches(payload: JsonRecord, kind: WaitKind): boolean {
  return payload.answerAvailable === undefined || payload.answerAvailable === "[REDACTED]"
    || payload.answerAvailable === (kind === "question")
}

function waitPayloadFields(type: string, payload: JsonRecord, route: RoutingTuple): string[] | null {
  if (type === "approval.resolved" && payload.waitKind === undefined) {
    const approvalId = payload.approvalId
    const action = payload.action
    return opaqueId(approvalId) && approvalId === route.correlationId && route.itemId === null
      && route.outboxTopic === "agent.session.event" && (route.actor === "user" || route.actor === "system")
      && typeof action === "string" && /^[a-z][a-z0-9_]{0,63}$/i.test(action)
      && Number.isSafeInteger(payload.revision) && (payload.revision as number) >= 0 ? ["approvalId"] : null
  }
  const kind = payload.waitKind
  const idKey = kind === "question" ? "questionId" : "approvalId"
  const waitId = type === "item.started" ? payload[idKey] : payload.waitId
  if (!waitKind(kind) || !opaqueId(waitId)) return null
  const itemId = `agent-wait:${kind}:${waitId}`
  const toolCallId = payload.toolCallId
  if (!nullableId(toolCallId) || route.itemId !== itemId || payload.itemId !== itemId) return null
  if (payload.sessionId !== undefined && payload.sessionId !== route.sessionId) return null
  if (type === "item.started") {
    return route.actor === "orchestrator" && route.outboxTopic === "agent.session.event"
      && route.correlationId === itemId && route.causationId === waitId ? ["itemId", idKey, "toolCallId"] : null
  }
  if (type === "question.answered" || type === "approval.resolved") {
    if ((type === "question.answered" && kind !== "question") || (type === "approval.resolved" && kind !== "approval")) return null
    const statusValid = kind === "question" ? payload.status === "answered"
      : payload.status === "approved" || payload.status === "rejected"
    return route.actor === "user" && route.outboxTopic === "agent.session.event"
      && route.correlationId === waitId && route.causationId === itemId && payload.turnId === route.turnId
      && statusValid && Number.isSafeInteger(payload.nextTurnRevision) && (payload.nextTurnRevision as number) >= 1
      && answerFlagMatches(payload, kind)
      ? ["sessionId", "waitId", "itemId", "turnId", "toolCallId"] : null
  }
  if (type !== "turn.wakeup" || route.actor !== "user" || route.outboxTopic !== "agent.turn.wakeup"
    || route.correlationId !== route.turnId || !opaqueId(route.causationId) || payload.turnId !== route.turnId
    || (kind === "question" ? payload.status !== "answered" : payload.status !== "approved" && payload.status !== "rejected")
    || !Number.isSafeInteger(payload.nextTurnRevision) || (payload.nextTurnRevision as number) < 1
    || !answerFlagMatches(payload, kind)) return null
  return ["sessionId", "waitId", "itemId", "turnId", "toolCallId"]
}

function preserveFields(safe: unknown, raw: JsonRecord, fields: readonly string[]): RepositoryJsonValue {
  const output = record(safe)
  if (!output) return safe as RepositoryJsonValue
  const result = { ...output } as Record<string, RepositoryJsonValue>
  for (const field of fields) {
    const value = raw[field]
    if (value === null) result[field] = null
    else if (opaqueId(value)) result[field] = value
  }
  return result
}

function redactWaitRouting(type: string, raw: unknown, safe: RepositoryJsonValue, route: RoutingTuple): RepositoryJsonValue {
  const payload = record(raw)
  if (!payload) return safe
  const fields = waitPayloadFields(type, payload, route)
  const preserved = fields ? preserveFields(safe, payload, fields) : safe
  if (fields && type === "question.answered" && payload.answerAvailable === true) {
    const output = record(preserved)
    if (output) return { ...output, answerAvailable: true }
  }
  return preserved
}

function preserveEnvelope(type: string, raw: JsonRecord, safe: RepositoryJsonValue, route: RoutingTuple): RepositoryJsonValue {
  const payload = record(raw.payload)
  const safeEnvelope = record(safe)
  if (!payload || !safeEnvelope) return safe
  const nested = redactWaitRouting(type, payload, safeEnvelope.payload as RepositoryJsonValue, route)
  const envelope = preserveFields({ ...safeEnvelope, payload: nested }, raw,
    ["id", "sessionId", "turnId", "itemId", "taskId", "correlationId", "causationId"])
  const result = record(envelope)
  if (result && raw.idempotencyKey === null) result.idempotencyKey = null
  else if (result && safeWaitIdempotencyKey(type, raw.idempotencyKey, route)) result.idempotencyKey = raw.idempotencyKey
  if (result && typeof raw.sequence === "string" && validSequence(raw.sequence)) result.sequence = raw.sequence
  if (result && validTimestamp(raw.createdAt)) result.createdAt = raw.createdAt
  return envelope
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(SENSITIVE_TOKEN, "Bearer [REDACTED]")
    .replace(SENSITIVE_KEY_TOKEN, "[REDACTED]")
    .replace(SENSITIVE_EMAIL, "[REDACTED_EMAIL]")
    .replace(SENSITIVE_PHONE, "[REDACTED_PHONE]")
    .replace(SENSITIVE_ASSIGNMENT, "$1=[REDACTED]")
}

export function redactSensitiveValue(value: unknown, key: string | null = null, depth = 0, maxDepth = 8): RepositoryJsonValue {
  if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]"
  if (typeof value === "string") return redactSensitiveText(value)
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : "[REDACTED]"
  if (depth >= maxDepth) return "[REDACTED]"
  if (Array.isArray(value)) return value.map((entry) => redactSensitiveValue(entry, null, depth + 1, maxDepth))
  if (typeof value !== "object" || value === undefined) return "[REDACTED]"
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
    entryKey,
    redactSensitiveValue(entryValue, entryKey, depth + 1, maxDepth),
  ]))
}

export function redactAgentEvent(input: { type: string; body: string; data?: unknown; routing?: AgentEventRoutingContext }): { body: string; data: RepositoryJsonValue | null } {
  const envelope = input.routing ? null : fullEnvelope(input.type, input.data)
  const route = input.routing && validRouting(input.routing) ? input.routing : envelope?.routing
  const safe = input.data === undefined ? null : redactEventValue(input.data)
  const data = route && input.data !== undefined
    ? input.routing
      ? redactWaitRouting(input.type, input.data, safe, route)
      : envelope ? preserveEnvelope(input.type, envelope.row, safe, route) : safe
    : safe
  return {
    body: redactSensitiveText(input.body),
    data,
  }
}

/**
 * Event payloads retain safe product structure such as automation drafts and
 * job titles, while still removing credentials, answer fields, raw resumes,
 * and direct contact data. Lifecycle/tool payloads use the stricter generic
 * redactor above because they are not rendered back into the user transcript.
 */
function redactEventValue(value: unknown, key: string | null = null, depth = 0, maxDepth = 8, insideResume = false): RepositoryJsonValue {
  const resumeContainer = insideResume || key === "resume" || key === "cv"
  const safeKey = key ? EVENT_SAFE_KEY.has(key.toLowerCase()) : false
  if (key && !safeKey && EVENT_SENSITIVE_KEY.test(key) && key !== "resume" && key !== "cv") return "[REDACTED]"
  if (insideResume && key === "content") return "[REDACTED]"
  if (typeof value === "string") return redactSensitiveText(value)
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : "[REDACTED]"
  if (depth >= maxDepth) return "[REDACTED]"
  if (Array.isArray(value)) return value.map((entry) => redactEventValue(entry, null, depth + 1, maxDepth, resumeContainer))
  if (typeof value !== "object" || value === undefined) return "[REDACTED]"
  const entries: Array<[string, RepositoryJsonValue]> = []
  for (const [entryKey, entryValue] of Object.entries(value)) {
    // Undefined means the optional field was not supplied. Omitting it keeps
    // reconnect clients on the receipt-rotation path instead of fabricating a
    // truthy redaction marker that looks like a usable nonce.
    if (entryValue === undefined) continue
    entries.push([entryKey, redactEventValue(entryValue, entryKey, depth + 1, maxDepth, resumeContainer)])
  }
  return Object.fromEntries(entries)
}
