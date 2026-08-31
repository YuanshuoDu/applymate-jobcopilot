export const AGENT_TURN_WAKEUP_TOPIC = "agent.turn.wakeup"

export type WaitKind = "approval" | "question"
export type WaitOutcome = "approved" | "rejected" | "answered"

export interface AgentTurnWakeupPayload {
  eventId: string
  sessionId: string
  turnId: string
  itemId: string
  waitKind: WaitKind
  waitId: string
  toolCallId: string | null
  status: WaitOutcome
  nextTurnRevision: number
}

export interface WakeupResult {
  status: "resumed" | "already_resumed" | "ignored"
  sessionId: string
  turnId: string
  itemId: string
  toolCallId: string | null
}

export function parseWakeup(value: unknown): AgentTurnWakeupPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
    ? row.payload as Record<string, unknown>
    : null
  if (!payload || row.type !== "turn.wakeup") return null
  if (typeof row.eventId !== "string" || typeof row.sessionId !== "string" || typeof row.turnId !== "string") return null
  if (typeof row.itemId !== "string" || typeof payload.itemId !== "string" || payload.itemId !== row.itemId) return null
  if (payload.waitKind !== "approval" && payload.waitKind !== "question") return null
  if (typeof payload.waitId !== "string" || typeof payload.nextTurnRevision !== "number" || !Number.isSafeInteger(payload.nextTurnRevision)) return null
  if (payload.status !== "approved" && payload.status !== "rejected" && payload.status !== "answered") return null
  if (payload.toolCallId !== null && typeof payload.toolCallId !== "string") return null
  return {
    eventId: row.eventId,
    sessionId: row.sessionId,
    turnId: row.turnId,
    itemId: row.itemId,
    waitKind: payload.waitKind,
    waitId: payload.waitId,
    toolCallId: payload.toolCallId as string | null,
    status: payload.status,
    nextTurnRevision: payload.nextTurnRevision,
  }
}
