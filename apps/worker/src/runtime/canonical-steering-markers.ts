import {
  reduceSteeringMarkers,
  STEERING_MARKER_EVENT_TYPE,
  type SteeringMarkerEvent,
  type SteeringMarkerState,
} from "./context/steering-marker.js"

type Row = Record<string, unknown>
export type PriorHistoryEntry = { readonly id: string; readonly content: unknown; readonly sequence: bigint | null }
type PriorInputDisposition = "not_consumed" | "cancelled" | "rejected"
export type CanonicalSteeringMarkerScope = {
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
  readonly rootTaskId?: string | null
}

export type { SteeringMarkerState }

const EVENT_KEYS = ["id", "type", "actor", "userId", "sessionId", "turnId", "taskId", "sequence", "payload"] as const

function object(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Row : null
}

export function textContent(value: unknown): string | null {
  const row = object(value) ?? {}
  for (const key of ["content", "text", "body", "goal"] as const) {
    if (typeof row[key] === "string" && row[key].trim()) return row[key].trim()
  }
  const partsSource = Array.isArray(value) ? value : row.parts
  if (!Array.isArray(partsSource)) return null
  const parts = partsSource.flatMap(part => {
    const item = object(part)
    return item?.type === "text" && typeof item.text === "string" ? [item.text] : []
  })
  return parts.length > 0 ? parts.join("\n").trim() : null
}

function ownValue(row: Row, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, key)
  return descriptor && descriptor.enumerable && "value" in descriptor ? descriptor.value : undefined
}

function ownString(row: Row, key: string): string | null {
  const value = ownValue(row, key)
  return typeof value === "string" ? value : null
}

function ownConsumedStepId(row: Row): string | null {
  const value = ownValue(row, "consumedByStepId")
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) ? value : null
}

function ownNull(row: Row, key: string): boolean {
  return ownValue(row, key) === null
}

function ownDate(row: Row, key: string): Date | null {
  const value = ownValue(row, key)
  if (!(value instanceof Date)) return null
  try {
    return Number.isFinite(Date.prototype.getTime.call(value)) ? value : null
  } catch {
    return null
  }
}

function lifecycleMarkersAreNull(row: Row): boolean {
  return ownNull(row, "consumedByStepId") && ownNull(row, "consumedAt") && ownNull(row, "cancelledAt")
}

function priorInputDisposition(row: Row): { readonly valid: boolean; readonly value?: PriorInputDisposition } {
  const delivery = ownString(row, "delivery")
  const status = ownString(row, "status")
  if ((delivery !== "steer" && delivery !== "follow_up") || !status) return { valid: false }
  if (status === "accepted" || status === "queued") {
    if (delivery === "follow_up" || !lifecycleMarkersAreNull(row)) return { valid: false }
    return { valid: true, value: "not_consumed" }
  }
  if (status === "consumed") {
    if (!ownConsumedStepId(row) || !ownDate(row, "consumedAt") || !ownNull(row, "cancelledAt")) return { valid: false }
    return { valid: true }
  }
  if (status === "cancelled") {
    const consumed = ownConsumedStepId(row)
    const consumedAt = ownDate(row, "consumedAt")
    const neverConsumed = ownNull(row, "consumedByStepId") && ownNull(row, "consumedAt")
    if (delivery !== "follow_up" || !ownDate(row, "cancelledAt") || !(neverConsumed || consumed && consumedAt)) return { valid: false }
    return { valid: true, value: "cancelled" }
  }
  if (status === "rejected") {
    if (!lifecycleMarkersAreNull(row)) return { valid: false }
    return { valid: true, value: "rejected" }
  }
  return { valid: false }
}

export function priorConversation(rows: readonly Row[], currentTurnId: string, throughSequence: bigint | null): PriorHistoryEntry[] {
  return rows.flatMap(row => {
    const id = typeof row.id === "string" ? row.id : null
    const turnId = typeof row.turnId === "string" ? row.turnId : row.targetTurnId
    const text = textContent(row.content)
    let sequence: bigint | null = null
    try {
      if (row.historySequence !== undefined && row.historySequence !== null) sequence = BigInt(String(row.historySequence))
      else if (row.acceptedSequence !== undefined && row.acceptedSequence !== null) sequence = BigInt(String(row.acceptedSequence))
    } catch { return [] }
    if (throughSequence !== null && sequence !== null && sequence <= throughSequence) return []
    const role = row.historyRole === "assistant" ? "assistant" : "user"
    if (!id || turnId === currentTurnId || !text) return []
    if (role === "assistant") return [{ id: `history:${role}:${id}`, content: { role, text }, sequence }]
    const disposition = priorInputDisposition(row)
    if (!disposition.valid) return []
    const content = disposition.value ? { role, text, priorInputDisposition: disposition.value } : { role, text }
    return [{ id: `history:${role}:${id}`, content, sequence }]
  })
}

function exactKeys(value: Row): boolean {
  if (Object.keys(value).length !== EVENT_KEYS.length) return false
  const expected = new Set<string>(EVENT_KEYS)
  return Object.keys(value).every(key => expected.has(key))
}

export class CanonicalSteeringMarkerError extends Error {
  readonly code = "steering_marker_state_invalid"
  readonly reason: string

  constructor(reason: string) {
    super("steering_marker_state_invalid")
    this.name = "CanonicalSteeringMarkerError"
    this.reason = reason
  }
}

export function emptySteeringMarkerState(): SteeringMarkerState {
  return { observed: [], applied: [], active: [] }
}

function invalid(reason: string): never {
  throw new CanonicalSteeringMarkerError(reason)
}

export function restoreCanonicalSteeringMarkers(
  rows: readonly unknown[],
  scope: CanonicalSteeringMarkerScope,
): SteeringMarkerState {
  if (scope.rootTaskId === undefined || scope.rootTaskId === null) return emptySteeringMarkerState()
  if (typeof scope.rootTaskId !== "string" || scope.rootTaskId.length === 0 || scope.rootTaskId.trim() !== scope.rootTaskId) return invalid("invalid_root_task")
  if (!Array.isArray(rows)) return invalid("invalid_rows")
  const events: SteeringMarkerEvent[] = []
  for (const raw of rows) {
    const row = object(raw)
    if (!row || row.type !== STEERING_MARKER_EVENT_TYPE) continue
    if (!exactKeys(row)) return invalid("invalid_event_envelope")
    events.push({
      id: row.id as string,
      type: STEERING_MARKER_EVENT_TYPE,
      actor: row.actor as "system",
      userId: row.userId as string,
      sessionId: row.sessionId as string,
      turnId: row.turnId as string,
      taskId: row.taskId as string,
      sequence: row.sequence as string | number | bigint,
      payload: row.payload,
    })
  }
  const reduced = reduceSteeringMarkers(events, {
    userId: scope.userId,
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    taskId: scope.rootTaskId,
  })
  return reduced.valid ? reduced.state : invalid(reduced.reason)
}
