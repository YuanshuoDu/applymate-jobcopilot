-- AH2-041: durable idempotency ledger for the canonical application submit tool.

CREATE TYPE "SubmissionAttemptState" AS ENUM ('reserved', 'submitted', 'failed');

CREATE TABLE "submission_attempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "constraintHash" TEXT NOT NULL,
    "artifactHash" TEXT NOT NULL,
    "state" "SubmissionAttemptState" NOT NULL,
    "responseRef" TEXT,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "submission_attempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "submission_attempt_receiptId_key" ON "submission_attempt"("receiptId");
CREATE INDEX "submission_attempt_userId_jobId_state_idx" ON "submission_attempt"("userId", "jobId", "state");
