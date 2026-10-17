type RoutingTuple = {
  sessionId: string; turnId: string; itemId: string | null; taskId: string | null
  actor: string; correlationId: string; causationId: string | null; outboxTopic: string
}
type JsonRecord = Record<string, unknown>

export type AgentEventRoutingContext = RoutingTuple

function nullableId(value: unknown, opaqueId: (value: unknown) => value is string): value is string | null {
  return value === null || opaqueId(value)
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length && ownKeys.every(key => typeof key === "string" && keys.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"))
}

function waitKind(value: unknown): value is "approval" | "question" { return value === "approval" || value === "question" }
function answerFlagMatches(payload: JsonRecord, kind: "approval" | "question"): boolean {
  return payload.answerAvailable === undefined || payload.answerAvailable === "[REDACTED]"
    || payload.answerAvailable === (kind === "question")
}

/** Returns only references validated against a complete, trusted event route. */
export function knownAgentEventPayloadFields(
  type: string,
  payload: JsonRecord,
  route: RoutingTuple,
  opaqueId: (value: unknown) => value is string,
): string[] | null {
  if (type === "task.interrupt.accepted") {
    return exactKeys(payload, ["intentId", "taskId", "status"]) && opaqueId(payload.intentId) && opaqueId(payload.taskId)
      && payload.taskId === route.taskId && route.taskId !== null && route.itemId === null
      && route.actor === "user" && route.correlationId === route.turnId && route.causationId === null
      && route.outboxTopic === "agent.session.event" && payload.status === "accepted" ? ["intentId", "taskId"] : null
  }
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
  if (!nullableId(toolCallId, opaqueId) || route.itemId !== itemId || payload.itemId !== itemId) return null
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
