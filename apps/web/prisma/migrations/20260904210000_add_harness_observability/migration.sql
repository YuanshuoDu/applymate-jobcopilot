-- AH2-050: provider-neutral Harness telemetry and five-minute usage rollups.
-- Web owns this schema; the Worker writes with parameterized pg.Pool SQL.

CREATE TABLE "harness_metric_events" (
    "id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "schema_version" TEXT NOT NULL DEFAULT 'harness-event.v1',
    "correlation_id" TEXT NOT NULL,
    "trace_id" TEXT NOT NULL,
    "span_id" TEXT NOT NULL,
    "parent_span_id" TEXT,
    "user_id" TEXT,
    "session_id" TEXT NOT NULL,
    "turn_id" TEXT,
    "task_id" TEXT,
    "item_id" TEXT,
    "tool_call_id" TEXT,
    "application_task_id" TEXT,
    "job_id" TEXT,
    "automation_id" TEXT,
    "queue_job_id" TEXT,
    "tool_name" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "source" TEXT NOT NULL DEFAULT 'unknown',
    "environment" TEXT NOT NULL DEFAULT 'unknown',
    "idempotency_key" TEXT NOT NULL,
    "status" TEXT,
    "error_code" TEXT,
    "value" DOUBLE PRECISION,
    "duration_ms" INTEGER,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_micros" INTEGER NOT NULL DEFAULT 0,
    "estimated_cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "harness_metric_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "harness_metric_events_type_check" CHECK ("event_type" IN (
      'session.started', 'session.completed',
      'turn.queued', 'turn.started', 'turn.completed', 'turn.failed', 'turn.recovered',
      'tool.invoked', 'tool.completed', 'tool.failed',
      'approval.requested', 'approval.granted', 'approval.denied', 'approval.expired',
      'artifact.created', 'artifact.updated',
      'submission.attempted', 'submission.completed', 'submission.failed',
      'cost.charged', 'queue.depth'
    )),
    CONSTRAINT "harness_metric_events_trace_check" CHECK (length("trace_id") > 0 AND length("span_id") > 0 AND ("parent_span_id" IS NULL OR length("parent_span_id") > 0) AND length("correlation_id") > 0),
    CONSTRAINT "harness_metric_events_non_negative_check" CHECK (
      ("value" IS NULL OR "value" >= 0) AND
      ("duration_ms" IS NULL OR "duration_ms" >= 0) AND
      "input_tokens" >= 0 AND "output_tokens" >= 0 AND "cost_micros" >= 0 AND "estimated_cost_usd" >= 0
    ),
    CONSTRAINT "harness_metric_events_payload_pii_check" CHECK (
      "payload"::text !~* '(^|[,{])[[:space:]]*"(email|e-mail|phone|name|address|ip|ipAddress|userAgent|text|prompt|completion|message|content|resume|coverLetter|jobDescription|html|screenshot|har|cookie|authorization|token|secret|apiKey|password)"[[:space:]]*:'
    ),
    CONSTRAINT "harness_metric_events_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "harness_metric_events_trace_id_occurred_at_idx"
  ON "harness_metric_events"("trace_id", "occurred_at");
CREATE INDEX "harness_metric_events_session_id_occurred_at_idx"
  ON "harness_metric_events"("session_id", "occurred_at");
CREATE INDEX "harness_metric_events_event_type_occurred_at_idx"
  ON "harness_metric_events"("event_type", "occurred_at");
CREATE INDEX "harness_metric_events_user_id_model_tool_name_occurred_at_idx"
  ON "harness_metric_events"("user_id", "model", "tool_name", "occurred_at");
CREATE UNIQUE INDEX "harness_metric_events_trace_id_idempotency_key_key"
  ON "harness_metric_events"("trace_id", "idempotency_key");

CREATE TABLE "usage_event" (
    "id" TEXT NOT NULL,
    "aggregation_key" TEXT NOT NULL,
    "user_id" TEXT,
    "session_id" TEXT,
    "turn_id" TEXT,
    "tool_name" TEXT,
    "provider" TEXT,
    "model" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "bucket_start" TIMESTAMP(3) NOT NULL,
    "day" DATE NOT NULL,
    "event_count" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_micros" INTEGER NOT NULL DEFAULT 0,
    "estimated_cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_latency_ms" INTEGER NOT NULL DEFAULT 0,
    "last_occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_event_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "usage_event_aggregation_key_key" UNIQUE ("aggregation_key"),
    CONSTRAINT "usage_event_non_negative_check" CHECK (
      "event_count" >= 0 AND "input_tokens" >= 0 AND "output_tokens" >= 0 AND "cost_micros" >= 0 AND
      "estimated_cost_usd" >= 0 AND "total_latency_ms" >= 0
    ),
    CONSTRAINT "usage_event_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "usage_event_user_id_model_tool_name_day_idx"
  ON "usage_event"("user_id", "model", "tool_name", "day");
CREATE INDEX "usage_event_bucket_start_model_idx"
  ON "usage_event"("bucket_start", "model");
CREATE INDEX "usage_event_session_id_turn_id_tool_name_bucket_start_idx"
  ON "usage_event"("session_id", "turn_id", "tool_name", "bucket_start");

CREATE TABLE "harness_slo_alerts" (
    "id" TEXT NOT NULL,
    "rule_key" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "trace_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "harness_slo_alerts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "harness_slo_alerts_status_check" CHECK ("status" IN ('pass', 'open', 'resolved')),
    CONSTRAINT "harness_slo_alerts_value_check" CHECK ("value" >= 0 AND "threshold" >= 0)
);

CREATE INDEX "harness_slo_alerts_rule_key_status_created_at_idx"
  ON "harness_slo_alerts"("rule_key", "status", "created_at");
CREATE INDEX "harness_slo_alerts_metric_created_at_idx"
  ON "harness_slo_alerts"("metric", "created_at");
