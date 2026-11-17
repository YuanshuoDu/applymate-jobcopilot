CREATE TYPE "agent_objective_start_attempt_status" AS ENUM ('accepted', 'abandoned');

CREATE TABLE "agent_objective_start_attempts" (
    "userId" TEXT NOT NULL,
    "clientMessageId" VARCHAR(256) NOT NULL,
    "status" "agent_objective_start_attempt_status" NOT NULL,
    "sessionId" TEXT,
    "requestHash" VARCHAR(64),
    "inputId" TEXT,
    "turnId" TEXT,
    "acceptedSequence" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_objective_start_attempts_pkey" PRIMARY KEY ("userId", "clientMessageId"),
    CONSTRAINT "agent_objective_start_attempts_payload_check" CHECK (
      ("status" = 'accepted'
        AND "sessionId" IS NOT NULL
        AND "requestHash" IS NOT NULL
        AND "requestHash" ~ '^[0-9a-f]{64}$'
        AND "inputId" IS NOT NULL
        AND "turnId" IS NOT NULL
        AND "acceptedSequence" IS NOT NULL
        AND "acceptedSequence" >= 0)
      OR
      ("status" = 'abandoned'
        AND "sessionId" IS NULL
        AND "requestHash" IS NULL
        AND "inputId" IS NULL
        AND "turnId" IS NULL
        AND "acceptedSequence" IS NULL)
    ),
    CONSTRAINT "agent_objective_start_attempts_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "agent_objective_start_attempts_userId_createdAt_idx"
  ON "agent_objective_start_attempts"("userId", "createdAt" DESC);

CREATE INDEX "agent_inputs_userId_clientMessageId_idx"
  ON "agent_inputs"("userId", "clientMessageId");
