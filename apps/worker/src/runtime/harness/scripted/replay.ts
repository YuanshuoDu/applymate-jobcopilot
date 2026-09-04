import type { HarnessEvent, HarnessMessage, HarnessState, JsonValue } from "./types.js"
import type { HarnessTrace } from "./trace.js"

export function replayHarnessTrace(trace: HarnessTrace): HarnessState {
  const state: MutableState = {
    sessionId: trace.finalState.sessionId,
    turnId: null,
    status: "ready",
    turnCount: 0,
    eventSequence: 0,
    lastEventId: null,
    messages: [],
    finalResponse: null,
    errorCode: null,
    externalWrites: 0,
    unknownEvents: 0,
    unknownTypes: 0,
  }

  for (const event of trace.events) applyEvent(state, event)
  return { ...state, messages: state.messages.map(message => ({ ...message })) }
}

type MutableState = {
  sessionId: string
  turnId: string | null
  status: HarnessState["status"]
  turnCount: number
  eventSequence: number
  lastEventId: string | null
  messages: HarnessMessage[]
  finalResponse: string | null
  errorCode: string | null
  externalWrites: number
  unknownEvents: number
  unknownTypes: number
}

function applyEvent(state: MutableState, event: HarnessEvent): void {
  state.eventSequence = event.sequence
  state.lastEventId = event.id
  const payload = objectPayload(event.payload)
  if (event.type === "turn.started") {
    state.turnId = stringValue(payload.turnId)
    state.turnCount += 1
    state.status = "working"
    state.errorCode = null
    state.finalResponse = null
    return
  }
  if (event.type === "message.appended") {
    const role = payload.role
    const text = payload.text
    if ((role === "user" || role === "assistant" || role === "system") && typeof text === "string") state.messages.push({ role, text })
    return
  }
  if (event.type === "approval.requested") { state.status = "waiting_for_approval"; return }
  if (event.type === "approval.resolved") {
    const decision = payload.decision
    state.status = decision === "approved" ? "completed" : "interrupted"
    state.finalResponse = decision === "approved" ? stringValue(payload.response) : null
    return
  }
  if (event.type === "stream.reconnected") { state.status = "reconnected"; return }
  if (event.type === "turn.final") {
    state.status = "completed"
    state.finalResponse = stringValue(payload.text)
    return
  }
  if (event.type === "turn.interrupted") { state.status = "interrupted"; state.errorCode = stringValue(payload.code); return }
  if (event.type === "turn.failed") { state.status = "failed"; state.errorCode = stringValue(payload.code); return }
  if (event.type === "protocol.unknown_event") { state.unknownEvents += 1; return }
  if (event.type === "protocol.unknown_type") { state.unknownTypes += 1; return }
  if (event.type === "turn.completed") {
    const status = payload.status
    if (isStatus(status)) state.status = status
    state.errorCode = payload.errorCode === null ? null : stringValue(payload.errorCode)
    state.finalResponse = payload.finalResponse === null ? null : stringValue(payload.finalResponse)
    state.turnId = stringValue(payload.turnId) ?? state.turnId
  }
}

function objectPayload(payload: JsonValue): Record<string, JsonValue> {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {}
}

function stringValue(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null
}

function isStatus(value: JsonValue | undefined): value is HarnessState["status"] {
  return value === "ready" || value === "working" || value === "waiting_for_approval" || value === "reconnected" || value === "completed" || value === "interrupted" || value === "failed" || value === "empty_session"
}
