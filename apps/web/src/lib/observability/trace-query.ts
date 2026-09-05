import { Prisma, type PrismaClient } from "@prisma/client"

import { db } from "@/lib/db"

export type HarnessTraceFilter = {
  traceId?: string
  sessionId?: string
  limit?: number
}

export type HarnessTraceEvent = {
  eventId: string
  eventType: string
  schemaVersion: string
  correlationId: string
  traceId: string
  spanId: string
  parentSpanId: string | null
  sessionId: string | null
  turnId: string | null
  taskId: string | null
  itemId: string | null
  toolCallId: string | null
  applicationTaskId: string | null
  jobId: string | null
  automationId: string | null
  queueJobId: string | null
  toolName: string | null
  provider: string | null
  model: string | null
  occurredAt: string
}

type TraceRow = Omit<HarnessTraceEvent, "occurredAt"> & { occurred_at: Date }

/** Returns an ordered, metadata-only trace; payload and error details never cross this boundary. */
export async function queryHarnessTrace(
  filter: HarnessTraceFilter,
  client: Pick<PrismaClient, "$queryRaw"> = db,
): Promise<HarnessTraceEvent[]> {
  const traceId = optionalOpaqueId(filter.traceId, "traceId")
  const sessionId = optionalOpaqueId(filter.sessionId, "sessionId")
  if (!traceId && !sessionId) throw new Error("traceId or sessionId is required")
  const limit = filter.limit === undefined ? 500 : filter.limit
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_000) throw new Error("limit must be between 1 and 2000")
  const predicate = traceId
    ? Prisma.sql`"trace_id" = ${traceId}`
    : Prisma.sql`"session_id" = ${sessionId}`
  const rows = await client.$queryRaw<TraceRow[]>(Prisma.sql`
    SELECT "id" AS "eventId", "event_type" AS "eventType", "schema_version" AS "schemaVersion",
           "correlation_id" AS "correlationId", "trace_id" AS "traceId", "span_id" AS "spanId",
           "parent_span_id" AS "parentSpanId", "session_id" AS "sessionId", "turn_id" AS "turnId",
           "task_id" AS "taskId", "item_id" AS "itemId", "tool_call_id" AS "toolCallId",
           "application_task_id" AS "applicationTaskId", "job_id" AS "jobId", "automation_id" AS "automationId",
           "queue_job_id" AS "queueJobId", "tool_name" AS "toolName", "provider", "model", "occurred_at"
    FROM "harness_metric_events"
    WHERE ${predicate}
    ORDER BY "occurred_at" ASC, "created_at" ASC, "id" ASC
    LIMIT ${limit}
  `)
  return rows.map((row) => ({ ...row, occurredAt: row.occurred_at.toISOString() }))
}

function optionalOpaqueId(value: string | undefined, label: string): string | null {
  if (value === undefined) return null
  if (!value.trim() || value.length > 256 || /\s|[\u0000-\u001f\u007f]/u.test(value) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(value)) {
    throw new Error(`${label} must be an opaque non-PII identifier`)
  }
  return value
}
