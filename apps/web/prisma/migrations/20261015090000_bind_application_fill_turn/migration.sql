ALTER TABLE "application_tasks"
  ADD COLUMN "fillTurnId" TEXT,
  ADD COLUMN "fillTurnSessionId" TEXT,
  ADD COLUMN "fillTurnUserId" TEXT;

CREATE UNIQUE INDEX "application_tasks_fillTurnId_key"
  ON "application_tasks"("fillTurnId");

CREATE UNIQUE INDEX "application_tasks_fillTurnId_fillTurnSessionId_fillTurnUserId_key"
  ON "application_tasks"("fillTurnId", "fillTurnSessionId", "fillTurnUserId");

ALTER TABLE "application_tasks"
  ADD CONSTRAINT "application_tasks_fill_turn_binding_check"
    CHECK (
      ("fillTurnId" IS NULL AND "fillTurnSessionId" IS NULL AND "fillTurnUserId" IS NULL)
      OR ("fillTurnId" IS NOT NULL AND "fillTurnSessionId" IS NOT NULL AND "fillTurnUserId" IS NOT NULL
        AND "fillTurnSessionId" = "sessionId" AND "fillTurnUserId" = "userId")
    ),
  ADD CONSTRAINT "application_tasks_fill_turn_fkey"
    FOREIGN KEY ("fillTurnId", "fillTurnSessionId", "fillTurnUserId")
    REFERENCES "agent_turns"("id", "sessionId", "userId")
    ON DELETE SET NULL ("fillTurnId", "fillTurnSessionId", "fillTurnUserId")
    ON UPDATE CASCADE;
