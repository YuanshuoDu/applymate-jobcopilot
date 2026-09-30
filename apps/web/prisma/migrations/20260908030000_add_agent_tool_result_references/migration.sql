-- #495: durable private tool results and wait-condition intent.
-- Tool-result content is redacted JSON and is never emitted as a public event.

-- These scoped keys let the additive records prove that their denormalized
-- tenant/session/turn/step columns describe the same existing rows.
CREATE UNIQUE INDEX "agent_sessions_id_userId_key"
  ON "agent_sessions"("id", "userId");
CREATE UNIQUE INDEX "agent_turns_id_sessionId_userId_key"
  ON "agent_turns"("id", "sessionId", "userId");
CREATE UNIQUE INDEX "agent_steps_id_turnId_sessionId_key"
  ON "agent_steps"("id", "turnId", "sessionId");

CREATE TABLE "agent_tool_result_references" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "toolCallId" TEXT NOT NULL,
    "sanitizedJson" JSONB NOT NULL,
    "sha256" TEXT NOT NULL,
    "byteCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_tool_result_references_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_tool_result_references_identity_check" CHECK (
      octet_length("id") BETWEEN 1 AND 256
      AND octet_length("userId") BETWEEN 1 AND 256
      AND octet_length("sessionId") BETWEEN 1 AND 256
      AND octet_length("turnId") BETWEEN 1 AND 256
      AND octet_length("stepId") BETWEEN 1 AND 256
      AND octet_length("taskId") BETWEEN 1 AND 256
      AND octet_length("toolCallId") BETWEEN 1 AND 256
    ),
    CONSTRAINT "agent_tool_result_references_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "agent_tool_result_references_byteCount_check" CHECK (
      "byteCount" >= 0 AND "byteCount" <= 1048576
      -- The Worker enforces the 1 MiB canonical UTF-8 limit. JSONB::text is
      -- PostgreSQL's storage serialization and may add formatting overhead,
      -- so keep a finite 2 MiB database guard without reimplementing it.
      AND octet_length("sanitizedJson"::text) <= 2097152
    )
);

CREATE UNIQUE INDEX "agent_tool_result_references_stepId_toolCallId_key"
  ON "agent_tool_result_references"("stepId", "toolCallId");
CREATE INDEX "agent_tool_result_references_userId_sessionId_turnId_taskId_idx"
  ON "agent_tool_result_references"("userId", "sessionId", "turnId", "taskId");
CREATE INDEX "agent_tool_result_references_sessionId_taskId_createdAt_idx"
  ON "agent_tool_result_references"("sessionId", "taskId", "createdAt");

ALTER TABLE "agent_tool_result_references"
  ADD CONSTRAINT "agent_tool_result_references_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_tool_result_references_sessionId_fkey"
    FOREIGN KEY ("sessionId", "userId") REFERENCES "agent_sessions"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_tool_result_references_turnId_sessionId_fkey"
    FOREIGN KEY ("turnId", "sessionId", "userId") REFERENCES "agent_turns"("id", "sessionId", "userId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_tool_result_references_stepId_fkey"
    FOREIGN KEY ("stepId", "turnId", "sessionId") REFERENCES "agent_steps"("id", "turnId", "sessionId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_tool_result_references_taskId_sessionId_fkey"
    FOREIGN KEY ("taskId", "sessionId") REFERENCES "sub_agent_tasks"("id", "sessionId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "agent_wait_conditions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "parentTaskId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "targetTaskIds" JSONB NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "matchedTaskIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "agent_wait_conditions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_wait_conditions_identity_check" CHECK (
      octet_length("id") BETWEEN 1 AND 256
      AND octet_length("userId") BETWEEN 1 AND 256
      AND octet_length("sessionId") BETWEEN 1 AND 256
      AND octet_length("turnId") BETWEEN 1 AND 256
      AND octet_length("parentTaskId") BETWEEN 1 AND 256
      AND octet_length("stepId") BETWEEN 1 AND 256
      AND octet_length("idempotencyKey") BETWEEN 1 AND 256
    ),
    CONSTRAINT "agent_wait_conditions_mode_check" CHECK ("mode" IN ('all', 'any')),
    CONSTRAINT "agent_wait_conditions_status_check" CHECK ("status" IN ('waiting', 'ready', 'timed_out', 'interrupted', 'closed')),
    CONSTRAINT "agent_wait_conditions_targetTaskIds_check" CHECK (
      CASE WHEN jsonb_typeof("targetTaskIds") = 'array'
        THEN jsonb_array_length("targetTaskIds") BETWEEN 1 AND 8
        ELSE false
      END
    ),
    CONSTRAINT "agent_wait_conditions_matchedTaskIds_check" CHECK (
      CASE WHEN jsonb_typeof("matchedTaskIds") = 'array'
        THEN jsonb_array_length("matchedTaskIds") BETWEEN 0 AND 8
        ELSE false
      END
    ),
    CONSTRAINT "agent_wait_conditions_deadline_check" CHECK (
      "deadlineAt" >= "createdAt"
      AND "deadlineAt" <= "createdAt" + INTERVAL '24 hours'
    )
);

CREATE UNIQUE INDEX "agent_wait_conditions_parentTaskId_idempotencyKey_key"
  ON "agent_wait_conditions"("parentTaskId", "idempotencyKey");
CREATE INDEX "agent_wait_conditions_sessionId_turnId_status_idx"
  ON "agent_wait_conditions"("sessionId", "turnId", "status");
CREATE INDEX "agent_wait_conditions_sessionId_deadlineAt_idx"
  ON "agent_wait_conditions"("sessionId", "deadlineAt");

ALTER TABLE "agent_wait_conditions"
  ADD CONSTRAINT "agent_wait_conditions_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_wait_conditions_sessionId_fkey"
    FOREIGN KEY ("sessionId", "userId") REFERENCES "agent_sessions"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_wait_conditions_turnId_sessionId_fkey"
    FOREIGN KEY ("turnId", "sessionId", "userId") REFERENCES "agent_turns"("id", "sessionId", "userId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_wait_conditions_parentTaskId_sessionId_fkey"
    FOREIGN KEY ("parentTaskId", "sessionId") REFERENCES "sub_agent_tasks"("id", "sessionId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_wait_conditions_stepId_fkey"
    FOREIGN KEY ("stepId", "turnId", "sessionId") REFERENCES "agent_steps"("id", "turnId", "sessionId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Match the repository's tenant policy shape. The Worker sets app.user_id
-- transaction-locally before every read/write transaction.
ALTER TABLE "agent_tool_result_references" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_wait_conditions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_tool_result_reference_user_isolation
  ON "agent_tool_result_references"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY agent_wait_condition_user_isolation
  ON "agent_wait_conditions"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK ("userId" = NULLIF(current_setting('app.user_id', true), ''));
