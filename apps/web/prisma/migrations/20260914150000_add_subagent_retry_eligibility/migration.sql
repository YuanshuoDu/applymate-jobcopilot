-- AH2-P4-70: durable, server-owned retry eligibility for subagent tasks.
ALTER TABLE "sub_agent_tasks"
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3);

CREATE INDEX "sub_agent_tasks_status_nextAttemptAt_updatedAt_idx"
  ON "sub_agent_tasks"("status", "nextAttemptAt", "updatedAt");
