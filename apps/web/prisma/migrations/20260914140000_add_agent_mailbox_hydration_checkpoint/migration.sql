-- P4-68A: durable, server-owned child mailbox hydration checkpoints.
-- Checkpoints are immutable append-only facts. Hydration reads existing rows,
-- inserts missing facts idempotently, and never mutates mailbox delivery state.

CREATE UNIQUE INDEX "agent_mailbox_messages_id_sessionId_key"
  ON "agent_mailbox_messages"("id", "sessionId");

CREATE TABLE "agent_mailbox_hydration_checkpoints" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "rootTaskId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "stepId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_mailbox_hydration_checkpoints_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_mailbox_hydration_checkpoints_identity_check" CHECK (
      octet_length("id") BETWEEN 1 AND 256
      AND octet_length("userId") BETWEEN 1 AND 256
      AND octet_length("sessionId") BETWEEN 1 AND 256
      AND octet_length("turnId") BETWEEN 1 AND 256
      AND octet_length("rootTaskId") BETWEEN 1 AND 256
      AND octet_length("taskId") BETWEEN 1 AND 256
      AND octet_length("stepId") BETWEEN 1 AND 256
      AND octet_length("messageId") BETWEEN 1 AND 256
    ),
    CONSTRAINT "agent_mailbox_hydration_checkpoints_attempt_check"
      CHECK ("attempt" BETWEEN 1 AND 2147483647),
    CONSTRAINT "agent_mailbox_hydration_checkpoints_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "agent_mb_hydration_session_user_fkey"
      FOREIGN KEY ("sessionId", "userId") REFERENCES "agent_sessions"("id", "userId")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "agent_mb_hydration_turn_session_user_fkey"
      FOREIGN KEY ("turnId", "sessionId", "userId") REFERENCES "agent_turns"("id", "sessionId", "userId")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "agent_mb_hydration_root_task_fkey"
      FOREIGN KEY ("rootTaskId", "sessionId") REFERENCES "sub_agent_tasks"("id", "sessionId")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "agent_mb_hydration_task_fkey"
      FOREIGN KEY ("taskId", "sessionId") REFERENCES "sub_agent_tasks"("id", "sessionId")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "agent_mb_hydration_step_turn_session_fkey"
      FOREIGN KEY ("stepId", "turnId", "sessionId") REFERENCES "agent_steps"("id", "turnId", "sessionId")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "agent_mb_hydration_message_session_fkey"
      FOREIGN KEY ("messageId", "sessionId") REFERENCES "agent_mailbox_messages"("id", "sessionId")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "agent_mb_hydration_scope_key"
  ON "agent_mailbox_hydration_checkpoints"("sessionId", "taskId", "attempt", "messageId");
CREATE INDEX "agent_mailbox_hydration_checkpoints_userId_createdAt_idx"
  ON "agent_mailbox_hydration_checkpoints"("userId", "createdAt");
CREATE INDEX "agent_mb_hydration_session_turn_created_idx"
  ON "agent_mailbox_hydration_checkpoints"("sessionId", "turnId", "createdAt");
CREATE INDEX "agent_mb_hydration_session_task_attempt_created_idx"
  ON "agent_mailbox_hydration_checkpoints"("sessionId", "taskId", "attempt", "createdAt");
CREATE INDEX "agent_mb_hydration_lineage_created_idx"
  ON "agent_mailbox_hydration_checkpoints"("sessionId", "rootTaskId", "taskId", "attempt", "stepId", "createdAt");

ALTER TABLE "agent_mailbox_hydration_checkpoints" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agent_mailbox_hydration_checkpoints_user_isolation"
  ON "agent_mailbox_hydration_checkpoints"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK ("userId" = NULLIF(current_setting('app.user_id', true), ''));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'applymate_candidate') THEN
    GRANT SELECT, INSERT ON TABLE "agent_mailbox_hydration_checkpoints" TO applymate_candidate;
    REVOKE UPDATE, DELETE ON TABLE "agent_mailbox_hydration_checkpoints" FROM applymate_candidate;
  END IF;
END
$$;
