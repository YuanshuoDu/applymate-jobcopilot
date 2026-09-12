-- P3-23: durable, append-only storage for the opt-in P3-22 context adapter.
-- This is intentionally separate from the sequence-based snapshot domain.

CREATE TABLE "agent_context_compaction_snapshots" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "snapshotRef" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "byteCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_context_compaction_snapshots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_context_compaction_snapshots_identity_check" CHECK (
      octet_length("id") BETWEEN 1 AND 256
      AND octet_length("userId") BETWEEN 1 AND 256
      AND octet_length("sessionId") BETWEEN 1 AND 256
      AND octet_length("turnId") BETWEEN 1 AND 256
      AND octet_length("stepId") BETWEEN 1 AND 256
      AND octet_length("idempotencyKey") BETWEEN 1 AND 256
    ),
    CONSTRAINT "agent_context_compaction_snapshots_ref_check" CHECK ("snapshotRef" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "agent_context_compaction_snapshots_byteCount_check" CHECK (
      "byteCount" BETWEEN 0 AND 262144
      -- The Worker enforces the 256 KiB canonical UTF-8 limit. JSONB::text
      -- can add serialization overhead, so keep a finite database guard.
      AND octet_length("snapshot"::text) <= 524288
    ),
    CONSTRAINT "agent_context_compaction_snapshots_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "agent_context_compaction_snapshots_sessionId_fkey"
      FOREIGN KEY ("sessionId", "userId") REFERENCES "agent_sessions"("id", "userId")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "agent_context_compaction_snapshots_turnId_fkey"
      FOREIGN KEY ("turnId", "sessionId", "userId") REFERENCES "agent_turns"("id", "sessionId", "userId")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "agent_context_compaction_snapshots_stepId_fkey"
      FOREIGN KEY ("stepId", "turnId", "sessionId") REFERENCES "agent_steps"("id", "turnId", "sessionId")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "agent_context_compaction_snapshots_userId_sessionId_turnId_stepId_idempotencyKey_key"
  ON "agent_context_compaction_snapshots"("userId", "sessionId", "turnId", "stepId", "idempotencyKey");
CREATE UNIQUE INDEX "agent_context_compaction_snapshots_snapshotRef_key"
  ON "agent_context_compaction_snapshots"("snapshotRef");
CREATE INDEX "agent_context_compaction_snapshots_userId_sessionId_turnId_stepId_idx"
  ON "agent_context_compaction_snapshots"("userId", "sessionId", "turnId", "stepId");
CREATE INDEX "agent_context_compaction_snapshots_sessionId_turnId_createdAt_idx"
  ON "agent_context_compaction_snapshots"("sessionId", "turnId", "createdAt" DESC);

CREATE OR REPLACE FUNCTION "prevent_agent_context_compaction_snapshot_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'agent context compaction snapshots are immutable';
END;
$$;

CREATE TRIGGER "agent_context_compaction_snapshots_immutable_update"
BEFORE UPDATE ON "agent_context_compaction_snapshots"
FOR EACH ROW
EXECUTE FUNCTION "prevent_agent_context_compaction_snapshot_update"();

ALTER TABLE "agent_context_compaction_snapshots" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agent_context_compaction_snapshot_user_isolation"
  ON "agent_context_compaction_snapshots"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK ("userId" = NULLIF(current_setting('app.user_id', true), ''));

-- The candidate role may create/read its own immutable rows. If the role was
-- provisioned separately, apply the same least-privilege grant here as part of
-- this additive migration; role-grants.sql repeats it for later role setup.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'applymate_candidate') THEN
    GRANT SELECT, INSERT ON TABLE "agent_context_compaction_snapshots" TO applymate_candidate;
    REVOKE UPDATE, DELETE ON TABLE "agent_context_compaction_snapshots" FROM applymate_candidate;
  END IF;
END
$$;
