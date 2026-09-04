import { assertTraceContext, type TraceContext } from "./trace-context"

export const HARNESS_EVENT_TYPES = [
  "session.started",
  "session.completed",
  "turn.queued",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.recovered",
  "tool.invoked",
  "tool.completed",
  "tool.failed",
  "approval.requested",
  "approval.granted",
  "approval.denied",
  "approval.expired",
  "artifact.created",
  "artifact.updated",
  "submission.attempted",
  "submission.completed",
  "submission.failed",
  "cost.charged",
  "queue.depth",
] as const

export type HarnessEventType = (typeof HARNESS_EVENT_TYPES)[number]

/**
 * The payload is intentionally a closed, scalar-only shape. User content,
 * addresses, network identifiers, and arbitrary nested metadata have no type
 * representation and therefore cannot be emitted through the normal factory.
 */
export interface HarnessEventPayload {
  status?: "started" | "completed" | "failed" | "queued" | "recovered" | "requested" | "granted" | "denied" | "expired" | "attempted"
  toolName?: string
  model?: string
  operation?: string
  errorCode?: string
  latencyMs?: number
  queueDepth?: number
  inputTokens?: number
  outputTokens?: number
  costMicros?: number
  recoveryCount?: number
  artifactId?: string
  submissionId?: string
  approvalScopeHash?: string
  metricName?: string
  metricValue?: number
}

export interface HarnessEvent<T extends HarnessEventType = HarnessEventType> {
  eventId: string
  eventType: T
  occurredAt: string
  traceId: string
  spanId: string
  parentSpanId: string | null
  sessionId: string
  turnId?: string
  /** Opaque internal subject identifier; never an email or display name. */
  userId?: string
  payload: HarnessEventPayload
}

export interface CreateHarnessEventInput<T extends HarnessEventType> {
  eventType: T
  trace: TraceContext
  sessionId: string
  turnId?: string
  userId?: string
  occurredAt?: Date | string
  eventId?: string
  payload?: HarnessEventPayload
  idFactory?: () => string
}

const PAYLOAD_KEYS = new Set<keyof HarnessEventPayload>([
  "status", "toolName", "model", "operation", "errorCode", "latencyMs",
  "queueDepth", "inputTokens", "outputTokens", "costMicros", "recoveryCount",
  "artifactId", "submissionId", "approvalScopeHash", "metricName", "metricValue",
])

const EVENT_TYPE_SET = new Set<string>(HARNESS_EVENT_TYPES)
const FORBIDDEN_KEY = /(?:email|e-mail|text|prompt|content|ip|address|phone|name|resume|coverletter|raw)/i
const SECRET_TOKEN_KEY = /(?:auth|access|refresh)[_-]?token/i
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const IPV4_VALUE = /^(?:\d{1,3}\.){3}\d{1,3}$/u

function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be non-empty`)
  return value
}

function validateNumber(value: number, key: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be a finite non-negative number`)
}

/** Runtime guard for callers crossing an untyped Worker/Web boundary. */
export function assertSafeEventPayload(payload: unknown): asserts payload is HarnessEventPayload {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("event payload must be a plain object")
  const prototype = Object.getPrototypeOf(payload)
  if (prototype !== Object.prototype && prototype !== null) throw new Error("event payload must be a plain object")
  for (const [key, value] of Object.entries(payload)) {
    if (FORBIDDEN_KEY.test(key) || SECRET_TOKEN_KEY.test(key) || key === "token" || !PAYLOAD_KEYS.has(key as keyof HarnessEventPayload)) throw new Error(`unsupported or sensitive event payload key: ${key}`)
    if (typeof value === "number") validateNumber(value, key)
    else if (typeof value !== "string") throw new Error(`event payload value for ${key} must be a string or number`)
    else if (EMAIL_VALUE.test(value) || IPV4_VALUE.test(value)) throw new Error(`event payload value for ${key} looks like PII`)
  }
}

function isoDate(value: Date | string | undefined): string {
  const date = value instanceof Date ? value : new Date(value ?? Date.now())
  if (Number.isNaN(date.getTime())) throw new Error("occurredAt must be a valid date")
  return date.toISOString()
}

export function createHarnessEvent<T extends HarnessEventType>(input: CreateHarnessEventInput<T>): HarnessEvent<T> {
  if (!EVENT_TYPE_SET.has(input.eventType)) throw new Error(`unsupported Harness event type: ${String(input.eventType)}`)
  requireNonEmpty(input.sessionId, "sessionId")
  if (input.turnId !== undefined) requireNonEmpty(input.turnId, "turnId")
  if (input.userId !== undefined) requireNonEmpty(input.userId, "userId")
  assertSafeEventPayload(input.payload ?? {})
  assertTraceContext(input.trace)
  const idFactory = input.idFactory ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
  return {
    eventId: requireNonEmpty(input.eventId ?? idFactory(), "eventId"),
    eventType: input.eventType,
    occurredAt: isoDate(input.occurredAt),
    traceId: input.trace.traceId,
    spanId: input.trace.spanId,
    parentSpanId: input.trace.parentSpanId,
    sessionId: input.sessionId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
    payload: { ...(input.payload ?? {}) },
  }
}
