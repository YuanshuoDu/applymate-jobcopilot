-- Harness 2.0 Phase 1: append-only event facts, projected Items and a
-- transactionally-created dispatch outbox.

ALTER TABLE "agent_sessions"
  ADD COLUMN "eventSequence" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "agent_sessions"
  ADD CONSTRAINT "agent_sessions_eventSequence_check"
  CHECK ("eventSequence" >= 0);

CREATE TABLE "agent_items" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "stepId" TEXT,
    "taskId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "phase" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "content" JSONB NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_items_status_check" CHECK ("status" IN (
      'started', 'streaming', 'completed', 'failed', 'interrupted'
    )),
    CONSTRAINT "agent_items_phase_check" CHECK (
      "phase" IS NULL OR "phase" IN ('commentary', 'final_answer')
    ),
    CONSTRAINT "agent_items_revision_check" CHECK ("revision" >= 0)
);

CREATE TABLE "agent_events" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "itemId" TEXT,
    "taskId" TEXT,
    "sequence" BIGINT NOT NULL,
    "type" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "causationId" TEXT,
    "idempotencyKey" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_events_sequence_check" CHECK ("sequence" >= 0),
    CONSTRAINT "agent_events_actor_check" CHECK (
      "actor" IN ('user', 'orchestrator', 'subagent', 'tool', 'system')
    )
);

CREATE TABLE "agent_outbox" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_outbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_outbox_attemptCount_check" CHECK ("attemptCount" >= 0)
);

CREATE UNIQUE INDEX "agent_events_sessionId_sequence_key"
  ON "agent_events"("sessionId", "sequence");
CREATE UNIQUE INDEX "agent_events_sessionId_idempotencyKey_key"
  ON "agent_events"("sessionId", "idempotencyKey");
CREATE INDEX "agent_events_turnId_sequence_idx"
  ON "agent_events"("turnId", "sequence");
CREATE INDEX "agent_events_taskId_sequence_idx"
  ON "agent_events"("taskId", "sequence");

CREATE INDEX "agent_items_turnId_stepId_createdAt_idx"
  ON "agent_items"("turnId", "stepId", "createdAt");
CREATE INDEX "agent_items_sessionId_type_createdAt_idx"
  ON "agent_items"("sessionId", "type", "createdAt");

CREATE UNIQUE INDEX "agent_outbox_idempotencyKey_key"
  ON "agent_outbox"("idempotencyKey");
CREATE INDEX "agent_outbox_publishedAt_createdAt_idx"
  ON "agent_outbox"("publishedAt", "createdAt");

ALTER TABLE "agent_items"
  ADD CONSTRAINT "agent_items_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "agent_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_items_turnId_fkey"
  FOREIGN KEY ("turnId") REFERENCES "agent_turns"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_items_stepId_fkey"
  FOREIGN KEY ("stepId") REFERENCES "agent_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "agent_events"
  ADD CONSTRAINT "agent_events_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "agent_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_events_turnId_fkey"
  FOREIGN KEY ("turnId") REFERENCES "agent_turns"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_events_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "agent_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
