-- AH2-034: add immutable, source-attributed context snapshots without
-- changing existing turn, step, task, or mailbox rows.

CREATE TABLE "agent_context_snapshots" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "throughSequence" BIGINT NOT NULL,
    "version" INTEGER NOT NULL,
    "schemaVersion" TEXT NOT NULL DEFAULT 'agent-harness.context.v1',
    "content" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" DECIMAL(12,8) NOT NULL DEFAULT 0,
    "tokenAccounting" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_context_snapshots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_context_snapshots_sessionId_fkey"
      FOREIGN KEY ("sessionId") REFERENCES "agent_sessions"("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "agent_context_snapshots_throughSequence_check" CHECK ("throughSequence" >= 0),
    CONSTRAINT "agent_context_snapshots_version_check" CHECK ("version" > 0),
    CONSTRAINT "agent_context_snapshots_inputTokens_check" CHECK ("inputTokens" >= 0),
    CONSTRAINT "agent_context_snapshots_outputTokens_check" CHECK ("outputTokens" >= 0),
    CONSTRAINT "agent_context_snapshots_estimatedCostUsd_check" CHECK ("estimatedCostUsd" >= 0),
    CONSTRAINT "agent_context_snapshots_checksum_check" CHECK ("checksum" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "agent_context_snapshots_sessionId_version_key"
  ON "agent_context_snapshots"("sessionId", "version");
CREATE UNIQUE INDEX "agent_context_snapshots_sessionId_throughSequence_key"
  ON "agent_context_snapshots"("sessionId", "throughSequence");
CREATE INDEX "agent_context_snapshots_sessionId_createdAt_idx"
  ON "agent_context_snapshots"("sessionId", "createdAt" DESC);
CREATE INDEX "agent_context_snapshots_sessionId_throughSequence_idx"
  ON "agent_context_snapshots"("sessionId", "throughSequence");

-- Snapshot rows are append-only. Rollback is code/flag rollback with additive
-- retention; deleting the parent session remains the intentional data-retention
-- path through the foreign-key cascade.
CREATE OR REPLACE FUNCTION "prevent_agent_context_snapshot_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'agent context snapshots are immutable';
END;
$$;

CREATE TRIGGER "agent_context_snapshots_immutable_update"
BEFORE UPDATE ON "agent_context_snapshots"
FOR EACH ROW
EXECUTE FUNCTION "prevent_agent_context_snapshot_update"();
