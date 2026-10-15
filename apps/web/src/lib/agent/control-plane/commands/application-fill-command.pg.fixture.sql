CREATE TABLE "agent_sessions" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "eventSequence" BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE "agent_turns" (
  "id" TEXT PRIMARY KEY,
  "sessionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "source" TEXT NOT NULL,
  "input" JSONB NOT NULL,
  "modelProfileSnapshot" JSONB NOT NULL,
  "toolPolicySnapshot" JSONB NOT NULL,
  "budgetSnapshot" JSONB NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_turns_id_session_user_key" UNIQUE ("id", "sessionId", "userId")
);

CREATE TABLE "Job" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL
);

CREATE TABLE "Resume" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "targetJobId" TEXT,
  "isDefault" BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE "CoverLetter" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "resumeId" TEXT
);

CREATE TABLE "application_tasks" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "sessionId" TEXT,
  "resumeId" TEXT,
  "coverLetterId" TEXT,
  "fillTurnId" TEXT UNIQUE,
  "fillTurnSessionId" TEXT,
  "fillTurnUserId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'discovered',
  "checkpoint" TEXT,
  "confirmedAnswers" JSONB,
  "error" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "application_tasks_fill_turn_binding_check" CHECK (
    ("fillTurnId" IS NULL AND "fillTurnSessionId" IS NULL AND "fillTurnUserId" IS NULL)
    OR ("fillTurnId" IS NOT NULL AND "fillTurnSessionId" IS NOT NULL AND "fillTurnUserId" IS NOT NULL
      AND "fillTurnSessionId" = "sessionId" AND "fillTurnUserId" = "userId")
  ),
  CONSTRAINT "application_tasks_fill_turn_scope_key" UNIQUE ("fillTurnId", "fillTurnSessionId", "fillTurnUserId"),
  CONSTRAINT "application_tasks_fill_turn_fkey" FOREIGN KEY ("fillTurnId", "fillTurnSessionId", "fillTurnUserId")
    REFERENCES "agent_turns" ("id", "sessionId", "userId") ON DELETE SET NULL
);

CREATE TABLE "sub_agent_tasks" (
  "id" TEXT PRIMARY KEY,
  "sessionId" TEXT NOT NULL,
  "turnId" TEXT,
  "role" TEXT NOT NULL,
  "taskType" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "interruptRequestedAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "agent_executions" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "checkpoint" TEXT,
  "cancelledAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "agent_approvals" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "turnId" TEXT,
  "taskId" TEXT,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "scopeHash" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "decidedAt" TIMESTAMP(3)
);

CREATE TABLE "AgentRunQuestion" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "answer" TEXT
);

CREATE TABLE "application_task_events" (
  "id" TEXT PRIMARY KEY,
  "taskId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "data" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "agent_inputs" (
  "id" TEXT PRIMARY KEY,
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
  CONSTRAINT "agent_inputs_session_client_message_key" UNIQUE ("sessionId", "clientMessageId")
);

CREATE TABLE "agent_items" (
  "id" TEXT PRIMARY KEY,
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
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "agent_events" (
  "id" TEXT PRIMARY KEY,
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
  CONSTRAINT "agent_events_session_sequence_key" UNIQUE ("sessionId", "sequence"),
  CONSTRAINT "agent_events_session_idempotency_key" UNIQUE ("sessionId", "idempotencyKey")
);

CREATE TABLE "agent_outbox" (
  "id" TEXT PRIMARY KEY,
  "topic" TEXT NOT NULL,
  "aggregateId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "payload" JSONB NOT NULL,
  "publishedAt" TIMESTAMP(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
