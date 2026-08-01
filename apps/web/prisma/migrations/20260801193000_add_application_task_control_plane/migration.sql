CREATE TABLE "application_tasks" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "sessionId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'discovered',
  "checkpoint" TEXT,
  "question" JSONB,
  "sensitiveFlags" JSONB,
  "resumeId" TEXT,
  "coverLetterId" TEXT,
  "workerTaskId" TEXT,
  "error" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "application_tasks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "application_task_events" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "data" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "application_task_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "application_tasks_userId_jobId_key" ON "application_tasks"("userId", "jobId");
CREATE INDEX "application_tasks_userId_status_updatedAt_idx" ON "application_tasks"("userId", "status", "updatedAt" DESC);
CREATE INDEX "application_tasks_sessionId_status_idx" ON "application_tasks"("sessionId", "status");
CREATE INDEX "application_task_events_taskId_createdAt_idx" ON "application_task_events"("taskId", "createdAt");

ALTER TABLE "application_tasks" ADD CONSTRAINT "application_tasks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "application_tasks" ADD CONSTRAINT "application_tasks_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "application_tasks" ADD CONSTRAINT "application_tasks_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "agent_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "application_task_events" ADD CONSTRAINT "application_task_events_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "application_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
