ALTER TABLE "agent_sessions"
  ADD COLUMN "sessionControlRecoveryClaimToken" TEXT,
  ADD COLUMN "sessionControlRecoveryClaimExpiresAt" TIMESTAMP(3);
