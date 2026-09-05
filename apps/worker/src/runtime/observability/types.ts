import { randomUUID } from "node:crypto"

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

export type TraceContext = {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | null
}

export const SAFE_METRIC_PAYLOAD_KEYS = [
  "entryPoint", "harnessVersion", "status", "durationMs", "finalTurnCount", "queueName", "queueWaitMs",
  "turnIndex", "mode", "stepCount", "failureCode", "retryable", "recoveryCode", "attempt",
  "toolName", "toolVersion", "approvalRequired", "approvalScope", "expiresAt", "decisionAgeMs", "reasonCode", "ageMs",
  "artifactType", "artifactVersion", "contentHash", "previousHash", "atsType", "flowVersion", "preflightStatus", "resultCode",
  "sampledAt", "oldestAgeMs", "depth", "unit", "chargeType", "model", "operation", "errorCode", "latencyMs", "queueDepth",
  "inputTokens", "outputTokens", "costMicros",
] as const

export type SafeMetricPayloadKey = (typeof SAFE_METRIC_PAYLOAD_KEYS)[number]
export type SafeMetricPayloadValue = string | number | boolean
export type SafeMetricPayload = { readonly [key in SafeMetricPayloadKey]?: SafeMetricPayloadValue }

const EVENT_PAYLOAD_KEYS: Record<HarnessEventType, readonly SafeMetricPayloadKey[]> = {
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

export type WorkerObservabilityEventInput = {
  readonly eventType: HarnessEventType
  readonly trace: TraceContext
  readonly userId?: string | null
  readonly sessionId?: string | null
  readonly turnId?: string | null
  readonly taskId?: string | null
  readonly itemId?: string | null
  readonly toolCallId?: string | null
  readonly applicationTaskId?: string | null
  readonly jobId?: string | null
  readonly automationId?: string | null
  readonly queueJobId?: string | null
  readonly correlationId?: string | null
  readonly provider?: string | null
  readonly model?: string | null
  readonly toolName?: string | null
  readonly source?: string
  readonly environment?: string
  readonly status?: string | null
  readonly errorCode?: string | null
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly costMicros?: number
  readonly costUsd?: number
  readonly latencyMs?: number
  readonly queueDepth?: number
  readonly value?: number
  readonly payload?: unknown
  readonly idempotencyKey?: string
  readonly eventId?: string
  readonly schemaVersion?: string
  readonly occurredAt?: Date
}

export type WorkerObservabilityEvent = {
  readonly id: string
  readonly eventType: HarnessEventType
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | null
  readonly userId: string | null
  readonly sessionId: string
  readonly turnId: string | null
  readonly taskId: string | null
  readonly itemId: string | null
  readonly toolCallId: string | null
  readonly applicationTaskId: string | null
  readonly jobId: string | null
  readonly automationId: string | null
  readonly queueJobId: string | null
  readonly correlationId: string
  readonly provider: string | null
  readonly schemaVersion: string
  readonly model: string | null
  readonly toolName: string | null
  readonly source: string
  readonly environment: string
  readonly status: string | null
  readonly errorCode: string | null
  readonly value: number | null
  readonly durationMs: number | null
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costMicros: number
  readonly estimatedCostUsd: number
  readonly latencyMs: number | null
  readonly queueDepth: number | null
  readonly payload: SafeMetricPayload
  readonly idempotencyKey: string
  readonly occurredAt: Date
}

export interface WorkerObservabilityStore {
  write(event: WorkerObservabilityEvent): Promise<void>
}

export type MetricSynchronizer = (event: WorkerObservabilityEvent) => Promise<void> | void

export class ObservabilityValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ObservabilityValidationError"
  }
}

const PII_KEY_TOKENS = new Set(["email", "text", "ip", "ipaddress", "address", "phone", "raw", "prompt", "body", "content", "resume", "coverletter", "cookie", "authorization", "secret", "apikey", "password", "useragent"])
const SAFE_METRIC_PAYLOAD_KEY_SET = new Set<string>(SAFE_METRIC_PAYLOAD_KEYS)

export function makeSafeMetricPayload(value: unknown, eventType?: HarnessEventType): SafeMetricPayload {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new ObservabilityValidationError("payload must be a plain object")
  const allowedKeys = eventType === undefined ? SAFE_METRIC_PAYLOAD_KEY_SET : new Set(EVENT_PAYLOAD_KEYS[eventType])
  const output: Partial<Record<SafeMetricPayloadKey, SafeMetricPayloadValue>> = {}
  for (const [key, child] of Object.entries(value)) {
    if (!allowedKeys.has(key) || isPiiKey(key)) throw new ObservabilityValidationError(`payload.${key} is not an allowed observability field`)
    if (typeof child !== "string" && typeof child !== "number" && typeof child !== "boolean") throw new ObservabilityValidationError(`payload.${key} must be a string, number, or boolean`)
    if (typeof child === "string") {
      if (child.length > 256 || /[\u0000-\u001f\u007f]/u.test(child)) throw new ObservabilityValidationError(`payload.${key} is not a bounded string`)
    } else if (typeof child === "number" && (!Number.isFinite(child) || child < 0)) {
      throw new ObservabilityValidationError(`payload.${key} must be a finite non-negative number`)
    }
    output[key as SafeMetricPayloadKey] = child
  }
  return output
}

export function createDefaultId(): string {
  return randomUUID()
}

function isPiiKey(key: string): boolean {
  if (SAFE_METRIC_PAYLOAD_KEY_SET.has(key)) return false
  const tokens = key.replace(/([a-z])([A-Z])/gu, "$1_$2").toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean)
  return tokens.some(token => PII_KEY_TOKENS.has(token))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
