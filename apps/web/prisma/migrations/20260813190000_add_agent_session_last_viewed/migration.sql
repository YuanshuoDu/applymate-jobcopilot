-- Keep the last opened Agent conversation per account, independently of run
-- activity. This lets a returning user resume their own workspace session.
ALTER TABLE "agent_sessions"
  ADD COLUMN IF NOT EXISTS "lastViewedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "agent_sessions_userId_lastViewedAt_idx"
  ON "agent_sessions"("userId", "lastViewedAt" DESC);
