ALTER TABLE "agent_turns"
  ADD COLUMN "native_semantic_progress_mode" TEXT,
  ADD CONSTRAINT "agent_turns_native_semantic_progress_mode_check"
    CHECK ("native_semantic_progress_mode" IS NULL OR "native_semantic_progress_mode" IN ('legacy_v1', 'durable_v1'));

CREATE TABLE "agent_native_semantic_rejections" (
  "userId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "turnId" TEXT NOT NULL,
  "rootTaskId" TEXT NOT NULL,
  "stepId" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL,
  "inputThroughSequence" BIGINT NOT NULL,
  "candidateDigest" TEXT NOT NULL,
  "controlTaskId" TEXT NOT NULL,
  "controlOperationId" TEXT NOT NULL,
  "controlAttempt" INTEGER NOT NULL,
  "controlReportDigest" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_native_semantic_rejections_pkey" PRIMARY KEY ("turnId", "stepId"),
  CONSTRAINT "agent_native_semantic_rejections_identity_check" CHECK (
    char_length("userId") BETWEEN 1 AND 256
    AND char_length("sessionId") BETWEEN 1 AND 256
    AND char_length("turnId") BETWEEN 1 AND 256
    AND char_length("rootTaskId") BETWEEN 1 AND 256
    AND char_length("stepId") BETWEEN 1 AND 256
    AND char_length("controlTaskId") BETWEEN 1 AND 256
    AND char_length("controlOperationId") BETWEEN 1 AND 256
  ),
  CONSTRAINT "agent_native_semantic_rejections_attempt_check" CHECK ("attempt" >= 1 AND "controlAttempt" >= 1),
  CONSTRAINT "agent_native_semantic_rejections_input_sequence_check" CHECK ("inputThroughSequence" >= 0),
  CONSTRAINT "agent_native_semantic_rejections_candidate_digest_check" CHECK ("candidateDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "agent_native_semantic_rejections_report_digest_check" CHECK ("controlReportDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "agent_native_semantic_rejections_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "agent_native_semantic_rejections_session_user_fkey"
    FOREIGN KEY ("sessionId", "userId") REFERENCES "agent_sessions"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "agent_native_semantic_rejections_turn_fkey"
    FOREIGN KEY ("turnId", "sessionId", "userId") REFERENCES "agent_turns"("id", "sessionId", "userId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "agent_native_semantic_rejections_root_task_fkey"
    FOREIGN KEY ("rootTaskId", "sessionId") REFERENCES "sub_agent_tasks"("id", "sessionId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "agent_native_semantic_rejections_control_task_fkey"
    FOREIGN KEY ("controlTaskId", "sessionId") REFERENCES "sub_agent_tasks"("id", "sessionId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "agent_native_semantic_rejections_step_fkey"
    FOREIGN KEY ("stepId", "turnId", "sessionId") REFERENCES "agent_steps"("id", "turnId", "sessionId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "agent_native_semantic_rejections_lookup_idx"
  ON "agent_native_semantic_rejections" (
    "userId", "turnId", "candidateDigest", "controlReportDigest", "inputThroughSequence"
  );

ALTER TABLE "agent_native_semantic_rejections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_native_semantic_rejections_user_isolation
  ON "agent_native_semantic_rejections"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK ("userId" = NULLIF(current_setting('app.user_id', true), ''));
