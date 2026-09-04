import {
  createDefaultId,
  HARNESS_EVENT_TYPES,
  makeSafeMetricPayload,
  ObservabilityValidationError,
  type MetricSynchronizer,
  type WorkerObservabilityEvent,
  type WorkerObservabilityEventInput,
  type WorkerObservabilityStore,
} from "./types.js"
import { assertTraceContext, childTraceContext } from "./trace-context.js"

export type ObservabilityEmissionResult = {
  readonly event: WorkerObservabilityEvent
  readonly persisted: boolean
  readonly metricSynchronized: boolean
}

export type WorkerObservabilityEmitterOptions = {
  readonly store: WorkerObservabilityStore
  readonly synchronizeMetric?: MetricSynchronizer
  readonly clock?: () => Date
  readonly idFactory?: () => string
  readonly onError?: (kind: "persistence" | "metric_sync", error: unknown, event: WorkerObservabilityEvent) => void
}

export function createWorkerObservabilityEmitter(options: WorkerObservabilityEmitterOptions) {
  const clock = options.clock ?? (() => new Date())
  const idFactory = options.idFactory ?? createDefaultId

  return {
    childTrace: childTraceContext,
    async emit(input: WorkerObservabilityEventInput): Promise<ObservabilityEmissionResult> {
      const event = buildEvent(input, clock, idFactory)
      let persisted = false
      let metricSynchronized = !options.synchronizeMetric
      try {
        await options.store.write(event)
        persisted = true
      } catch (error: unknown) {
        report(options.onError, "persistence", error, event)
      }
      if (options.synchronizeMetric) {
        try {
          await options.synchronizeMetric(event)
          metricSynchronized = true
        } catch (error: unknown) {
          report(options.onError, "metric_sync", error, event)
        }
      }
      return { event, persisted, metricSynchronized }
    },
  }
}

function buildEvent(input: WorkerObservabilityEventInput, clock: () => Date, idFactory: () => string): WorkerObservabilityEvent {
  assertTraceContext(input.trace)
  const occurredAt = input.occurredAt ?? clock()
  if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime())) throw new ObservabilityValidationError("occurredAt must be a valid Date")
  const userId = optionalOpaqueId(input.userId, "userId")
  const sessionId = optionalOpaqueId(input.sessionId, "sessionId") ?? "system"
  const turnId = optionalOpaqueId(input.turnId, "turnId")
  const taskId = optionalOpaqueId(input.taskId, "taskId")
  const model = optionalString(input.model, "model")
  const toolName = optionalString(input.toolName, "toolName")
  const source = optionalString(input.source ?? "worker", "source") ?? "worker"
  const environment = optionalString(input.environment ?? "unknown", "environment") ?? "unknown"
  const status = optionalString(input.status, "status")
  if (!(HARNESS_EVENT_TYPES as readonly string[]).includes(input.eventType)) throw new ObservabilityValidationError("eventType is not in the AH2 taxonomy")
  const eventId = opaqueIdentity(input.eventId ?? idFactory(), "eventId")
  const idempotencyKey = input.idempotencyKey ?? `${input.eventType}:${sessionId ?? "system"}:${input.trace.spanId}`
  opaqueIdentity(idempotencyKey, "idempotencyKey")
  const correlationId = opaqueIdentity(input.correlationId ?? `${input.eventType}:${input.trace.traceId}`, "correlationId")
  const schemaVersion = optionalString(input.schemaVersion ?? "harness-event.v1", "schemaVersion") ?? "harness-event.v1"
  const inputTokens = nonNegativeInteger(input.inputTokens, "inputTokens", 0)
  const outputTokens = nonNegativeInteger(input.outputTokens, "outputTokens", 0)
  const costMicros = input.costMicros === undefined
    ? Math.round(nonNegativeNumber(input.costUsd, "costUsd", 0) * 1_000_000)
    : nonNegativeInteger(input.costMicros, "costMicros")
  const latencyMs = input.latencyMs === undefined ? null : nonNegativeInteger(input.latencyMs, "latencyMs")
  const queueDepth = input.queueDepth === undefined ? null : nonNegativeInteger(input.queueDepth, "queueDepth")
  const estimatedCostUsd = costMicros / 1_000_000
  const durationMs = latencyMs
  const value = input.value ?? (input.eventType === "queue.depth" ? queueDepth : input.eventType === "cost.charged" ? estimatedCostUsd : null)
  const metricValue = value === null ? null : nonNegativeNumber(value, "value", 0)
  return {
    id: eventId,
    eventType: input.eventType,
    schemaVersion,
    correlationId,
    traceId: input.trace.traceId,
    spanId: input.trace.spanId,
    parentSpanId: input.trace.parentSpanId,
    userId,
    sessionId,
    turnId,
    taskId,
    itemId: optionalOpaqueId(input.itemId, "itemId"),
    toolCallId: optionalOpaqueId(input.toolCallId, "toolCallId"),
    applicationTaskId: optionalOpaqueId(input.applicationTaskId, "applicationTaskId"),
    jobId: optionalOpaqueId(input.jobId, "jobId"),
    automationId: optionalOpaqueId(input.automationId, "automationId"),
    queueJobId: optionalOpaqueId(input.queueJobId, "queueJobId"),
    provider: optionalString(input.provider, "provider"),
    model,
    toolName,
    source,
    environment,
    status,
    errorCode: optionalString(input.errorCode, "errorCode"),
    value: metricValue,
    durationMs,
    inputTokens,
    outputTokens,
    costMicros,
    estimatedCostUsd,
    latencyMs,
    queueDepth,
    payload: makeSafeMetricPayload(input.payload, input.eventType),
    idempotencyKey,
    occurredAt: new Date(occurredAt.getTime()),
  }
}

function optionalOpaqueId(value: string | null | undefined, name: string): string | null {
  if (value === undefined || value === null) return null
  if (!value.trim() || value.length > 256 || /\s|[\u0000-\u001f\u007f]/u.test(value) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(value)) {
    throw new ObservabilityValidationError(`${name} must be an opaque non-PII identifier`)
  }
  return value
}

function optionalString(value: string | null | undefined, name: string): string | null {
  if (value === undefined || value === null) return null
  if (!value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(value) || /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value)) throw new ObservabilityValidationError(`${name} must be a bounded non-PII string`)
  return value
}

function opaqueIdentity(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /\s|[\u0000-\u001f\u007f]/u.test(value) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(value)) {
    throw new ObservabilityValidationError(`${name} must be an opaque non-PII identifier`)
  }
  return value
}

function nonNegativeInteger(value: number | undefined, name: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) throw new ObservabilityValidationError(`${name} must be a non-negative integer`)
  return value
}

function nonNegativeNumber(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 0) throw new ObservabilityValidationError(`${name} must be a non-negative finite number`)
  return value
}

function report(onError: WorkerObservabilityEmitterOptions["onError"], kind: "persistence" | "metric_sync", error: unknown, event: WorkerObservabilityEvent): void {
  try { onError?.(kind, error, event) } catch { /* Diagnostics must not break the best-effort telemetry path. */ }
}
