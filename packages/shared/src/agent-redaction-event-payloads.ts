import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { knownAgentEventPayloadFields, type AgentEventRoutingContext } from "./agent-event-routing"

type Row = Record<string, unknown>
type Route = AgentEventRoutingContext

export type AgentEventPayloadGuards = Readonly<{
  record(value: unknown): Row | null
  opaqueId(value: unknown): value is string
  nullableId(value: unknown): value is string | null
  validTimestamp(value: unknown): value is string
  jsonValue(value: unknown): value is RepositoryJsonValue
  isNestedAgentItem(value: unknown, parentKey: string | undefined, route?: Route): boolean
}>

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

function exactPayloadKeys(row: Row, keys: readonly string[]): boolean {
  const actual = Object.keys(row)
  return actual.length === keys.length && actual.every(key => keys.includes(key))
}

export function hasExactRootAcceptedEnvelope(value: unknown, guards: AgentEventPayloadGuards): boolean {
  const row = guards.record(value)
  return !!row && exactPayloadKeys(row, ["schemaVersion", "id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload", "createdAt"])
}

export function validRootAcceptedInputPayload(type: string, value: unknown, route: Route, guards: AgentEventPayloadGuards): boolean {
  const row = guards.record(value)
  const source = row?.source
  const actor = source === "user" ? "user" : source === "automation" || source === "system" ? "system" : null
  return type === "input.accepted" && !!row && exactPayloadKeys(row, ["inputId", "clientMessageId", "delivery", "source", "disposition"])
    && route.taskId === null && route.itemId !== null && UUID_V4.test(route.itemId) && guards.opaqueId(route.itemId)
    && route.correlationId === route.turnId && route.causationId === null && route.outboxTopic === "agent.session.event"
    && actor !== null && route.actor === actor && typeof row.inputId === "string" && UUID_V4.test(row.inputId) && guards.opaqueId(row.inputId)
    && typeof row.clientMessageId === "string" && row.clientMessageId.length > 0 && row.clientMessageId.length <= 256
    && (row.delivery === "steer" || row.delivery === "follow_up")
    && ["started", "steered", "queued_follow_up", "duplicate", "interrupted"].includes(String(row.disposition))
}

export function validFollowUpPayload(type: string, value: unknown, route: Route, guards: AgentEventPayloadGuards): boolean {
  const row = guards.record(value)
  return type === "input.accepted" && !!row && exactPayloadKeys(row, ["messageId", "clientMessageId", "delivery", "source", "disposition", "targetAttemptCount", "item"])
    && route.actor === "user" && route.outboxTopic === "agent.session.event" && route.correlationId === route.turnId && route.causationId === null
    && route.itemId !== null && route.taskId !== null && typeof row.messageId === "string" && UUID.test(row.messageId) && guards.opaqueId(row.messageId)
    && typeof row.clientMessageId === "string" && row.clientMessageId.length > 0 && row.clientMessageId.length <= 256
    && row.delivery === "follow_up" && row.source === "user" && row.disposition === "queued_follow_up"
    && Number.isSafeInteger(row.targetAttemptCount) && (row.targetAttemptCount as number) > 0 && guards.isNestedAgentItem(row.item, "item", route)
}

export function validLegacyApprovalRequested(type: string, payload: unknown, guards: AgentEventPayloadGuards): payload is Row {
  const row = guards.record(payload)
  return type === "approval.requested" && !!row && exactPayloadKeys(row, ["approvalId", "action", "scopeHash", "revision"]) && guards.opaqueId(row.approvalId)
    && typeof row.action === "string" && /^[a-z][a-z0-9_]{0,63}$/i.test(row.action) && typeof row.scopeHash === "string" && row.scopeHash.length > 0 && row.scopeHash.length <= 256
    && Number.isSafeInteger(row.revision) && (row.revision as number) >= 0
}

export function validStoredApprovalRequested(type: string, payload: unknown, guards: AgentEventPayloadGuards): boolean {
  const row = guards.record(payload), draft = guards.record(guards.record(payload)?.draft)
  return type === "approval.requested" && !!row && exactPayloadKeys(row, ["approvalId", "email", "resumeContent", "draft"]) && guards.opaqueId(row.approvalId)
    && typeof row.email === "string" && typeof row.resumeContent === "string" && !!draft && exactPayloadKeys(draft, ["name", "targetRoles"])
    && typeof draft.name === "string" && Array.isArray(draft.targetRoles) && draft.targetRoles.every(role => typeof role === "string")
}

export function validLegacyApprovalResponse(type: string, payload: unknown, guards: AgentEventPayloadGuards): boolean {
  const row = guards.record(payload)
  return type === "approval_response" && !!row && exactPayloadKeys(row, ["approvalId", "decision"]) && guards.opaqueId(row.approvalId)
    && ["approved", "rejected", "cancelled", "review"].includes(row.decision as string)
}

export function validQuestionSourceEnvelope(type: string, payload: Row, route: Route, guards: AgentEventPayloadGuards): boolean {
  const legacy = guards.record(payload.legacy), source = guards.record(payload.sourcePayload)
  return type === "item.started" && exactPayloadKeys(payload, ["legacy", "sourceEvent", "sourcePayload", "opaque"])
    && !!legacy && exactPayloadKeys(legacy, ["type", "speaker", "title", "body", "durationMs", "data"])
    && legacy.type === "approval_request" && payload.sourceEvent === "orchestrator_question" && payload.opaque === false
    && !!source && exactPayloadKeys(source, ["id", "stage", "question", "options"]) && guards.opaqueId(source.id)
    && source.id === route.causationId && typeof source.stage === "string" && !!source.stage
    && typeof source.question === "string" && !!source.question && Array.isArray(source.options)
    && route.actor === "orchestrator" && route.outboxTopic === "agent.session.event"
    && route.itemId === `agent-wait:question:${source.id}` && route.correlationId === route.itemId && route.causationId === source.id
}

export function validatedPayloadFields(type: string, payload: Row, route: Route, guards: AgentEventPayloadGuards): string[] | null {
  const known = knownAgentEventPayloadFields(type, payload, route, guards.opaqueId)
  if (known) return known
  if (validRootAcceptedInputPayload(type, payload, route, guards)) return ["inputId"]
  if (validFollowUpPayload(type, payload, route, guards)) return ["messageId"]
  if ((type === "session.pause_requested" || type === "session.resume_requested")
    && exactPayloadKeys(payload, ["turnId", "expectedRevision", "requestedAt"])
    && payload.turnId === route.turnId && Number.isSafeInteger(payload.expectedRevision) && (payload.expectedRevision as number) >= 0
    && guards.validTimestamp(payload.requestedAt) && route.itemId === null && route.taskId === null && route.actor === "user"
    && route.correlationId === route.turnId && route.causationId === null && route.outboxTopic === "agent.session.event") return ["turnId"]
  if (validLegacyApprovalRequested(type, payload, guards) && payload.approvalId === route.correlationId && route.actor === "orchestrator" && route.itemId === null
    && route.causationId === null && route.outboxTopic === "agent.session.event") return ["approvalId"]
  if (type === "approval.resolved" && exactPayloadKeys(payload, ["waitKind", "waitId", "itemId", "toolCallId", "outcome", "reason"])
    && payload.waitKind === "approval" && guards.opaqueId(payload.waitId) && payload.itemId === route.itemId
    && payload.itemId === `agent-wait:approval:${payload.waitId}` && guards.nullableId(payload.toolCallId)
    && payload.outcome === "cancelled" && payload.reason === "interrupt" && route.itemId !== null && route.taskId === null
    && route.actor === "system" && route.outboxTopic === "agent.session.event" && route.correlationId === payload.waitId
    && route.causationId !== null) return ["waitId", "itemId", "toolCallId"]
  return null
}

export function isLegacyApprovalReference(value: unknown, key: string, guards: AgentEventPayloadGuards): boolean {
  const row = guards.record(value)
  return key === "approval" && !!row && exactPayloadKeys(row, ["id", "receiptNonce", "scopeHash"]) && guards.opaqueId(row.id)
    && guards.opaqueId(row.receiptNonce) && typeof row.scopeHash === "string" && row.scopeHash.length > 0 && row.scopeHash.length <= 256
}

export function legacyApprovalClientReceipt(value: unknown, guards: AgentEventPayloadGuards): Row | null {
  const approval = guards.record(guards.record(value)?.approval)
  return approval && exactPayloadKeys(approval, ["id", "type", "title", "body", "impact", "payload", "status", "receiptNonce", "scopeHash"])
    && guards.opaqueId(approval.id) && guards.opaqueId(approval.receiptNonce) && ["type", "title", "body", "status"].every(key => typeof approval[key] === "string")
    && guards.jsonValue(approval) && typeof approval.scopeHash === "string" && approval.scopeHash.length > 0 && approval.scopeHash.length <= 256 ? approval : null
}
