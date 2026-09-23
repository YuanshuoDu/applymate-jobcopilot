-- P7-2a: separate user control gate from runtime session status.
-- Control operations are tenant-scoped, idempotent, and append-only.

ALTER TABLE "agent_sessions"
  ADD COLUMN "controlGate" TEXT NOT NULL DEFAULT 'open',
  ADD COLUMN "controlRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pausedAt" TIMESTAMP(3);

ALTER TABLE "agent_sessions"
  ADD CONSTRAINT "agent_sessions_controlGate_check"
    CHECK ("controlGate" IN ('open', 'user_paused')),
  ADD CONSTRAINT "agent_sessions_controlRevision_check"
    CHECK ("controlRevision" >= 0);

CREATE TABLE "agent_session_controls" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientMessageId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "previousGate" TEXT NOT NULL,
    "nextGate" TEXT NOT NULL,
    "controlRevision" INTEGER NOT NULL,
    "pausedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_session_controls_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_session_controls_identity_check" CHECK (
      octet_length("id") BETWEEN 1 AND 256
      AND octet_length("sessionId") BETWEEN 1 AND 256
      AND octet_length("userId") BETWEEN 1 AND 256
      AND octet_length("clientMessageId") BETWEEN 1 AND 256
      AND octet_length("fingerprint") BETWEEN 1 AND 256
    ),
    CONSTRAINT "agent_session_controls_operation_check"
      CHECK ("operation" IN ('pause', 'resume')),
    CONSTRAINT "agent_session_controls_gate_check"
      CHECK ("previousGate" IN ('open', 'user_paused') AND "nextGate" IN ('open', 'user_paused')),
    CONSTRAINT "agent_session_controls_revision_check"
      CHECK ("controlRevision" >= 0),
    CONSTRAINT "agent_session_controls_session_user_fkey"
      FOREIGN KEY ("sessionId", "userId") REFERENCES "agent_sessions"("id", "userId")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "agent_session_controls_user_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "agent_session_controls_sessionId_clientMessageId_key"
  ON "agent_session_controls"("sessionId", "clientMessageId");
CREATE INDEX "agent_session_controls_userId_createdAt_idx"
  ON "agent_session_controls"("userId", "createdAt" DESC);
CREATE INDEX "agent_session_controls_sessionId_createdAt_idx"
  ON "agent_session_controls"("sessionId", "createdAt" DESC);

CREATE OR REPLACE FUNCTION "prevent_agent_session_control_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'agent session controls are immutable';
END;
$$;

CREATE TRIGGER "agent_session_controls_immutable_update"
BEFORE UPDATE ON "agent_session_controls"
FOR EACH ROW
EXECUTE FUNCTION "prevent_agent_session_control_update"();

ALTER TABLE "agent_session_controls" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agent_session_controls_user_isolation"
  ON "agent_session_controls"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK ("userId" = NULLIF(current_setting('app.user_id', true), ''));

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "agent_session_controls" FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'applymate_candidate') THEN
    GRANT SELECT, INSERT ON TABLE "agent_session_controls" TO applymate_candidate;
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "agent_session_controls" FROM applymate_candidate;
  END IF;
END
$$;
