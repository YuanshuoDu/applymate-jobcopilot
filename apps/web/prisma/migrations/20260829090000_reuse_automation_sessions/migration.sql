ALTER TABLE "agent_automations"
  ADD COLUMN "sessionId" TEXT;

CREATE UNIQUE INDEX "agent_automations_sessionId_key"
  ON "agent_automations"("sessionId");

-- Associate legacy automation runs with their automation before the new
-- session link becomes the source of truth. If a failed scheduler created
-- several rows, keep the most recently updated row as the report session.
WITH candidates AS (
  SELECT
    a."id" AS "automationId",
    s."id" AS "sessionId",
    ROW_NUMBER() OVER (
      PARTITION BY a."id"
      ORDER BY s."updatedAt" DESC, s."createdAt" DESC, s."id" DESC
    ) AS "rank"
  FROM "agent_automations" a
  JOIN "agent_sessions" s
    ON s."userId" = a."userId"
   AND s."source" = 'automation'
  JOIN "agent_transcript_events" e
    ON e."sessionId" = s."id"
   AND e."type" = 'automation_started'
   AND e."data"->>'automationId' = a."id"
  WHERE a."sessionId" IS NULL
)
UPDATE "agent_automations" a
SET "sessionId" = c."sessionId"
FROM candidates c
WHERE c."rank" = 1
  AND a."id" = c."automationId";

ALTER TABLE "agent_automations"
  ADD CONSTRAINT "agent_automations_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "agent_sessions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
