import { createHash } from "node:crypto"
import type { Pool } from "pg"

import type { WorkerObservabilityEvent, WorkerObservabilityStore } from "./types.js"

export type ObservabilityQueryable = Pick<Pool, "query">

/**
 * The Web-owned migration maps this Prisma model to `harness_metric_events`
 * and exposes the snake_case columns used below. Five-minute usage rollups are
 * written in the same best-effort sink after the immutable source event.
 */
export class PgObservabilityStore implements WorkerObservabilityStore {
  constructor(private readonly pool: ObservabilityQueryable) {}

  async write(event: WorkerObservabilityEvent): Promise<void> {
    const result = await this.pool.query(
      `INSERT INTO "harness_metric_events"
        ("id", "event_type", "schema_version", "correlation_id", "trace_id", "span_id", "parent_span_id", "user_id", "session_id", "turn_id", "task_id",
         "item_id", "tool_call_id", "application_task_id", "job_id", "automation_id", "queue_job_id", "tool_name", "provider", "model", "source", "environment", "idempotency_key",
         "status", "error_code", "value", "duration_ms", "input_tokens", "output_tokens", "cost_micros", "estimated_cost_usd", "payload", "occurred_at", "created_at")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32::jsonb, $33, NOW())
       ON CONFLICT DO NOTHING`,
      [
        event.id,
        event.eventType,
        event.schemaVersion,
        event.correlationId,
        event.traceId,
        event.spanId,
        event.parentSpanId,
        event.userId,
        event.sessionId,
        event.turnId,
        event.taskId,
        event.itemId,
        event.toolCallId,
        event.applicationTaskId,
        event.jobId,
        event.automationId,
        event.queueJobId,
        event.toolName,
        event.provider,
        event.model,
        event.source,
        event.environment,
        event.idempotencyKey,
        event.status,
        event.errorCode,
        event.value,
        event.durationMs,
        event.inputTokens,
        event.outputTokens,
        event.costMicros,
        event.estimatedCostUsd,
        JSON.stringify(event.payload),
        event.occurredAt,
      ],
    )
    if (result.rowCount !== 0 && event.model && event.eventType === "cost.charged") {
      await this.writeUsageRollup(event)
    }
  }

  private async writeUsageRollup(event: WorkerObservabilityEvent): Promise<void> {
    const bucketMs = 5 * 60 * 1_000
    const bucketStart = new Date(Math.floor(event.occurredAt.getTime() / bucketMs) * bucketMs)
    const day = bucketStart.toISOString().slice(0, 10)
    const dimensions = [event.userId ?? "anonymous", event.sessionId ?? "system", event.turnId ?? "none", event.toolName ?? "none", event.provider ?? "unknown", event.model ?? "unknown", bucketStart.toISOString()]
    const aggregationKey = createHash("sha256").update(dimensions.join("\u001f")).digest("hex")
    await this.pool.query(
      `INSERT INTO "usage_event"
        ("id", "aggregation_key", "user_id", "session_id", "turn_id", "tool_name", "provider", "model", "event_type", "bucket_start", "day",
         "event_count", "input_tokens", "output_tokens", "cost_micros", "estimated_cost_usd", "total_latency_ms", "last_occurred_at", "created_at", "updated_at")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'cost.charged', $9, $10, 1, $11, $12, $13, $14, $15, $16, NOW(), NOW())
       ON CONFLICT ("aggregation_key") DO UPDATE SET
         "event_count" = "usage_event"."event_count" + 1,
         "input_tokens" = "usage_event"."input_tokens" + EXCLUDED."input_tokens",
         "output_tokens" = "usage_event"."output_tokens" + EXCLUDED."output_tokens",
         "cost_micros" = "usage_event"."cost_micros" + EXCLUDED."cost_micros",
         "estimated_cost_usd" = "usage_event"."estimated_cost_usd" + EXCLUDED."estimated_cost_usd",
         "total_latency_ms" = "usage_event"."total_latency_ms" + EXCLUDED."total_latency_ms",
         "last_occurred_at" = GREATEST("usage_event"."last_occurred_at", EXCLUDED."last_occurred_at"),
         "updated_at" = NOW()`,
      [
        event.id,
        aggregationKey,
        event.userId,
        event.sessionId,
        event.turnId,
        event.toolName,
        event.provider,
        event.model,
        bucketStart,
        day,
        event.inputTokens,
        event.outputTokens,
        event.costMicros,
        event.estimatedCostUsd,
        event.durationMs ?? 0,
        event.occurredAt,
      ],
    )
  }
}
