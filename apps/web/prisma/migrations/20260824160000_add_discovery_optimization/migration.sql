CREATE TABLE "api_quota_reservations" (
    "id" TEXT NOT NULL,
    "quota_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "credential_scope" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "requested_units" DOUBLE PRECISION NOT NULL,
    "settled_units" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_quota_reservations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "discovery_optimization_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "event_type" TEXT NOT NULL,
    "provider" TEXT,
    "credential_scope" TEXT NOT NULL DEFAULT 'platform',
    "requests_avoided" INTEGER NOT NULL DEFAULT 0,
    "jobs_returned" INTEGER NOT NULL DEFAULT 0,
    "net_new_jobs" INTEGER NOT NULL DEFAULT 0,
    "valid_apply_urls" INTEGER NOT NULL DEFAULT 0,
    "complete_descriptions" INTEGER NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "reason_code" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discovery_optimization_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "api_quota_reservations_quota_id_period_start_period_end_status_idx"
  ON "api_quota_reservations"("quota_id", "period_start", "period_end", "status");
CREATE INDEX "api_quota_reservations_provider_operation_credential_scope_created_at_idx"
  ON "api_quota_reservations"("provider", "operation", "credential_scope", "created_at");
CREATE INDEX "discovery_optimization_events_event_type_created_at_idx"
  ON "discovery_optimization_events"("event_type", "created_at");
CREATE INDEX "discovery_optimization_events_provider_event_type_created_at_idx"
  ON "discovery_optimization_events"("provider", "event_type", "created_at");
CREATE INDEX "discovery_optimization_events_credential_scope_created_at_idx"
  ON "discovery_optimization_events"("credential_scope", "created_at");

ALTER TABLE "api_quota_reservations"
  ADD CONSTRAINT "api_quota_reservations_quota_id_fkey"
  FOREIGN KEY ("quota_id") REFERENCES "api_quotas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "discovery_optimization_events"
  ADD CONSTRAINT "discovery_optimization_events_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
