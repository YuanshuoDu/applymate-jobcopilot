-- New Root rows are explicitly opted into the output-token ledger. Existing
-- active Roots stay NULL and fail closed for strict output-token admission.
ALTER TABLE "sub_agent_tasks"
  ADD COLUMN "outputTokenReservationVersion" INTEGER,
  ADD CONSTRAINT "sub_agent_tasks_output_token_reservation_version_check"
    CHECK ("outputTokenReservationVersion" IS NULL OR "outputTokenReservationVersion" = 1);

ALTER TABLE "ai_usage_events"
  ADD COLUMN "output_reservation_required" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "provider_started_at" TIMESTAMP(3),
  ADD COLUMN "usage_start_protocol_version" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "ai_usage_events_start_protocol_version_check"
    CHECK ("usage_start_protocol_version" IN (0, 1)),
  ADD CONSTRAINT "ai_usage_events_started_requires_protocol_check"
    CHECK ("provider_started_at" IS NULL OR "usage_start_protocol_version" = 1);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'applymate_candidate') THEN
    GRANT UPDATE ("provider_started_at") ON TABLE "ai_usage_events" TO applymate_candidate;
  END IF;
END
$$;

CREATE TABLE "agent_root_usage_reservations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "rootTaskId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "executionOwnerKind" TEXT NOT NULL,
    "executionOwnerId" TEXT NOT NULL,
    "executionOwnerVersion" INTEGER NOT NULL,
    "attempt" INTEGER NOT NULL,
    "attemptId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "outputReservationRequired" BOOLEAN NOT NULL,
    "reservedOutputTokens" INTEGER NOT NULL,
    "actualOutputTokens" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "outcomeStatus" TEXT,
    "errorCode" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "agent_root_usage_reservations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_root_usage_reservations_identity_check" CHECK (
      octet_length("id") BETWEEN 1 AND 256
      AND octet_length("userId") BETWEEN 1 AND 256
      AND octet_length("sessionId") BETWEEN 1 AND 256
      AND octet_length("turnId") BETWEEN 1 AND 256
      AND octet_length("rootTaskId") BETWEEN 1 AND 256
      AND octet_length("taskId") BETWEEN 1 AND 256
      AND octet_length("stepId") BETWEEN 1 AND 256
      AND octet_length("executionOwnerId") BETWEEN 1 AND 256
      AND octet_length("attemptId") BETWEEN 1 AND 256
      AND octet_length("provider") BETWEEN 1 AND 256
      AND octet_length("model") BETWEEN 1 AND 512
      AND octet_length("idempotencyKey") BETWEEN 1 AND 256
      AND ("errorCode" IS NULL OR octet_length("errorCode") <= 64)
    ),
    CONSTRAINT "agent_root_usage_reservations_owner_check" CHECK (
      ("executionOwnerKind" = 'turn' AND "executionOwnerVersion" >= 0)
      OR ("executionOwnerKind" = 'task' AND "executionOwnerVersion" >= 1)
    ),
    CONSTRAINT "agent_root_usage_reservations_attempt_check" CHECK ("attempt" >= 1),
    CONSTRAINT "agent_root_usage_reservations_tokens_check" CHECK (
      "reservedOutputTokens" BETWEEN 0 AND 2147483647
      AND "outputReservationRequired" = ("reservedOutputTokens" > 0)
      AND ("actualOutputTokens" IS NULL OR "actualOutputTokens" BETWEEN 0 AND 2147483647)
    ),
    CONSTRAINT "agent_root_usage_reservations_status_check" CHECK (
      ("status" = 'reserved' AND "startedAt" IS NULL AND "settledAt" IS NULL AND "releasedAt" IS NULL
        AND "actualOutputTokens" IS NULL AND "outcomeStatus" IS NULL AND "errorCode" IS NULL)
      OR ("status" = 'started' AND "startedAt" IS NOT NULL AND "settledAt" IS NULL AND "releasedAt" IS NULL
        AND "actualOutputTokens" IS NULL AND ("outcomeStatus" IS NULL OR "outcomeStatus" IN ('success', 'error')))
      OR ("status" = 'settled' AND "startedAt" IS NOT NULL AND "settledAt" IS NOT NULL AND "releasedAt" IS NULL
        AND "actualOutputTokens" IS NOT NULL AND "outcomeStatus" IN ('success', 'error'))
      OR ("status" = 'released' AND "startedAt" IS NULL AND "settledAt" IS NULL AND "releasedAt" IS NOT NULL
        AND "actualOutputTokens" IS NULL AND "outcomeStatus" IS NULL AND "errorCode" IS NULL)
    )
);

CREATE UNIQUE INDEX "agent_root_usage_reservations_sessionId_idempotencyKey_key"
  ON "agent_root_usage_reservations"("sessionId", "idempotencyKey");
CREATE INDEX "agent_root_usage_reservations_userId_sessionId_turnId_rootTaskId_status_idx"
  ON "agent_root_usage_reservations"("userId", "sessionId", "turnId", "rootTaskId", "status");
CREATE INDEX "agent_root_usage_reservations_rootTaskId_status_createdAt_idx"
  ON "agent_root_usage_reservations"("rootTaskId", "status", "createdAt");

ALTER TABLE "agent_root_usage_reservations"
  ADD CONSTRAINT "agent_root_usage_reservations_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_root_usage_reservations_session_user_fkey"
    FOREIGN KEY ("sessionId", "userId") REFERENCES "agent_sessions"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_root_usage_reservations_turn_session_user_fkey"
    FOREIGN KEY ("turnId", "sessionId", "userId") REFERENCES "agent_turns"("id", "sessionId", "userId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_root_usage_reservations_root_task_session_fkey"
    FOREIGN KEY ("rootTaskId", "sessionId") REFERENCES "sub_agent_tasks"("id", "sessionId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_root_usage_reservations_task_session_fkey"
    FOREIGN KEY ("taskId", "sessionId") REFERENCES "sub_agent_tasks"("id", "sessionId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_root_usage_reservations_step_turn_session_fkey"
    FOREIGN KEY ("stepId", "turnId", "sessionId") REFERENCES "agent_steps"("id", "turnId", "sessionId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_root_usage_reservations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agent_root_usage_reservations_user_isolation"
  ON "agent_root_usage_reservations"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK ("userId" = NULLIF(current_setting('app.user_id', true), ''));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'applymate_candidate') THEN
    REVOKE UPDATE, DELETE ON TABLE "agent_root_usage_reservations" FROM applymate_candidate;
    GRANT SELECT, INSERT ON TABLE "agent_root_usage_reservations" TO applymate_candidate;
    GRANT UPDATE ("status", "actualOutputTokens", "outcomeStatus", "errorCode", "updatedAt", "startedAt", "settledAt", "releasedAt")
      ON TABLE "agent_root_usage_reservations" TO applymate_candidate;
  END IF;
END
$$;
