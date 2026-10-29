-- Preserve existing historical timestamps. Only future inserts use UTC.
ALTER TABLE "ai_usage_events"
  ALTER COLUMN "created_at" SET DEFAULT timezone('UTC', CURRENT_TIMESTAMP);

-- Support account-scoped time windows without scanning every account.
CREATE INDEX "ai_usage_events_user_id_created_at_idx" ON "ai_usage_events"("user_id", "created_at");
