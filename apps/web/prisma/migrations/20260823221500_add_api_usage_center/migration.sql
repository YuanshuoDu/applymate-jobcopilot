-- Durable external API usage accounting and configurable provider quotas.
ALTER TABLE "ai_usage_events"
  ADD COLUMN "credential_source" TEXT NOT NULL DEFAULT 'platform';
CREATE INDEX "ai_usage_events_credential_source_created_at_idx" ON "ai_usage_events"("credential_source", "created_at");

CREATE TABLE "job_api_usage_events" (
  "id" TEXT NOT NULL,
  "user_id" TEXT,
  "provider" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "credential_source" TEXT NOT NULL DEFAULT 'public',
  "request_count" INTEGER NOT NULL DEFAULT 1,
  "jobs_returned" INTEGER NOT NULL DEFAULT 0,
  "latency_ms" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "http_status" INTEGER,
  "rate_limit_limit" INTEGER,
  "rate_limit_remaining" INTEGER,
  "rate_limit_reset_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "job_api_usage_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "job_api_usage_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "job_api_usage_events_non_negative_check" CHECK ("request_count" >= 0 AND "jobs_returned" >= 0 AND "latency_ms" >= 0),
  CONSTRAINT "job_api_usage_events_credential_source_check" CHECK ("credential_source" IN ('platform', 'user', 'public')),
  CONSTRAINT "job_api_usage_events_status_check" CHECK ("status" IN ('success', 'error'))
);

CREATE INDEX "job_api_usage_events_created_at_status_idx" ON "job_api_usage_events"("created_at", "status");
CREATE INDEX "job_api_usage_events_provider_operation_created_at_idx" ON "job_api_usage_events"("provider", "operation", "created_at");
CREATE INDEX "job_api_usage_events_credential_source_created_at_idx" ON "job_api_usage_events"("credential_source", "created_at");
CREATE INDEX "job_api_usage_events_user_id_created_at_idx" ON "job_api_usage_events"("user_id", "created_at");

CREATE TABLE "api_quotas" (
  "id" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "operation" TEXT NOT NULL DEFAULT '*',
  "metric" TEXT NOT NULL,
  "plan_name" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "limit" DOUBLE PRECISION NOT NULL,
  "reset_day" INTEGER NOT NULL DEFAULT 1,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updated_by_id" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "api_quotas_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "api_quotas_category_check" CHECK ("category" IN ('job', 'ai')),
  CONSTRAINT "api_quotas_metric_check" CHECK ("metric" IN ('requests', 'jobs', 'input_tokens', 'output_tokens', 'cost_usd')),
  CONSTRAINT "api_quotas_period_check" CHECK ("period" IN ('week', 'month')),
  CONSTRAINT "api_quotas_limit_check" CHECK ("limit" >= 0),
  CONSTRAINT "api_quotas_reset_day_check" CHECK ("reset_day" BETWEEN 0 AND 31)
);

CREATE UNIQUE INDEX "api_quotas_category_provider_operation_metric_key" ON "api_quotas"("category", "provider", "operation", "metric");
CREATE INDEX "api_quotas_category_enabled_provider_idx" ON "api_quotas"("category", "enabled", "provider");

INSERT INTO "api_quotas" ("id", "category", "provider", "operation", "metric", "plan_name", "period", "limit", "reset_day", "enabled", "version", "updated_at")
VALUES
  ('quota_cleanjobdata_trial_list', 'job', 'cleanjobdata', 'list', 'requests', 'Trial', 'month', 250, 1, true, 1, CURRENT_TIMESTAMP),
  ('quota_cleanjobdata_trial_detail', 'job', 'cleanjobdata', 'detail', 'requests', 'Trial', 'month', 500, 1, true, 1, CURRENT_TIMESTAMP),
  ('quota_fantasticjobs_trial_requests', 'job', 'fantasticjobs', '*', 'requests', 'Free Trial', 'week', 50, 1, true, 1, CURRENT_TIMESTAMP),
  ('quota_fantasticjobs_trial_jobs', 'job', 'fantasticjobs', '*', 'jobs', 'Free Trial', 'week', 500, 1, true, 1, CURRENT_TIMESTAMP)
ON CONFLICT ("category", "provider", "operation", "metric") DO NOTHING;
