-- Harness 2.0 Phase 1: additive durable Session children.
-- AgentTurn rows are root turns for the current protocol. The partial unique
-- index below serializes active roots while retaining terminal history.

CREATE TABLE "agent_turns" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "source" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "finalResponse" TEXT,
    "error" TEXT,
    "rootTaskId" TEXT,
    "contextSnapshotId" TEXT,
    "modelProfileSnapshot" JSONB NOT NULL,
    "toolPolicySnapshot" JSONB NOT NULL,
    "budgetSnapshot" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" DECIMAL(12,8) NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_turns_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_turns_status_check" CHECK ("status" IN (
      'queued', 'in_progress', 'waiting_for_dependency',
      'waiting_for_approval', 'waiting_for_user', 'interrupted',
      'cancelled', 'failed', 'completed'
    )),
    CONSTRAINT "agent_turns_source_check" CHECK ("source" IN ('user', 'automation', 'system')),
    CONSTRAINT "agent_turns_revision_check" CHECK ("revision" >= 0),
    CONSTRAINT "agent_turns_token_counts_check" CHECK ("inputTokens" >= 0 AND "outputTokens" >= 0),
    CONSTRAINT "agent_turns_cost_check" CHECK ("estimatedCostUsd" >= 0),
    CONSTRAINT "agent_turns_duration_check" CHECK ("durationMs" IS NULL OR "durationMs" >= 0)
);

CREATE TABLE "agent_steps" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "taskId" TEXT,
    "parentStepId" TEXT,
    "ordinal" INTEGER NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "inputSnapshotId" TEXT,
    "inputThroughSequence" BIGINT NOT NULL,
    "consumedInputIds" JSONB NOT NULL,
    "modelProfileSnapshot" JSONB NOT NULL,
    "providerResponseId" TEXT,
    "providerConversationId" TEXT,
    "finishReason" TEXT,
    "errorCode" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" DECIMAL(12,8) NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_steps_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_steps_status_check" CHECK ("status" IN (
      'queued', 'streaming', 'waiting_for_tool', 'waiting_for_approval',
      'waiting_for_user', 'completed', 'failed', 'interrupted'
    )),
    CONSTRAINT "agent_steps_ordinal_check" CHECK ("ordinal" >= 0),
    CONSTRAINT "agent_steps_attempt_check" CHECK ("attempt" >= 1),
    CONSTRAINT "agent_steps_token_counts_check" CHECK ("inputTokens" >= 0 AND "outputTokens" >= 0),
    CONSTRAINT "agent_steps_cost_check" CHECK ("estimatedCostUsd" >= 0),
    CONSTRAINT "agent_steps_duration_check" CHECK ("durationMs" IS NULL OR "durationMs" >= 0)
);

CREATE TABLE "agent_inputs" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "targetTurnId" TEXT,
    "userId" TEXT NOT NULL,
    "clientMessageId" TEXT NOT NULL,
    "delivery" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'accepted',
    "content" JSONB NOT NULL,
    "acceptedSequence" BIGINT NOT NULL,
    "consumedByStepId" TEXT,
    "consumedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_inputs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_inputs_delivery_check" CHECK ("delivery" IN ('steer', 'follow_up')),
    CONSTRAINT "agent_inputs_status_check" CHECK ("status" IN (
      'accepted', 'queued', 'consumed', 'cancelled', 'rejected'
    )),
    CONSTRAINT "agent_inputs_sequence_check" CHECK ("acceptedSequence" >= 0)
);

CREATE INDEX "agent_turns_sessionId_createdAt_idx"
  ON "agent_turns"("sessionId", "createdAt");
CREATE INDEX "agent_turns_userId_status_updatedAt_idx"
  ON "agent_turns"("userId", "status", "updatedAt" DESC);

-- Only queued/running/waiting turns occupy the session root slot. This is the
-- database race boundary for startTurn; terminal history remains insertable.
CREATE UNIQUE INDEX "agent_turns_active_root_session_key"
  ON "agent_turns"("sessionId")
  WHERE "status" IN (
    'queued', 'in_progress', 'waiting_for_dependency',
    'waiting_for_approval', 'waiting_for_user'
  );

CREATE UNIQUE INDEX "agent_steps_turnId_ordinal_attempt_key"
  ON "agent_steps"("turnId", "ordinal", "attempt");
CREATE INDEX "agent_steps_turnId_status_createdAt_idx"
  ON "agent_steps"("turnId", "status", "createdAt");
CREATE INDEX "agent_steps_providerResponseId_idx"
  ON "agent_steps"("providerResponseId");

CREATE UNIQUE INDEX "agent_inputs_sessionId_clientMessageId_key"
  ON "agent_inputs"("sessionId", "clientMessageId");
CREATE INDEX "agent_inputs_sessionId_status_acceptedSequence_idx"
  ON "agent_inputs"("sessionId", "status", "acceptedSequence");
CREATE INDEX "agent_inputs_targetTurnId_status_acceptedSequence_idx"
  ON "agent_inputs"("targetTurnId", "status", "acceptedSequence");

ALTER TABLE "agent_turns"
  ADD CONSTRAINT "agent_turns_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_turns_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "agent_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_steps"
  ADD CONSTRAINT "agent_steps_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "agent_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_steps_turnId_fkey"
  FOREIGN KEY ("turnId") REFERENCES "agent_turns"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_steps_parentStepId_fkey"
  FOREIGN KEY ("parentStepId") REFERENCES "agent_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "agent_inputs"
  ADD CONSTRAINT "agent_inputs_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "agent_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_inputs_targetTurnId_fkey"
  FOREIGN KEY ("targetTurnId") REFERENCES "agent_turns"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_inputs_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_inputs_consumedByStepId_fkey"
  FOREIGN KEY ("consumedByStepId") REFERENCES "agent_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;
