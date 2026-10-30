ALTER TABLE "User"
  ADD COLUMN "agentTaskHistoryMemoryEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "agentTaskHistoryMemoryConsentVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "User"
  ADD CONSTRAINT "User_agentTaskHistoryMemoryConsentVersion_nonnegative"
  CHECK ("agentTaskHistoryMemoryConsentVersion" >= 0);
