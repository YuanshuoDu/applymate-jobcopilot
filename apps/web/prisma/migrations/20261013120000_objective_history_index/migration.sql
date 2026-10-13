BEGIN;

ALTER TABLE "agent_turns"
  ADD COLUMN "objectiveDigest" VARCHAR(64),
  ADD COLUMN "canonicalOriginDigest" VARCHAR(64),
  ADD COLUMN "objectiveIndexSemanticsVersion" INTEGER,
  ADD COLUMN "terminalEventSequence" BIGINT,
  ADD COLUMN "terminalEventAt" TIMESTAMP(3);

CREATE INDEX "agent_turns_objective_history_session_idx"
  ON "agent_turns" (
    "sessionId",
    "objectiveIndexSemanticsVersion",
    "objectiveDigest",
    "terminalEventSequence" DESC
  );

CREATE INDEX "agent_turns_objective_history_cross_session_idx"
  ON "agent_turns" (
    "userId",
    "objectiveIndexSemanticsVersion",
    "objectiveDigest",
    "canonicalOriginDigest",
    "terminalEventAt" DESC,
    "id" DESC
  );

CREATE TABLE "agent_objective_history_index_readiness" (
  "indexName" VARCHAR(64) NOT NULL,
  "semanticsVersion" INTEGER NOT NULL,
  "isReady" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_objective_history_index_readiness_pkey"
    PRIMARY KEY ("indexName", "semanticsVersion")
);

INSERT INTO "agent_objective_history_index_readiness" (
  "indexName",
  "semanticsVersion",
  "isReady"
)
VALUES ('agent_turns_objective_history', 1, FALSE);

COMMIT;
