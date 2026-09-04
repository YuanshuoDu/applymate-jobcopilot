export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type ScriptedAt = number | { readonly timeMs: number }

export type ScriptedModelEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_call"; readonly callId: string; readonly name: string; readonly input: JsonValue }
  | { readonly type: "approval_request"; readonly approvalId: string; readonly action: string }
  | { readonly type: "final"; readonly text: string }
  | { readonly type: "unknown_event"; readonly name: string; readonly payload: JsonValue }
  | { readonly type: "unknown_type"; readonly name: string; readonly payload: JsonValue }
  | { readonly type: "v1_banner"; readonly text: string }

export type ScriptedModelStep = {
  readonly at: ScriptedAt
  readonly event: ScriptedModelEvent
}

export type FaultPoint =
  | "network_drop"
  | "abort"
  | "partial_turn"
  | "duplicate_event"
  | "lease_expired"
  | "idempotency_race"
  | "tool_timeout"
  | "quota_exceeded"

export type HarnessStatus =
  | "ready"
  | "working"
  | "waiting_for_approval"
  | "reconnected"
  | "completed"
  | "interrupted"
  | "failed"
  | "empty_session"

export type HarnessMessage = {
  readonly role: "user" | "assistant" | "system"
  readonly text: string
}

export type HarnessState = {
  readonly sessionId: string
  readonly turnId: string | null
  readonly status: HarnessStatus
  readonly turnCount: number
  readonly eventSequence: number
  readonly lastEventId: string | null
  readonly messages: readonly HarnessMessage[]
  readonly finalResponse: string | null
  readonly errorCode: string | null
  readonly externalWrites: number
  readonly unknownEvents: number
  readonly unknownTypes: number
}

export type HarnessEvent = {
  readonly id: string
  readonly sequence: number
  readonly type: string
  readonly at: string
  readonly payload: JsonValue
}
