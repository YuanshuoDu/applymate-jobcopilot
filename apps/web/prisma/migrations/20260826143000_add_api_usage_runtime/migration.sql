ALTER TABLE "ai_usage_events"
  ADD COLUMN "runtime" TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE "ai_usage_events"
  ADD CONSTRAINT "ai_usage_events_runtime_check"
  CHECK ("runtime" IN ('web', 'worker', 'admin', 'unknown'));

CREATE INDEX "ai_usage_events_runtime_created_at_idx"
  ON "ai_usage_events"("runtime", "created_at");

ALTER TABLE "job_api_usage_events"
  ADD COLUMN "runtime" TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE "job_api_usage_events"
  ADD CONSTRAINT "job_api_usage_events_runtime_check"
  CHECK ("runtime" IN ('web', 'worker', 'admin', 'unknown'));

CREATE INDEX "job_api_usage_events_runtime_created_at_idx"
  ON "job_api_usage_events"("runtime", "created_at");
