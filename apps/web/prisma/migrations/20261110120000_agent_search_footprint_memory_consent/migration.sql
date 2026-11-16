ALTER TABLE "User"
  ADD COLUMN "agentSearchFootprintMemoryEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "agentSearchFootprintMemoryConsentVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "agent_sessions"
  ADD COLUMN "searchFootprintMemoryEnabledAtCreation" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "searchFootprintMemoryConsentVersionAtCreation" INTEGER NOT NULL DEFAULT 0;
