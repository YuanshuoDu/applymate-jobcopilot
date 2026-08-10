CREATE TABLE "ai_usage_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "feature_key" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "estimated_cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_usage_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_usage_events_created_at_status_idx" ON "ai_usage_events"("created_at", "status");
CREATE INDEX "ai_usage_events_feature_key_created_at_idx" ON "ai_usage_events"("feature_key", "created_at");
CREATE INDEX "ai_usage_events_provider_model_created_at_idx" ON "ai_usage_events"("provider", "model", "created_at");
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
