-- AH2-019: additive scoped approval receipts and atomic external-action reservations.
-- Existing legacy approvals remain readable; only new receipts require the
-- non-null scope fields at the application boundary.

ALTER TABLE "agent_approvals"
  ADD COLUMN "turnId" TEXT,
  ADD COLUMN "toolCallId" TEXT,
  ADD COLUMN "jobId" TEXT,
  ADD COLUMN "resourceHash" TEXT,
  ADD COLUMN "materialHash" TEXT,
  ADD COLUMN "answersHash" TEXT,
  ADD COLUMN "scopeHash" TEXT,
  ADD COLUMN "nonceHash" TEXT,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "consumedAt" TIMESTAMP(3),
  ADD CONSTRAINT "agent_approvals_revision_check" CHECK ("revision" >= 0),
  ADD CONSTRAINT "agent_approvals_scope_columns_check" CHECK (
    ("turnId" IS NULL AND "toolCallId" IS NULL AND "jobId" IS NULL AND
     "resourceHash" IS NULL AND "materialHash" IS NULL AND "answersHash" IS NULL AND
     "scopeHash" IS NULL AND "nonceHash" IS NULL AND "expiresAt" IS NULL)
    OR
    ("turnId" IS NOT NULL AND "toolCallId" IS NOT NULL AND "jobId" IS NOT NULL AND
     "resourceHash" IS NOT NULL AND "materialHash" IS NOT NULL AND "answersHash" IS NOT NULL AND
     "scopeHash" IS NOT NULL AND "nonceHash" IS NOT NULL AND "expiresAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "agent_approvals_hash_format_check" CHECK (
    ("resourceHash" IS NULL OR "resourceHash" ~ '^[a-f0-9]{64}$') AND
    ("materialHash" IS NULL OR "materialHash" ~ '^[a-f0-9]{64}$') AND
    ("answersHash" IS NULL OR "answersHash" ~ '^[a-f0-9]{64}$') AND
    ("scopeHash" IS NULL OR "scopeHash" ~ '^[a-f0-9]{64}$') AND
    ("nonceHash" IS NULL OR "nonceHash" ~ '^[a-f0-9]{64}$')
  );

CREATE TABLE "agent_action_reservations" (
    "id" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "toolCallId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceHash" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_action_reservations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_action_reservations_status_check" CHECK ("status" IN ('reserved', 'executing', 'completed', 'failed', 'uncertain', 'released'))
);

CREATE UNIQUE INDEX "agent_approvals_userId_nonceHash_key"
  ON "agent_approvals"("userId", "nonceHash");
CREATE UNIQUE INDEX "agent_action_reservations_idempotencyKey_key"
  ON "agent_action_reservations"("idempotencyKey");
CREATE UNIQUE INDEX "agent_action_reservations_approvalId_key"
  ON "agent_action_reservations"("approvalId");
CREATE INDEX "agent_approvals_userId_status_expiresAt_idx"
  ON "agent_approvals"("userId", "status", "expiresAt");
CREATE INDEX "agent_approvals_sessionId_turnId_status_idx"
  ON "agent_approvals"("sessionId", "turnId", "status");
CREATE INDEX "agent_action_reservations_userId_status_createdAt_idx"
  ON "agent_action_reservations"("userId", "status", "createdAt");
CREATE INDEX "agent_action_reservations_sessionId_turnId_status_idx"
  ON "agent_action_reservations"("sessionId", "turnId", "status");

ALTER TABLE "agent_approvals"
  ADD CONSTRAINT "agent_approvals_turnId_fkey"
  FOREIGN KEY ("turnId") REFERENCES "agent_turns"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_approvals_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_action_reservations"
  ADD CONSTRAINT "agent_action_reservations_approvalId_fkey"
  FOREIGN KEY ("approvalId") REFERENCES "agent_approvals"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_action_reservations_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "agent_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_action_reservations_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
