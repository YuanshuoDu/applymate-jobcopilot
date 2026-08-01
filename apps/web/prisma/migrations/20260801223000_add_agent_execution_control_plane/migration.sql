CREATE TABLE "agent_executions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "checkpoint" TEXT NOT NULL DEFAULT 'scout',
  "state" JSONB,
  "error" TEXT,
  "workerTaskId" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_executions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_executions_sessionId_key" ON "agent_executions"("sessionId");
CREATE INDEX "agent_executions_userId_status_updatedAt_idx" ON "agent_executions"("userId", "status", "updatedAt" DESC);
CREATE INDEX "agent_executions_status_updatedAt_idx" ON "agent_executions"("status", "updatedAt");

ALTER TABLE "agent_executions" ADD CONSTRAINT "agent_executions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_executions" ADD CONSTRAINT "agent_executions_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "agent_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
