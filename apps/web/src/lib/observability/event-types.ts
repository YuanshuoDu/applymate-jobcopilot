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
  entryPoint?: string
  harnessVersion?: string
  status?: "started" | "completed" | "failed" | "queued" | "recovered" | "requested" | "granted" | "denied" | "expired" | "attempted"
  durationMs?: number
  finalTurnCount?: number
  queueName?: string
  queueWaitMs?: number
  turnIndex?: number
  mode?: string
  stepCount?: number
  failureCode?: string
  retryable?: boolean
  recoveryCode?: string
  attempt?: number
  toolName?: string
  toolVersion?: string
  approvalRequired?: boolean
  approvalScope?: string
  expiresAt?: string
  decisionAgeMs?: number
  reasonCode?: string
  ageMs?: number
  artifactType?: string
  artifactVersion?: number
  contentHash?: string
  previousHash?: string
  atsType?: string
  flowVersion?: string
  preflightStatus?: string
  resultCode?: string
  sampledAt?: string
  oldestAgeMs?: number
  depth?: number
  unit?: string
  chargeType?: string
  inputTokens?: number
  outputTokens?: number
  costMicros?: number
}

export interface HarnessEvent<T extends HarnessEventType = HarnessEventType> {
  eventId: string
  schemaVersion: "harness-event.v1"
  eventType: T
  occurredAt: string
  correlationId: string
  traceId: string
  spanId: string
  parentSpanId: string | null
  sessionId: string
  turnId?: string
  taskId?: string
  itemId?: string
  toolCallId?: string
  applicationTaskId?: string
  jobId?: string
  automationId?: string
  queueJobId?: string
  toolName?: string
  provider?: string
  model?: string
  /** Opaque internal subject identifier; never an email or display name. */
  userId?: string
  payload: HarnessEventPayload
}

export interface CreateHarnessEventInput<T extends HarnessEventType> {
  eventType: T
  trace: TraceContext
  sessionId: string
  turnId?: string
  taskId?: string
  itemId?: string
  toolCallId?: string
  applicationTaskId?: string
  jobId?: string
  automationId?: string
  queueJobId?: string
  toolName?: string
  provider?: string
  model?: string
  correlationId?: string
  userId?: string
  occurredAt?: Date | string
  eventId?: string
  payload?: HarnessEventPayload
  idFactory?: () => string
}

type HarnessEventPayloadKey = keyof HarnessEventPayload

const EVENT_PAYLOAD_KEYS: Record<HarnessEventType, readonly HarnessEventPayloadKey[]> = {
  "session.started": ["entryPoint", "harnessVersion"],
  "session.completed": ["status", "durationMs", "finalTurnCount"],
  "turn.queued": ["queueName", "queueWaitMs"],
  "turn.started": ["turnIndex", "mode"],
  "turn.completed": ["status", "durationMs", "stepCount"],
  "turn.failed": ["failureCode", "retryable", "durationMs"],
  "turn.recovered": ["recoveryCode", "attempt", "durationMs"],
  "tool.invoked": ["toolName", "toolVersion", "approvalRequired"],
  "tool.completed": ["toolName", "toolVersion", "durationMs", "status"],
  "tool.failed": ["toolName", "toolVersion", "failureCode", "retryable", "durationMs"],
  "approval.requested": ["approvalScope", "toolName", "expiresAt"],
  "approval.granted": ["approvalScope", "toolName", "decisionAgeMs"],
  "approval.denied": ["approvalScope", "toolName", "decisionAgeMs", "reasonCode"],
  "approval.expired": ["approvalScope", "toolName", "ageMs"],
  "artifact.created": ["artifactType", "artifactVersion", "contentHash"],
  "artifact.updated": ["artifactType", "artifactVersion", "contentHash", "previousHash"],
  "submission.attempted": ["atsType", "flowVersion", "preflightStatus"],
  "submission.completed": ["atsType", "flowVersion", "durationMs", "resultCode"],
  "submission.failed": ["atsType", "flowVersion", "failureCode", "retryable", "durationMs"],
  "cost.charged": ["costMicros", "inputTokens", "outputTokens", "unit", "chargeType"],
  "queue.depth": ["queueName", "depth", "oldestAgeMs", "sampledAt"],
}

const PAYLOAD_KEYS = new Set<HarnessEventPayloadKey>(Object.values(EVENT_PAYLOAD_KEYS).flat())

const EVENT_TYPE_SET = new Set<string>(HARNESS_EVENT_TYPES)
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const IPV4_VALUE = /^(?:\d{1,3}\.){3}\d{1,3}$/u

function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256 || /\s|[\u0000-\u001f\u007f]/u.test(value) || EMAIL_VALUE.test(value) || IPV4_VALUE.test(value)) throw new Error(`${label} must be a bounded opaque identifier`)
  return value
}

function validateNumber(value: number, key: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be a finite non-negative number`)
}

/** Runtime guard for callers crossing an untyped Worker/Web boundary. */
export function assertSafeEventPayload(payload: unknown, eventType?: HarnessEventType): asserts payload is HarnessEventPayload {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("event payload must be a plain object")
  const prototype = Object.getPrototypeOf(payload)
  if (prototype !== Object.prototype && prototype !== null) throw new Error("event payload must be a plain object")
  const allowed = eventType === undefined ? PAYLOAD_KEYS : new Set(EVENT_PAYLOAD_KEYS[eventType])
  for (const [key, value] of Object.entries(payload)) {
    if (!allowed.has(key as HarnessEventPayloadKey)) throw new Error(`unsupported or sensitive event payload key: ${key}`)
    if (typeof value === "number") validateNumber(value, key)
    else if (typeof value !== "string" && typeof value !== "boolean") throw new Error(`event payload value for ${key} must be a string, number, or boolean`)
    else if (typeof value === "string" && (value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value) || EMAIL_VALUE.test(value) || IPV4_VALUE.test(value))) throw new Error(`event payload value for ${key} is unbounded or looks like PII`)
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
  for (const [value, label] of [
    [input.userId, "userId"], [input.taskId, "taskId"], [input.itemId, "itemId"], [input.toolCallId, "toolCallId"],
    [input.applicationTaskId, "applicationTaskId"], [input.jobId, "jobId"], [input.automationId, "automationId"],
    [input.queueJobId, "queueJobId"], [input.toolName, "toolName"], [input.provider, "provider"], [input.model, "model"],
  ] as const) if (value !== undefined) requireNonEmpty(value, label)
  assertSafeEventPayload(input.payload ?? {}, input.eventType)
  assertTraceContext(input.trace)
  const idFactory = input.idFactory ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
  return {
    eventId: requireNonEmpty(input.eventId ?? idFactory(), "eventId"),
    eventType: input.eventType,
    schemaVersion: "harness-event.v1",
    occurredAt: isoDate(input.occurredAt),
    correlationId: requireNonEmpty(input.correlationId ?? `${input.eventType}:${input.trace.traceId}`, "correlationId"),
    traceId: input.trace.traceId,
    spanId: input.trace.spanId,
    parentSpanId: input.trace.parentSpanId,
    sessionId: input.sessionId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.itemId ? { itemId: input.itemId } : {}),
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    ...(input.applicationTaskId ? { applicationTaskId: input.applicationTaskId } : {}),
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(input.automationId ? { automationId: input.automationId } : {}),
    ...(input.queueJobId ? { queueJobId: input.queueJobId } : {}),
    ...(input.toolName ? { toolName: input.toolName } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
    payload: { ...(input.payload ?? {}) },
  }
}
