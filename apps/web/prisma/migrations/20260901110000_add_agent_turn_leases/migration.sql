-- AH2-022: database-owned Turn execution lease.
-- This migration is additive. A lease is a fencing token: the owner and
-- version must match on every renewal/release, so duplicate queue delivery
-- cannot execute the same Turn concurrently.

ALTER TABLE "agent_turns"
  ADD COLUMN "leaseOwnerId" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "leaseStartedAt" TIMESTAMP(3),
  ADD COLUMN "leaseVersion" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "agent_turns_leaseVersion_check" CHECK ("leaseVersion" >= 0);

CREATE INDEX "agent_turns_status_leaseExpiresAt_idx"
  ON "agent_turns"("status", "leaseExpiresAt");
