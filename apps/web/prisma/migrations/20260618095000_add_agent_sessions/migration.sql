-- CreateTable
CREATE TABLE "public"."agent_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "memorySummary" TEXT NOT NULL DEFAULT '',
    "qualityScore" DOUBLE PRECISION,
    "currentTaskId" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."sub_agent_tasks" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "constraints" JSONB NOT NULL,
    "successCriteria" JSONB NOT NULL,
    "allowedActions" JSONB NOT NULL,
    "context" JSONB NOT NULL,
    "expectedOutputSchema" JSONB NOT NULL,
    "result" JSONB,
    "confidence" DOUBLE PRECISION,
    "failureReason" TEXT,
    "qualityGateResult" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sub_agent_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_transcript_events" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "taskId" TEXT,
    "type" TEXT NOT NULL,
    "speaker" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_transcript_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_approvals" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "taskId" TEXT,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "impact" JSONB,
    "payload" JSONB NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_automations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "triggerType" TEXT NOT NULL,
    "cron" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Berlin',
    "targetRoles" TEXT[],
    "targetLocations" TEXT[],
    "minScore" INTEGER NOT NULL DEFAULT 85,
    "dailyCap" INTEGER NOT NULL DEFAULT 8,
    "requireApproval" BOOLEAN NOT NULL DEFAULT true,
    "autoApply" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL DEFAULT 'user',
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_automations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_sessions_userId_createdAt_idx" ON "public"."agent_sessions"("userId" ASC, "createdAt" DESC);

-- CreateIndex
CREATE INDEX "agent_sessions_userId_status_idx" ON "public"."agent_sessions"("userId" ASC, "status" ASC);

-- CreateIndex
CREATE INDEX "sub_agent_tasks_sessionId_status_idx" ON "public"."sub_agent_tasks"("sessionId" ASC, "status" ASC);

-- CreateIndex
CREATE INDEX "sub_agent_tasks_sessionId_role_idx" ON "public"."sub_agent_tasks"("sessionId" ASC, "role" ASC);

-- CreateIndex
CREATE INDEX "agent_transcript_events_sessionId_createdAt_idx" ON "public"."agent_transcript_events"("sessionId" ASC, "createdAt" ASC);

-- CreateIndex
CREATE INDEX "agent_transcript_events_sessionId_type_idx" ON "public"."agent_transcript_events"("sessionId" ASC, "type" ASC);

-- CreateIndex
CREATE INDEX "agent_approvals_userId_status_createdAt_idx" ON "public"."agent_approvals"("userId" ASC, "status" ASC, "createdAt" ASC);

-- CreateIndex
CREATE INDEX "agent_approvals_sessionId_status_idx" ON "public"."agent_approvals"("sessionId" ASC, "status" ASC);

-- CreateIndex
CREATE INDEX "agent_automations_userId_enabled_createdAt_idx" ON "public"."agent_automations"("userId" ASC, "enabled" ASC, "createdAt" ASC);

-- CreateIndex
CREATE INDEX "agent_automations_userId_nextRunAt_idx" ON "public"."agent_automations"("userId" ASC, "nextRunAt" ASC);

-- AddForeignKey
ALTER TABLE "public"."agent_sessions" ADD CONSTRAINT "agent_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."sub_agent_tasks" ADD CONSTRAINT "sub_agent_tasks_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."agent_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_transcript_events" ADD CONSTRAINT "agent_transcript_events_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."agent_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_approvals" ADD CONSTRAINT "agent_approvals_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."agent_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_automations" ADD CONSTRAINT "agent_automations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
