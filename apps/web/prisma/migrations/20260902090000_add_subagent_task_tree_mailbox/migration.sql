-- AH2-028: evolve legacy SubAgentTask rows without removing their old
-- vocabulary, and add the durable mailbox used by later subagent runtime work.

ALTER TABLE "sub_agent_tasks"
  ADD COLUMN "turnId" TEXT,
  ADD COLUMN "rootTaskId" TEXT,
  ADD COLUMN "parentTaskId" TEXT,
  ADD COLUMN "path" TEXT NOT NULL DEFAULT '/',
  ADD COLUMN "depth" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "contextSnapshotId" TEXT,
  ADD COLUMN "modelProfileSnapshot" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "toolPolicySnapshot" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "budgetSnapshot" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "leaseOwner" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "startedAt" TIMESTAMP(3),
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "interruptRequestedAt" TIMESTAMP(3),
  ADD COLUMN "closedAt" TIMESTAMP(3),
  ADD COLUMN "outputArtifactIds" JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Keep legacy values readable during the projection transition. New writes are
-- normalized by the repository from passed -> completed.
ALTER TABLE "sub_agent_tasks"
  ADD CONSTRAINT "sub_agent_tasks_depth_check" CHECK ("depth" >= 0),
  ADD CONSTRAINT "sub_agent_tasks_attemptCount_check" CHECK ("attemptCount" >= 0),
  ADD CONSTRAINT "sub_agent_tasks_maxAttempts_check" CHECK ("maxAttempts" > 0),
  ADD CONSTRAINT "sub_agent_tasks_status_check" CHECK ("status" IN (
    'queued', 'running', 'waiting', 'waiting_for_user', 'completed',
    'failed', 'interrupted', 'cancelled', 'closed',
    'passed', 'retrying', 'skipped'
  ));

CREATE UNIQUE INDEX "agent_turns_id_sessionId_key"
  ON "agent_turns"("id", "sessionId");
CREATE UNIQUE INDEX "sub_agent_tasks_id_sessionId_key"
  ON "sub_agent_tasks"("id", "sessionId");
CREATE INDEX "sub_agent_tasks_sessionId_path_idx"
  ON "sub_agent_tasks"("sessionId", "path");
CREATE INDEX "sub_agent_tasks_sessionId_rootTaskId_path_idx"
  ON "sub_agent_tasks"("sessionId", "rootTaskId", "path");
CREATE INDEX "sub_agent_tasks_sessionId_parentTaskId_createdAt_idx"
  ON "sub_agent_tasks"("sessionId", "parentTaskId", "createdAt");

-- Composite references include sessionId so a task tree cannot link across
-- sessions even when an attacker knows a task id from another session.
ALTER TABLE "sub_agent_tasks"
  ADD CONSTRAINT "sub_agent_tasks_turnId_sessionId_fkey"
  FOREIGN KEY ("turnId", "sessionId") REFERENCES "agent_turns"("id", "sessionId")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "sub_agent_tasks_parentTaskId_sessionId_fkey"
  FOREIGN KEY ("parentTaskId", "sessionId") REFERENCES "sub_agent_tasks"("id", "sessionId")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "sub_agent_tasks_rootTaskId_sessionId_fkey"
  FOREIGN KEY ("rootTaskId", "sessionId") REFERENCES "sub_agent_tasks"("id", "sessionId")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "agent_mailbox_messages" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "fromTaskId" TEXT,
    "toTaskId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_mailbox_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_mailbox_messages_sessionId_fkey"
      FOREIGN KEY ("sessionId") REFERENCES "agent_sessions"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "agent_mailbox_messages_sessionId_idempotencyKey_key"
  ON "agent_mailbox_messages"("sessionId", "idempotencyKey");
CREATE INDEX "agent_mailbox_messages_toTaskId_consumedAt_createdAt_idx"
  ON "agent_mailbox_messages"("toTaskId", "consumedAt", "createdAt");
CREATE INDEX "agent_mailbox_messages_sessionId_turnId_consumedAt_createdAt_idx"
  ON "agent_mailbox_messages"("sessionId", "turnId", "consumedAt", "createdAt");
