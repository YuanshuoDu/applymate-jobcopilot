export const AGENT_TURN_WAKEUP_TOPIC = "agent.turn.wakeup"

export type WaitKind = "approval" | "question" | "approval_set"
export type WaitOutcome = "approved" | "rejected" | "answered" | "resolved"

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
  status: "resumed" | "already_resumed" | "ignored" | "deferred"
  sessionId: string
  turnId: string
  itemId: string
  toolCallId: string | null
}

function exactPlainKeys(value: unknown, keys: readonly string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  try {
    const ownKeys = Reflect.ownKeys(value)
    if ((Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) || ownKeys.length !== keys.length) return false
    return ownKeys.every(key => typeof key === "string" && keys.includes(key)
      && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"))
  } catch { return false }
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
  if (payload.waitKind !== "approval" && payload.waitKind !== "question" && payload.waitKind !== "approval_set") return null
  if (payload.waitKind === "approval_set" && !exactPlainKeys(payload, ["waitKind", "waitId", "itemId", "turnId", "toolCallId", "status", "nextTurnRevision"])) return null
  if (typeof payload.waitId !== "string" || typeof payload.nextTurnRevision !== "number" || !Number.isSafeInteger(payload.nextTurnRevision)) return null
  if (payload.toolCallId !== null && typeof payload.toolCallId !== "string") return null
  const validOutcome = payload.waitKind === "approval_set"
    ? payload.status === "resolved" && payload.toolCallId === null
    : payload.status === "approved" || payload.status === "rejected" || payload.status === "answered"
  if (!validOutcome) return null
  return {
    eventId: row.eventId,
    sessionId: row.sessionId,
    turnId: row.turnId,
    itemId: row.itemId,
    waitKind: payload.waitKind,
    waitId: payload.waitId,
    toolCallId: payload.toolCallId as string | null,
    status: payload.status as WaitOutcome,
    nextTurnRevision: payload.nextTurnRevision,
  }
}
