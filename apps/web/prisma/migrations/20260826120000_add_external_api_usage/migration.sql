CREATE TABLE "external_api_usage_events" (
  "id" TEXT NOT NULL,
  "user_id" TEXT,
  "provider" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "credential_source" TEXT NOT NULL DEFAULT 'platform',
  "request_count" INTEGER NOT NULL DEFAULT 1,
  "input_bytes" INTEGER NOT NULL DEFAULT 0,
  "output_bytes" INTEGER NOT NULL DEFAULT 0,
  "estimated_cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "latency_ms" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "http_status" INTEGER,
  "error_code" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "external_api_usage_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "external_api_usage_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "external_api_usage_events_non_negative_check" CHECK ("request_count" >= 0 AND "input_bytes" >= 0 AND "output_bytes" >= 0 AND "estimated_cost_usd" >= 0 AND "latency_ms" >= 0),
  CONSTRAINT "external_api_usage_events_credential_source_check" CHECK ("credential_source" IN ('platform', 'user', 'public', 'internal')),
  CONSTRAINT "external_api_usage_events_status_check" CHECK ("status" IN ('success', 'error'))
);
CREATE INDEX "external_api_usage_events_created_at_status_idx" ON "external_api_usage_events"("created_at", "status");
CREATE INDEX "external_api_usage_events_provider_operation_created_at_idx" ON "external_api_usage_events"("provider", "operation", "created_at");
CREATE INDEX "external_api_usage_events_credential_source_created_at_idx" ON "external_api_usage_events"("credential_source", "created_at");
CREATE INDEX "external_api_usage_events_user_id_created_at_idx" ON "external_api_usage_events"("user_id", "created_at");
