ALTER TABLE "agent_turns"
  ADD COLUMN "executionMode" TEXT,
  ADD CONSTRAINT "agent_turns_execution_mode_check"
    CHECK ("executionMode" IS NULL OR "executionMode" IN ('canonical_task_graph', 'legacy_pipeline_adapter'));

UPDATE "agent_turns" AS turn
SET "executionMode" = 'canonical_task_graph'
WHERE EXISTS (
  SELECT 1
  FROM "agent_outbox" AS dispatch
  WHERE dispatch."topic" = 'agent.turn.dispatch'
    AND dispatch."aggregateId" = turn."sessionId"
    AND dispatch."idempotencyKey" = 'turn-dispatch:' || turn."id"
    AND dispatch."payload"->>'turnId' = turn."id"
    AND dispatch."payload"->>'sessionId' = turn."sessionId'
)
AND NOT EXISTS (
  SELECT 1
  FROM "agent_items" AS item
  WHERE item."sessionId" = turn."sessionId"
    AND item."turnId" = turn."id"
    AND item."type" = 'tool_call'
    AND item."content"->>'toolName' = 'pipeline.run'
);
