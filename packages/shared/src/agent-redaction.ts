import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import type { AgentEventRoutingContext } from "./agent-event-routing"
import {
  hasExactRootAcceptedEnvelope,
  isLegacyApprovalReference as isLegacyApprovalReferenceWithGuards,
  legacyApprovalClientReceipt as legacyApprovalClientReceiptWithGuards,
  validFollowUpPayload as validFollowUpPayloadWithGuards,
  validLegacyApprovalRequested as validLegacyApprovalRequestedWithGuards,
  validLegacyApprovalResponse as validLegacyApprovalResponseWithGuards,
  validQuestionSourceEnvelope as validQuestionSourceEnvelopeWithGuards,
  validStoredApprovalRequested as validStoredApprovalRequestedWithGuards,
  validatedPayloadFields as validatedPayloadFieldsWithGuards,
  type AgentEventPayloadGuards,
} from "./agent-redaction-event-payloads"
export type { AgentEventRoutingContext } from "./agent-event-routing"
const SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|private[_-]?key|credential|token|nonce|email|phone|address|linkedin|github|resume|cv|raw[_-]?(?:content|text|data)|content|value|question|answer|draft|sensitive|confirmed[_-]?answers|\bname\b)/i
const SENSITIVE_TOKEN = /\bBearer\s+[a-z0-9._~+/=-]{8,}/gi
const SENSITIVE_KEY_TOKEN = /(?<![a-z0-9])(?:sk[-_]|gh[pousr]_|github_pat_|xox[baprs]-)[a-z0-9._~+/=-]{8,}/gi
const SENSITIVE_EMAIL = /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi
const SENSITIVE_PHONE = /(?<!\w)(?:\+?\d[\d\s().-]{7,}\d)(?!\w)/g
const SENSITIVE_ASSIGNMENT = /\b(password|secret|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi
const EVENT_SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|private[_-]?key|credential|token|nonce|email|phone|address|linkedin|github|(?:full[_-]?)?resume(?:[_-]?(?:text|content|data))?|cv(?:[_-]?(?:text|content|data))?|raw[_-]?(?:content|text|data)|content|value|question|answer|sensitive|confirmed[_-]?answers)/i
const EVENT_SAFE_KEY = new Set(["approvalid", "draft", "id", "receiptnonce", "scopehash"])
const STRUCTURAL_ID_KEY = new Set(["approvalid", "causationid", "correlationid", "id", "intentid", "itemid", "messageid", "questionid", "sessionid", "taskid", "toolcallid", "turnid", "waitid"])
const AGENT_EVENT_SCHEMA_VERSION = "agent-harness.v2"
const AGENT_EVENT_SCHEMA_NAMESPACE = "agent-harness."
const AGENT_EVENT_ENVELOPE_ANCHORS = ["actor", "causationId", "correlationId", "createdAt", "id", "idempotencyKey", "itemId", "sequence", "sessionId", "taskId", "turnId", "type"]
const AGENT_EVENT_DISTINCTIVE_ANCHORS = ["actor", "causationId", "correlationId", "idempotencyKey", "itemId", "payload", "sequence"]
const AGENT_ITEM_RECORD_KEYS = new Set(["schemaVersion", "id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "completedAt", "createdAt", "updatedAt"])
const AGENT_EVENT_ENVELOPE_CORE_IDENTITY = ["id", "sessionId", "turnId", "type"]
const AGENT_EVENT_TYPE = /^[a-z][a-z0-9_-]*\.[a-z0-9._-]+$/i
const EVENT_REDACTION_MAX_DEPTH = 8
const UUID_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const HASH_ID = /^[0-9a-f]{32,64}$/i
const PREFIXED_ID = /^[a-z][a-z0-9._:-]{0,63}[_:.-][a-z0-9][a-z0-9._:-]{0,191}$/i
const CUID_ID = /^c[a-z0-9]{23,31}$/i
const PHONE_SHAPED_UNDERSCORE_ID_COMPONENT = /_(\+?[\d\s().-]*\d)(?=$|[_:.-])/g
const SECRET_ID = /(?:^|[:._-])(?:bearer\b|sk[-_]|xox[baprs]-|gh[pousr]_|github_pat_|ghs_|glpat-|AIza|ya29\.|secret[_:-]|password[_:-]|api[_-]?key[_:-]|token[_:-])|(?:password|secret|token|api[_-]?key)=/i
const STABLE_ID_COMPONENT = /(^|[:._-])([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{32,64})(?=$|[:._-])/gi
type RoutingTuple = AgentEventRoutingContext; type JsonRecord = Record<string, unknown>
function hasPhoneShapedUnderscoreIdComponent(value: string): boolean {
  return Array.from(value.replace(STABLE_ID_COMPONENT, "$1opaque").matchAll(PHONE_SHAPED_UNDERSCORE_ID_COMPONENT)).some(([, component]) => !!component && component.replace(/\D/g, "").length >= 10)
}
function record(value: unknown): JsonRecord | null { if (value === null || typeof value !== "object" || Array.isArray(value)) return null; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null ? value as JsonRecord : null }
function opaqueId(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256 || value.trim() !== value || SECRET_ID.test(value) || hasPhoneShapedUnderscoreIdComponent(value)) return false
  const stable = UUID_ID.test(value) || HASH_ID.test(value) || CUID_ID.test(value)
    || /(?:^|[:._-])[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
    || /(?:^|[:._-])[0-9a-f]{32,64}$/i.test(value)
  const withoutStableId = value.replace(STABLE_ID_COMPONENT, "$1opaque")
  return (stable || PREFIXED_ID.test(value)) && redactSensitiveText(withoutStableId) === withoutStableId
}
function stableOpaqueId(value: unknown): value is string { return opaqueId(value) && (UUID_ID.test(value) || HASH_ID.test(value) || CUID_ID.test(value)) }
function nullableId(value: unknown): value is string | null { return value === null || opaqueId(value) }
function validIdempotencyKey(value: unknown): boolean { return value === null || typeof value === "string" && value.length > 0 && value.length <= 256 }
function safeMetadataId(value: string): boolean {
  const scrubbed = value.replace(STABLE_ID_COMPONENT, "$1opaque")
  return value.length <= 256 && value.trim() === value && !SECRET_ID.test(scrubbed) && !hasPhoneShapedUnderscoreIdComponent(value)
    && (UUID_ID.test(value) || HASH_ID.test(value) || CUID_ID.test(value) || PREFIXED_ID.test(value)) && redactSensitiveText(scrubbed) === scrubbed
}
function safeWaitIdempotencyKey(type: string, value: unknown, route: RoutingTuple): value is string {
  if (typeof value !== "string" || !validIdempotencyKey(value)) return false
  const scrubbed = value.replace(STABLE_ID_COMPONENT, "$1opaque")
  if (SECRET_ID.test(scrubbed) || redactSensitiveText(scrubbed) !== scrubbed) return false
  if (type === "item.started") {
    const item = route.itemId?.match(/^agent-wait:(question|approval):(.+)$/)
    return Boolean(item && safeMetadataId(item[2]!) && value === `agent-wait:${route.itemId}:started`)
  }
  if (type === "task.interrupt.accepted") {
    const prefix = `agent-task-interrupt-accepted:${route.sessionId}:`
    return value.startsWith(prefix) && safeMetadataId(value.slice(prefix.length))
  }
  const prefix = "agent-wait-command:"
  if (!value.startsWith(prefix)) return false
  const suffix = type === "turn.wakeup" ? ":wakeup" : ""
  if (suffix && !value.endsWith(suffix)) return false
  if (!suffix && type !== "question.answered" && type !== "approval.resolved") return false
  const messageId = value.slice(prefix.length, suffix ? -suffix.length : undefined)
  return safeMetadataId(messageId)
}
function validSequence(value: unknown): boolean { return value === null || typeof value === "number" && Number.isSafeInteger(value) && value >= 0 || typeof value === "string" && /^(0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n }
function validTimestamp(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) }
function nullableTimestamp(value: unknown): boolean { return value === null || validTimestamp(value) }
function jsonValue(value: unknown, depth = 0): value is RepositoryJsonValue {
  if (depth > EVENT_REDACTION_MAX_DEPTH) return false
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(entry => jsonValue(entry, depth + 1))
  const row = record(value)
  return !!row && Object.values(row).every(entry => jsonValue(entry, depth + 1))
}
function validRouting(value: unknown): value is RoutingTuple {
  const row = record(value)
  return !!row && opaqueId(row.sessionId) && opaqueId(row.turnId) && nullableId(row.itemId) && nullableId(row.taskId)
    && (row.actor === "user" || row.actor === "orchestrator" || row.actor === "system") && opaqueId(row.correlationId) && nullableId(row.causationId)
    && (row.outboxTopic === "agent.session.event" || row.outboxTopic === "agent.turn.wakeup")
}
function isNestedAgentItem(value: unknown, parentKey: string | undefined, route?: RoutingTuple): boolean {
  const row = record(value)
  if (!row || parentKey !== "item") return false
  const entries = Object.entries(row), keys = entries.map(([key]) => key), normalizedKeys = new Set(keys.map(key => key.toLowerCase()))
  const schemaVersions = entries.filter(([key]) => key.toLowerCase() === "schemaversion").map(([, version]) => version)
  const hasEventAnchor = AGENT_EVENT_DISTINCTIVE_ANCHORS.some(key => normalizedKeys.has(key.toLowerCase())), eventType = typeof row.type === "string" && AGENT_EVENT_TYPE.test(row.type)
  return keys.length === AGENT_ITEM_RECORD_KEYS.size && keys.every(key => AGENT_ITEM_RECORD_KEYS.has(key)) && schemaVersions.length === 1
    && schemaVersions[0] === AGENT_EVENT_SCHEMA_VERSION && !hasEventAnchor && !eventType && !!route
    && opaqueId(row.id) && opaqueId(row.sessionId) && opaqueId(row.turnId) && row.id === route.itemId
    && row.sessionId === route.sessionId && row.turnId === route.turnId && row.taskId === route.taskId && nullableId(row.stepId) && nullableId(row.taskId)
    && row.type === "user_message" && row.status === "completed" && row.phase === "commentary" && row.revision === 0
    && row.stepId === null && jsonValue(row.content) && nullableTimestamp(row.startedAt) && nullableTimestamp(row.completedAt)
    && validTimestamp(row.createdAt) && validTimestamp(row.updatedAt)
}
const payloadGuards: AgentEventPayloadGuards = { record, opaqueId, nullableId, validTimestamp, jsonValue, isNestedAgentItem }
const validFollowUpPayload = (type: string, value: unknown, route: RoutingTuple) => validFollowUpPayloadWithGuards(type, value, route, payloadGuards), validLegacyApprovalRequested = (type: string, value: unknown): value is JsonRecord => validLegacyApprovalRequestedWithGuards(type, value, payloadGuards)
const validStoredApprovalRequested = (type: string, value: unknown) => validStoredApprovalRequestedWithGuards(type, value, payloadGuards)
const validLegacyApprovalResponse = (type: string, value: unknown) => validLegacyApprovalResponseWithGuards(type, value, payloadGuards), validQuestionSourceEnvelope = (type: string, payload: JsonRecord, route: RoutingTuple) => validQuestionSourceEnvelopeWithGuards(type, payload, route, payloadGuards)
const validatedPayloadFields = (type: string, payload: JsonRecord, route: RoutingTuple) => validatedPayloadFieldsWithGuards(type, payload, route, payloadGuards), isLegacyApprovalReference = (value: unknown, key: string) => isLegacyApprovalReferenceWithGuards(value, key, payloadGuards)
const legacyApprovalClientReceipt = (value: unknown) => legacyApprovalClientReceiptWithGuards(value, payloadGuards)
function containsAgentEventEnvelopeShape(value: unknown, depth = 0, parentKey?: string, route?: RoutingTuple, legacyApprovalReceipt?: unknown): boolean {
  if (depth >= EVENT_REDACTION_MAX_DEPTH || value === null || typeof value !== "object") return false
  if (Array.isArray(value)) return value.some(entry => containsAgentEventEnvelopeShape(entry, depth + 1, parentKey, route, legacyApprovalReceipt))
  const row = record(value)
  if (!row) return false
  const entries = Object.entries(row)
  const keys = new Set(entries.map(([key]) => key.toLowerCase()))
  const hasEnvelopeAnchor = AGENT_EVENT_ENVELOPE_ANCHORS.some(key => keys.has(key.toLowerCase()))
  const hasEventAnchor = AGENT_EVENT_DISTINCTIVE_ANCHORS.some(key => keys.has(key.toLowerCase()))
  const eventType = typeof row.type === "string" && AGENT_EVENT_TYPE.test(row.type)
  const schemaVersions = entries.filter(([key]) => key.toLowerCase() === "schemaversion").map(([, version]) => version)
  const hasSchemaVersion = schemaVersions.length > 0
  const nestedAgentItem = isNestedAgentItem(row, parentKey, route)
  const ambiguousSchemaVersion = !nestedAgentItem && schemaVersions.length > 1 && (hasEventAnchor || eventType)
  const versionedAgentEnvelope = !nestedAgentItem && schemaVersions.some(version => typeof version === "string"
    && version.toLowerCase().startsWith(AGENT_EVENT_SCHEMA_NAMESPACE))
  const malformedVersionedEnvelope = !nestedAgentItem && hasSchemaVersion && schemaVersions.some(version => typeof version !== "string")
    && (hasEventAnchor || eventType)
  const unversionedPartialEnvelope = !hasSchemaVersion && keys.has("payload") && hasEnvelopeAnchor
  const envelopeShape = value !== legacyApprovalReceipt && (versionedAgentEnvelope || malformedVersionedEnvelope || unversionedPartialEnvelope
    || ambiguousSchemaVersion || !hasSchemaVersion && AGENT_EVENT_ENVELOPE_CORE_IDENTITY.every(key => keys.has(key.toLowerCase())))
  return envelopeShape || entries.some(([key, entry]) => containsAgentEventEnvelopeShape(entry, depth + 1, key, route, legacyApprovalReceipt))
}
function containsDuplicateSchemaVersion(value: unknown, depth = 0): boolean {
  if (depth >= EVENT_REDACTION_MAX_DEPTH || value === null || typeof value !== "object") return false
  if (Array.isArray(value)) return value.some(entry => containsDuplicateSchemaVersion(entry, depth + 1))
  const row = record(value)
  if (!row) return false
  const entries = Object.entries(row), count = entries.filter(([key]) => key.toLowerCase() === "schemaversion").length
  return count > 1 || entries.some(([, entry]) => containsDuplicateSchemaVersion(entry, depth + 1))
}
function fullEnvelope(type: string, value: unknown): { row: JsonRecord; routing: RoutingTuple } | null {
  const row = record(value); if (type === "input.accepted" && !hasExactRootAcceptedEnvelope(value, payloadGuards)) return null
  if (!row || containsDuplicateSchemaVersion(row) || row.schemaVersion !== AGENT_EVENT_SCHEMA_VERSION || row.type !== type || !opaqueId(row.id) || !opaqueId(row.sessionId) || !opaqueId(row.turnId)
    || !nullableId(row.itemId) || !nullableId(row.taskId) || !opaqueId(row.correlationId)
    || !nullableId(row.causationId) || !validIdempotencyKey(row.idempotencyKey) || !record(row.payload)) return null
  if (!validSequence(row.sequence) || (row.createdAt !== undefined && !validTimestamp(row.createdAt))) return null
  const outboxTopic = type === "turn.wakeup" ? "agent.turn.wakeup" : "agent.session.event"
  const routing = { sessionId: row.sessionId, turnId: row.turnId, itemId: row.itemId, taskId: row.taskId,
    actor: row.actor, correlationId: row.correlationId, causationId: row.causationId, outboxTopic }
  return validRouting(routing) && (validatedPayloadFields(type, row.payload as JsonRecord, routing)
    || validQuestionSourceEnvelope(type, row.payload as JsonRecord, routing)) ? { row, routing } : null
}
function preserveFields(safe: unknown, raw: JsonRecord, fields: readonly string[]): RepositoryJsonValue {
  const output = record(safe)
  if (!output) return safe as RepositoryJsonValue
  const result = { ...output } as Record<string, RepositoryJsonValue>
  for (const field of fields) { const value = raw[field]; if (value === null || opaqueId(value)) result[field] = value }
  return result
}
function redactWaitRouting(type: string, raw: unknown, safe: RepositoryJsonValue, route: RoutingTuple): RepositoryJsonValue {
  const payload = record(raw)
  if (!payload) return safe
  const fields = validatedPayloadFields(type, payload, route)
  let preserved = fields ? preserveFields(safe, payload, fields) : safe
  if (validQuestionSourceEnvelope(type, payload, route)) {
    const output = record(preserved), rawSource = record(payload.sourcePayload), safeSource = record(output?.sourcePayload)
    if (output && rawSource && safeSource && opaqueId(rawSource.id))
      preserved = { ...output, sourcePayload: { ...safeSource, id: rawSource.id } }
  }
  if (fields && type === "question.answered" && payload.answerAvailable === true) {
    const output = record(preserved)
    if (output) return { ...output, answerAvailable: true }
  }
  return preserved
}
function preserveEnvelope(type: string, raw: JsonRecord, safe: RepositoryJsonValue, route: RoutingTuple): RepositoryJsonValue {
  const payload = record(raw.payload), safeEnvelope = record(safe)
  if (!payload || !safeEnvelope) return safe
  const nested = redactWaitRouting(type, payload, safeEnvelope.payload as RepositoryJsonValue, route), safePayload = record(nested), rawItem = record(payload.item), safeItem = record(safePayload?.item)
  const preservedPayload = type === "input.accepted" && validFollowUpPayload(type, payload, route)
    && safePayload && rawItem && safeItem && opaqueId(rawItem.taskId) && rawItem.taskId === route.taskId ? { ...safePayload, item: preserveFields(safeItem, rawItem, ["id", "sessionId", "turnId", "stepId", "taskId"]) } : nested
  const envelope = preserveFields({ ...safeEnvelope, payload: preservedPayload }, raw, ["id", "sessionId", "turnId", "itemId", "taskId", "correlationId", "causationId"])
  const result = record(envelope)
  if (result && raw.idempotencyKey === null) result.idempotencyKey = null
  else if (result && safeWaitIdempotencyKey(type, raw.idempotencyKey, route)) result.idempotencyKey = raw.idempotencyKey
  if (result && typeof raw.sequence === "string" && validSequence(raw.sequence)) result.sequence = raw.sequence
  if (result && validTimestamp(raw.createdAt)) result.createdAt = raw.createdAt
  return envelope
}
function preserveLegacyApprovalId(safe: unknown, receipt: JsonRecord): RepositoryJsonValue { const output = record(safe), approval = record(output?.approval); return output && approval ? { ...output, approval: preserveFields(approval, receipt, ["id"]) } : safe as RepositoryJsonValue }
export function redactSensitiveText(value: string): string {
  return value.replace(SENSITIVE_TOKEN, "Bearer [REDACTED]").replace(SENSITIVE_KEY_TOKEN, "[REDACTED]").replace(SENSITIVE_EMAIL, "[REDACTED_EMAIL]").replace(SENSITIVE_PHONE, "[REDACTED_PHONE]").replace(SENSITIVE_ASSIGNMENT, "$1=[REDACTED]")
}
export function redactSensitiveValue(value: unknown, key: string | null = null, depth = 0, maxDepth = 8): RepositoryJsonValue {
  if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]"
  if (typeof value === "string") return redactSensitiveText(value)
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : "[REDACTED]"
  if (depth >= maxDepth) return "[REDACTED]"
  if (Array.isArray(value)) return value.map((entry) => redactSensitiveValue(entry, null, depth + 1, maxDepth))
  if (typeof value !== "object" || value === undefined) return "[REDACTED]"
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactSensitiveValue(entryValue, entryKey, depth + 1, maxDepth)]))
}
export function redactAgentEvent(input: { type: string; body: string; data?: unknown; routing?: AgentEventRoutingContext }): { body: string; data: RepositoryJsonValue | null } {
  const envelope = input.routing ? null : fullEnvelope(input.type, input.data)
  const route = input.routing && validRouting(input.routing) ? input.routing : envelope?.routing
  const legacyApprovalReceipt = !input.routing && input.type === "approval_request" ? legacyApprovalClientReceipt(input.data) : null; const hasEventEnvelopeShape = containsAgentEventEnvelopeShape(input.data, 0, undefined, route, legacyApprovalReceipt)
  const preserveFollowUpMessageId = route !== undefined && validFollowUpPayload(input.type, input.data, route)
  const legacyApprovalPayload = !input.routing && !hasEventEnvelopeShape && (validLegacyApprovalRequested(input.type, input.data) || validStoredApprovalRequested(input.type, input.data) || validLegacyApprovalResponse(input.type, input.data))
  const safe = input.data === undefined ? null : redactEventValue(input.data, null, 0, EVENT_REDACTION_MAX_DEPTH, false, false, !hasEventEnvelopeShape, route, false, preserveFollowUpMessageId, !input.routing && !hasEventEnvelopeShape && input.type === "automation_draft")
  let data = route && input.data !== undefined ? input.routing ? redactWaitRouting(input.type, input.data, safe, route) : envelope ? preserveEnvelope(input.type, envelope.row, safe, route) : safe : safe; if (legacyApprovalReceipt && !hasEventEnvelopeShape) data = preserveLegacyApprovalId(data, legacyApprovalReceipt)
  if (legacyApprovalPayload) data = preserveFields(data, input.data as JsonRecord, ["approvalId"])
  return { body: redactSensitiveText(input.body), data }
}
/** Keep user-facing event structure while removing credentials, answers, resumes, and contact data. */
function redactEventValue(value: unknown, key: string | null = null, depth = 0, maxDepth = EVENT_REDACTION_MAX_DEPTH, insideResume = false, allowStructuralIds = true, allowNestedAgentItems = true, route?: RoutingTuple, preserveItemStepId = false, preserveFollowUpMessageId = false, preserveLegacyAutomationApproval = false): RepositoryJsonValue {
  const resumeContainer = insideResume || key === "resume" || key === "cv"
  const normalizedKey = key?.toLowerCase()
  const structuralIdKey = normalizedKey !== undefined && (STRUCTURAL_ID_KEY.has(normalizedKey) || normalizedKey === "stepid")
  const structuralId = typeof value === "string" && (structuralIdKey && allowStructuralIds
    && (normalizedKey === "questionid" ? stableOpaqueId(value) : normalizedKey === "stepid" ? preserveItemStepId && opaqueId(value) : opaqueId(value))
    || key === "messageId" && preserveFollowUpMessageId && opaqueId(value))
  if (structuralIdKey && value !== null && !structuralId) return "[REDACTED]"
  const safeKey = normalizedKey ? EVENT_SAFE_KEY.has(normalizedKey) : false
  if (key && !safeKey && !structuralId && EVENT_SENSITIVE_KEY.test(key) && key !== "resume" && key !== "cv") return "[REDACTED]"
  if (insideResume && key === "content") return "[REDACTED]"
  if (typeof value === "string") return structuralId ? value : redactSensitiveText(value)
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : "[REDACTED]"
  if (depth >= maxDepth) return "[REDACTED]"
  if (Array.isArray(value)) return value.map((entry) => redactEventValue(entry, null, depth + 1, maxDepth, resumeContainer, allowStructuralIds, allowNestedAgentItems, route, preserveItemStepId, preserveFollowUpMessageId, preserveLegacyAutomationApproval))
  if (typeof value !== "object" || value === undefined) return "[REDACTED]"
  const entries: Array<[string, RepositoryJsonValue]> = []
  for (const [entryKey, entryValue] of Object.entries(value)) {
    // Omit absent fields so reconnect clients rotate receipts instead of seeing a false redaction marker.
    if (entryValue === undefined) continue
    const preserveItemIds = allowNestedAgentItems && isNestedAgentItem(entryValue, entryKey, route) || preserveLegacyAutomationApproval && depth === 0 && isLegacyApprovalReference(entryValue, entryKey)
    const preserveStepId = preserveItemIds || preserveItemStepId && entryKey === "stepId"
    entries.push([entryKey, redactEventValue(entryValue, entryKey, depth + 1, maxDepth, resumeContainer, allowStructuralIds || preserveItemIds, allowNestedAgentItems, route, preserveStepId, preserveFollowUpMessageId && entryKey === "messageId", preserveLegacyAutomationApproval)])
  }
  return Object.fromEntries(entries)
}
