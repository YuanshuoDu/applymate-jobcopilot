import { createHash } from "node:crypto"

import { db } from "@/lib/db"
import type { HarnessEvent } from "./event-types"

type EventDelegate = {
  create(args: { data: Record<string, unknown> }): Promise<unknown>
}

type UsageDelegate = {
  upsert(args: {
    where: { aggregationKey: string }
    create: Record<string, unknown>
    update: Record<string, unknown>
  }): Promise<unknown>
}

export type HarnessEventPersistenceClient = {
  harnessMetricEvent: EventDelegate
  usageEvent: UsageDelegate
}

export type HarnessEventPersistenceResult = {
  inserted: boolean
  usageRolledUp: boolean
}

const defaultClient = db as unknown as HarnessEventPersistenceClient

/**
 * Persists a validated Web event and, for cost leaves, updates the five-minute
 * usage projection. The raw event is the idempotency gate, so a replay cannot
 * increment usage twice.
 */
export async function persistHarnessEvent(
  event: HarnessEvent,
  client: HarnessEventPersistenceClient = defaultClient,
): Promise<HarnessEventPersistenceResult> {
  try {
    await client.harnessMetricEvent.create({ data: eventData(event) })
  } catch (error: unknown) {
    if (isUniqueViolation(error)) return { inserted: false, usageRolledUp: false }
    throw error
  }

  if (event.eventType !== "cost.charged" || !event.model) return { inserted: true, usageRolledUp: false }
  await client.usageEvent.upsert(usageData(event))
  return { inserted: true, usageRolledUp: true }
}

function eventData(event: HarnessEvent): Record<string, unknown> {
  const payload = event.payload
  return {
    id: event.eventId,
    eventType: event.eventType,
    schemaVersion: event.schemaVersion,
    correlationId: event.correlationId,
    traceId: event.traceId,
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    userId: event.userId ?? null,
    sessionId: event.sessionId,
    turnId: event.turnId ?? null,
    taskId: event.taskId ?? null,
    itemId: event.itemId ?? null,
    toolCallId: event.toolCallId ?? null,
    applicationTaskId: event.applicationTaskId ?? null,
    jobId: event.jobId ?? null,
    automationId: event.automationId ?? null,
    queueJobId: event.queueJobId ?? null,
    toolName: event.toolName ?? payload.toolName ?? null,
    provider: event.provider ?? null,
    model: event.model ?? null,
    source: "web",
    environment: process.env.NODE_ENV ?? "unknown",
    idempotencyKey: event.eventId,
    status: payload.status ?? null,
    errorCode: payload.failureCode ?? null,
    value: event.eventType === "queue.depth" ? payload.depth ?? null : event.eventType === "cost.charged" ? (payload.costMicros ?? 0) / 1_000_000 : null,
    durationMs: payload.durationMs ?? null,
    inputTokens: payload.inputTokens ?? 0,
    outputTokens: payload.outputTokens ?? 0,
    costMicros: payload.costMicros ?? 0,
    estimatedCostUsd: (payload.costMicros ?? 0) / 1_000_000,
    payload,
    occurredAt: new Date(event.occurredAt),
  }
}

function usageData(event: HarnessEvent): {
  where: { aggregationKey: string }
  create: Record<string, unknown>
  update: Record<string, unknown>
} {
  const payload = event.payload
  const occurredAt = new Date(event.occurredAt)
  const bucketStart = new Date(Math.floor(occurredAt.getTime() / (5 * 60_000)) * (5 * 60_000))
  const userId = event.userId ?? null
  const toolName = event.toolName ?? null
  const provider = event.provider ?? null
  const aggregationKey = createHash("sha256").update([
    userId ?? "anonymous", event.sessionId, event.turnId ?? "none", toolName ?? "none",
    provider ?? "unknown", event.model, bucketStart.toISOString(),
  ].join("\u001f")).digest("hex")
  const inputTokens = payload.inputTokens ?? 0
  const outputTokens = payload.outputTokens ?? 0
  const costMicros = payload.costMicros ?? 0
  const latencyMs = payload.durationMs ?? 0
  const values = {
    aggregationKey,
    userId,
    sessionId: event.sessionId,
    turnId: event.turnId ?? null,
    toolName,
    provider,
    model: event.model,
    eventType: "cost.charged",
    bucketStart,
    day: new Date(`${bucketStart.toISOString().slice(0, 10)}T00:00:00.000Z`),
    eventCount: 1,
    inputTokens,
    outputTokens,
    costMicros,
    estimatedCostUsd: costMicros / 1_000_000,
    totalLatencyMs: latencyMs,
    lastOccurredAt: occurredAt,
  }
  return {
    where: { aggregationKey },
    create: values,
    update: {
      eventCount: { increment: 1 },
      inputTokens: { increment: inputTokens },
      outputTokens: { increment: outputTokens },
      costMicros: { increment: costMicros },
      estimatedCostUsd: { increment: costMicros / 1_000_000 },
      totalLatencyMs: { increment: latencyMs },
      lastOccurredAt: occurredAt,
    },
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002"
}
