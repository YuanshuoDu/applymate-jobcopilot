import {
  reduceSteeringMarkers,
  STEERING_MARKER_EVENT_TYPE,
  type SteeringMarkerEvent,
  type SteeringMarkerState,
} from "./context/steering-marker.js"

type Row = Record<string, unknown>
export type PriorHistoryEntry = { readonly id: string; readonly content: unknown; readonly sequence: bigint | null }
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
    return id && turnId !== currentTurnId && text ? [{ id: `history:${role}:${id}`, content: { role, text }, sequence }] : []
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
