ALTER TABLE "sub_agent_tasks"
  ADD COLUMN "absoluteDeadlineAt" TIMESTAMP(3),
  ADD COLUMN "leaseSegmentStartedAt" TIMESTAMP(3);

CREATE INDEX "sub_agent_tasks_status_absoluteDeadlineAt_idx"
  ON "sub_agent_tasks"("status", "absoluteDeadlineAt");
