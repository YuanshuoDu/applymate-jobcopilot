ALTER TABLE "sub_agent_tasks"
  ADD COLUMN IF NOT EXISTS "absoluteDeadlineAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "leaseSegmentStartedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "sub_agent_tasks_status_absoluteDeadlineAt_idx"
  ON "sub_agent_tasks"("status", "absoluteDeadlineAt");

WITH valid_graph_items AS MATERIALIZED (
  SELECT item."sessionId", item."turnId", item."taskId" AS "parentTaskId",
    parent."rootTaskId", item."content"
  FROM "agent_items" AS item
  JOIN "sub_agent_tasks" AS parent
    ON parent."id" = item."taskId" AND parent."sessionId" = item."sessionId"
      AND parent."turnId" = item."turnId"
  JOIN "sub_agent_tasks" AS root
    ON root."id" = parent."rootTaskId" AND root."sessionId" = parent."sessionId"
      AND root."turnId" = parent."turnId" AND root."rootTaskId" = root."id"
      AND parent."id" = root."id"
      AND root."parentTaskId" IS NULL AND root."role" = 'orchestrator' AND root."taskType" = 'root'
  JOIN "agent_turns" AS turn
    ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
      AND turn."rootTaskId" = root."id"
  JOIN "agent_sessions" AS session
    ON session."id" = item."sessionId" AND session."userId" = turn."userId"
  WHERE item."id" = 'task-graph-' || encode(sha256(convert_to(parent."id", 'UTF8')), 'hex')
    AND item."type" = 'task_graph'
    AND (turn."source" <> 'automation' OR turn."executionMode" = 'canonical_task_graph')
    AND jsonb_typeof(item."content") = 'object'
    AND item."content"->>'schemaVersion' = 'agent-harness.v2.task-graph'
    AND jsonb_typeof(item."content"->'nodes') = 'array'
    AND jsonb_array_length(CASE WHEN jsonb_typeof(item."content"->'nodes') = 'array'
      THEN item."content"->'nodes' ELSE '[]'::jsonb END) <= 8
    AND (
      CASE WHEN jsonb_typeof(item."content") = 'object' THEN
        (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(item."content") AS keys(key))
      ELSE ARRAY[]::text[] END = ARRAY['nodes', 'schemaVersion']::text[]
      OR CASE WHEN jsonb_typeof(item."content") = 'object' THEN
        (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(item."content") AS keys(key))
      ELSE ARRAY[]::text[] END = ARRAY['nodes', 'rootSuccessCriteria', 'schemaVersion']::text[]
    )
    AND (
      NOT (item."content" ? 'rootSuccessCriteria')
      OR (
        jsonb_typeof(item."content"->'rootSuccessCriteria') = 'array'
        AND jsonb_array_length(CASE WHEN jsonb_typeof(item."content"->'rootSuccessCriteria') = 'array'
          THEN item."content"->'rootSuccessCriteria' ELSE '[]'::jsonb END) BETWEEN 1 AND 5
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(item."content"->'rootSuccessCriteria') = 'array'
            THEN item."content"->'rootSuccessCriteria' ELSE '[]'::jsonb END) WITH ORDINALITY AS criterion(value, ordinal)
          WHERE jsonb_typeof(criterion.value) <> 'string'
            OR criterion.value #>> '{}' = ''
            OR criterion.value #>> '{}' <> btrim(criterion.value #>> '{}')
            OR octet_length(criterion.value #>> '{}') > CASE WHEN criterion.ordinal = 1 THEN 2000 ELSE 512 END
        )
        AND (SELECT COUNT(DISTINCT criterion.value #>> '{}')
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(item."content"->'rootSuccessCriteria') = 'array'
            THEN item."content"->'rootSuccessCriteria' ELSE '[]'::jsonb END) AS criterion(value))
          = jsonb_array_length(CASE WHEN jsonb_typeof(item."content"->'rootSuccessCriteria') = 'array'
            THEN item."content"->'rootSuccessCriteria' ELSE '[]'::jsonb END)
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(item."content"->'nodes') = 'array'
        THEN item."content"->'nodes' ELSE '[]'::jsonb END) AS node(value)
      WHERE CASE WHEN jsonb_typeof(node.value) = 'object' THEN (
        (
          (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(node.value) AS keys(key))
            = ARRAY['dependsOn', 'depth', 'goal', 'key', 'successCriteria', 'taskId', 'templateId']::text[]
          OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(node.value) AS keys(key))
            = ARRAY['dependsOn', 'depth', 'goal', 'key', 'successCriteria', 'taskId', 'templateId', 'verificationDisposition']::text[]
          OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(node.value) AS keys(key))
            = ARRAY['dependsOn', 'depth', 'goal', 'key', 'successCriteria', 'taskId', 'templateId', 'verification', 'verificationDisposition']::text[]
          OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(node.value) AS keys(key))
            = ARRAY['dependsOn', 'depth', 'goal', 'key', 'registeredScoutEnvelope', 'successCriteria', 'taskId', 'templateId', 'verification', 'verificationDisposition']::text[]
          OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(node.value) AS keys(key))
            = ARRAY['dependsOn', 'depth', 'goal', 'key', 'repairOf', 'successCriteria', 'taskId', 'templateId', 'verification', 'verificationDisposition']::text[]
          OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(node.value) AS keys(key))
            = ARRAY['dependsOn', 'depth', 'goal', 'key', 'registeredScoutEnvelope', 'repairOf', 'successCriteria', 'taskId', 'templateId', 'verification', 'verificationDisposition']::text[]
          OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(node.value) AS keys(key))
            = ARRAY['dependsOn', 'depth', 'goal', 'key', 'nativeDelegation', 'successCriteria', 'taskId', 'templateId', 'verificationDisposition']::text[]
        )
        AND jsonb_typeof(node.value->'key') = 'string' AND btrim(node.value->>'key') <> '' AND length(node.value->>'key') <= 128
        AND jsonb_typeof(node.value->'templateId') = 'string' AND btrim(node.value->>'templateId') <> '' AND length(node.value->>'templateId') <= 128
        AND jsonb_typeof(node.value->'goal') = 'string' AND btrim(node.value->>'goal') <> ''
        AND length(node.value->>'goal') <= CASE WHEN node.value ? 'nativeDelegation' THEN 4000 ELSE 1200 END
        AND jsonb_typeof(node.value->'taskId') = 'string' AND btrim(node.value->>'taskId') <> '' AND length(node.value->>'taskId') <= 128
        AND jsonb_typeof(node.value->'depth') = 'number' AND node.value->>'depth' ~ '^[1-8]$'
        AND jsonb_typeof(node.value->'successCriteria') = 'array'
        AND jsonb_array_length(CASE WHEN jsonb_typeof(node.value->'successCriteria') = 'array'
          THEN node.value->'successCriteria' ELSE '[]'::jsonb END) <= CASE WHEN node.value ? 'nativeDelegation' THEN 32 ELSE 8 END
        AND (node.value ? 'nativeDelegation' OR jsonb_array_length(CASE WHEN jsonb_typeof(node.value->'successCriteria') = 'array'
          THEN node.value->'successCriteria' ELSE '[]'::jsonb END) > 0)
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(node.value->'successCriteria') = 'array'
            THEN node.value->'successCriteria' ELSE '[]'::jsonb END) AS criterion(value)
          WHERE jsonb_typeof(criterion.value) <> 'string' OR btrim(criterion.value #>> '{}') = ''
            OR length(criterion.value #>> '{}') > CASE WHEN node.value ? 'nativeDelegation' THEN 1000 ELSE 320 END
        )
        AND jsonb_typeof(node.value->'dependsOn') = 'array'
        AND jsonb_array_length(CASE WHEN jsonb_typeof(node.value->'dependsOn') = 'array'
          THEN node.value->'dependsOn' ELSE '[]'::jsonb END) <= 8
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(node.value->'dependsOn') = 'array'
            THEN node.value->'dependsOn' ELSE '[]'::jsonb END) AS dependency(value)
          WHERE jsonb_typeof(dependency.value) <> 'string' OR btrim(dependency.value #>> '{}') = ''
            OR length(dependency.value #>> '{}') > 128
        )
        AND (NOT (node.value ? 'verificationDisposition') OR node.value->>'verificationDisposition' IN ('typed', 'legacy_unverified', 'specialized'))
        AND (NOT (node.value ? 'verification') OR jsonb_typeof(node.value->'verification') = 'object')
        AND (NOT (node.value ? 'repairOf') OR jsonb_typeof(node.value->'repairOf') = 'object')
        AND (NOT (node.value ? 'nativeDelegation') OR jsonb_typeof(node.value->'nativeDelegation') = 'object')
        AND (NOT (node.value ? 'registeredScoutEnvelope') OR (
          node.value->>'templateId' = 'scout' AND node.value->>'verificationDisposition' = 'typed'
          AND jsonb_typeof(node.value->'registeredScoutEnvelope') = 'object'
          AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(
            CASE WHEN jsonb_typeof(node.value->'registeredScoutEnvelope') = 'object'
              THEN node.value->'registeredScoutEnvelope' ELSE '{}'::jsonb END) AS keys(key))
            = ARRAY['allowedActions', 'expectedOutputSchema', 'role', 'taskType']::text[]
          AND node.value->'registeredScoutEnvelope'->>'role' = 'scout'
          AND jsonb_typeof(node.value->'registeredScoutEnvelope'->'taskType') = 'string'
          AND btrim(node.value->'registeredScoutEnvelope'->>'taskType') <> ''
          AND length(node.value->'registeredScoutEnvelope'->>'taskType') <= 128
          AND jsonb_typeof(node.value->'registeredScoutEnvelope'->'expectedOutputSchema') = 'object'
          AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(
            CASE WHEN jsonb_typeof(node.value->'registeredScoutEnvelope'->'expectedOutputSchema') = 'object'
              THEN node.value->'registeredScoutEnvelope'->'expectedOutputSchema' ELSE '{}'::jsonb END) AS keys(key))
            = ARRAY['role', 'schemaVersion']::text[]
          AND node.value->'registeredScoutEnvelope'->'expectedOutputSchema'->>'role' = 'scout'
          AND node.value->'registeredScoutEnvelope'->'expectedOutputSchema'->>'schemaVersion' = 'agent-harness.v2.subagent.result'
          AND jsonb_typeof(node.value->'registeredScoutEnvelope'->'allowedActions') = 'array'
          AND jsonb_array_length(CASE WHEN jsonb_typeof(node.value->'registeredScoutEnvelope'->'allowedActions') = 'array'
            THEN node.value->'registeredScoutEnvelope'->'allowedActions' ELSE '[]'::jsonb END) <= 32
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(node.value->'registeredScoutEnvelope'->'allowedActions') = 'array'
              THEN node.value->'registeredScoutEnvelope'->'allowedActions' ELSE '[]'::jsonb END) AS action(value)
            WHERE jsonb_typeof(action.value) <> 'string' OR btrim(action.value #>> '{}') = ''
              OR length(action.value #>> '{}') > 128
          )
        ))
      ) IS NOT TRUE ELSE TRUE END
    )
    AND NOT EXISTS (
      SELECT node.value->>'key' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(item."content"->'nodes') = 'array'
        THEN item."content"->'nodes' ELSE '[]'::jsonb END) AS node(value)
      GROUP BY node.value->>'key' HAVING COUNT(*) > 1
    )
    AND NOT EXISTS (
      SELECT node.value->>'taskId' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(item."content"->'nodes') = 'array'
        THEN item."content"->'nodes' ELSE '[]'::jsonb END) AS node(value)
      GROUP BY node.value->>'taskId' HAVING COUNT(*) > 1
    )
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(item."content"->'nodes') = 'array'
        THEN item."content"->'nodes' ELSE '[]'::jsonb END) AS node(value)
      WHERE NOT EXISTS (
        SELECT 1 FROM "sub_agent_tasks" AS owned
        WHERE owned."id" = node.value->>'taskId' AND owned."sessionId" = item."sessionId"
          AND owned."turnId" = item."turnId" AND owned."rootTaskId" = root."id"
          AND owned."parentTaskId" = parent."id" AND owned."role" <> 'orchestrator'
      )
    )
), eligible_children AS (
  SELECT child."id", child."createdAt" + INTERVAL '60 minutes' AS "deadlineAt"
  FROM valid_graph_items AS graph
  CROSS JOIN LATERAL jsonb_array_elements(graph."content"->'nodes') AS node(value)
  JOIN "sub_agent_tasks" AS child
    ON child."id" = node.value->>'taskId' AND child."sessionId" = graph."sessionId"
      AND child."turnId" = graph."turnId" AND child."rootTaskId" = graph."rootTaskId"
      AND child."parentTaskId" = graph."parentTaskId"
  WHERE child."id" <> graph."rootTaskId" AND child."role" <> 'orchestrator'
    AND child."status" IN ('queued', 'running', 'retrying', 'waiting', 'waiting_for_user')
)
UPDATE "sub_agent_tasks" AS task
SET "absoluteDeadlineAt" = eligible."deadlineAt"
FROM eligible_children AS eligible
WHERE task."id" = eligible."id" AND task."absoluteDeadlineAt" IS NULL;
