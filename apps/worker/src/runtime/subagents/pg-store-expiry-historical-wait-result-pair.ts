import { canonicalJson } from "@jobcopilot/shared"

type Event = Readonly<Record<string, unknown>>
type Pair = Readonly<{ started: Event; completed: Event; extra?: Event }>

export type WaitResultPairDiagnostic = Readonly<{
  eventCount: number
  startedKeyMatches: number
  completedKeyMatches: number
  otherKeyMatches: number
  partitionValid: boolean
  canonicalPairValid: boolean
  eventIdsValid: boolean
  startedIdentity: boolean
  completedIdentity: boolean
  startedPayload: boolean
  completedPayload: boolean
  startedCausation: boolean
  completedCausation: boolean
  numericOrder: boolean
}>

const boundedCount = (value: number) => Math.min(Math.max(value, 0), 4)
const MAX_PERSISTED_EVENT_ID_LENGTH = 1024
function sequence(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null
  try { return BigInt(value) } catch { return null }
}
function boundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PERSISTED_EVENT_ID_LENGTH && value.trim() === value
}
function sameJson(left: unknown, right: unknown): boolean {
  try { return canonicalJson(left) === canonicalJson(right) } catch { return false }
}

/** Exact production result-event filter; keep the bounded descendant query shared with diagnostics. */
export const CHILD_WAIT_RESULT_EVENTS_QUERY_SQL = `SELECT "id", "type", "actor", "itemId", "correlationId", "causationId", "sequence", "idempotencyKey", "payload" FROM "agent_events"
  WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND ("itemId" = $4 OR "correlationId" = $4 OR "idempotencyKey" = ANY($5::text[])
    OR "causationId" IN (SELECT anchor."id" FROM "agent_events" AS anchor WHERE anchor."sessionId" = $1 AND anchor."turnId" = $2 AND anchor."taskId" = $3 AND anchor."idempotencyKey" = ANY($5::text[]))) ORDER BY "sequence" LIMIT 4`

export function partitionWaitResultEvents(rows: readonly Event[], keys: readonly string[]): Pair | null {
  if (keys.length !== 2 || rows.length < 2 || rows.length > 3) return null
  const started = rows.filter(row => row.idempotencyKey === keys[0]), completed = rows.filter(row => row.idempotencyKey === keys[1])
  const extra = rows.filter(row => row.idempotencyKey !== keys[0] && row.idempotencyKey !== keys[1])
  return started.length === 1 && completed.length === 1 && extra.length <= 1
    ? { started: started[0]!, completed: completed[0]!, ...(extra[0] ? { extra: extra[0] } : {}) } : null
}

function eventIdsValid(terminal: Event, started: Event, completed: Event): boolean {
  return boundedString(terminal.id) && boundedString(started.id) && boundedString(completed.id) && started.id !== completed.id
}
function startedIdentityValid(started: Event, resultItemId: string, stepId: string): boolean {
  return started.type === "item.started" && started.actor === "subagent" && started.itemId === resultItemId && started.correlationId === stepId
}
function completedIdentityValid(completed: Event, resultItemId: string): boolean {
  return completed.type === "item.completed" && completed.actor === "subagent"
    && completed.itemId === resultItemId && completed.correlationId === resultItemId
}
function startedPayloadValid(started: Event, resultItemId: string): boolean {
  return sameJson(started.payload, { itemId: resultItemId, type: "tool_result", phase: null })
}
function completedPayloadValid(completed: Event, resultItemId: string, content: Record<string, unknown>): boolean {
  return sameJson(completed.payload, { itemId: resultItemId, status: "completed", content })
}
function startedCausationValid(terminal: Event, started: Event): boolean { return started.causationId === terminal.id }
function completedCausationValid(started: Event, completed: Event): boolean { return completed.causationId === started.id }
function numericOrderValid(terminal: Event, started: Event, completed: Event): boolean {
  const terminalAt = sequence(terminal.sequence), startAt = sequence(started.sequence), completeAt = sequence(completed.sequence)
  return Boolean(terminalAt && startAt && completeAt && terminalAt < startAt && startAt < completeAt)
}

export function isCanonicalWaitResultPair(terminal: Event, started: Event, completed: Event,
  resultItemId: string, stepId: string, content: Record<string, unknown>): boolean {
  return eventIdsValid(terminal, started, completed)
    && terminal.type === "tool_call.completed"
    && startedIdentityValid(started, resultItemId, stepId)
    && startedCausationValid(terminal, started)
    && startedPayloadValid(started, resultItemId)
    && completedIdentityValid(completed, resultItemId)
    && completedCausationValid(started, completed)
    && completedPayloadValid(completed, resultItemId, content)
    && numericOrderValid(terminal, started, completed)
}

/** Failure-only summary: counts are capped and no persisted value is returned. */
export function diagnoseWaitResultPair(rows: readonly Event[], keys: readonly string[], terminal: Event,
  resultItemId: string, stepId: string, content: Record<string, unknown>): WaitResultPairDiagnostic {
  const startedRows = rows.filter(row => row.idempotencyKey === keys[0])
  const completedRows = rows.filter(row => row.idempotencyKey === keys[1])
  const otherRows = rows.filter(row => row.idempotencyKey !== keys[0] && row.idempotencyKey !== keys[1])
  const pair = partitionWaitResultEvents(rows, keys)
  const started = startedRows.length === 1 ? startedRows[0]! : {}
  const completed = completedRows.length === 1 ? completedRows[0]! : {}
  const eventIds = eventIdsValid(terminal, started, completed)
  const startedIdentity = startedIdentityValid(started, resultItemId, stepId)
  const completedIdentity = completedIdentityValid(completed, resultItemId)
  const startedPayload = startedPayloadValid(started, resultItemId)
  const completedPayload = completedPayloadValid(completed, resultItemId, content)
  const startedCausation = startedCausationValid(terminal, started)
  const completedCausation = completedCausationValid(started, completed)
  const numericOrder = numericOrderValid(terminal, started, completed)
  const diagnostic: WaitResultPairDiagnostic = {
    eventCount: boundedCount(rows.length), startedKeyMatches: boundedCount(startedRows.length),
    completedKeyMatches: boundedCount(completedRows.length), otherKeyMatches: boundedCount(otherRows.length),
    partitionValid: pair !== null, canonicalPairValid: isCanonicalWaitResultPair(terminal, started, completed, resultItemId, stepId, content),
    eventIdsValid: eventIds, startedIdentity, completedIdentity, startedPayload, completedPayload,
    startedCausation, completedCausation, numericOrder,
  }
  return diagnostic
}
