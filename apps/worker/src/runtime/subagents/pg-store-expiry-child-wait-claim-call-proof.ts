import { safeSubagentWaitJson } from "./subagent-wait-structural-ids.js"

/** Match a persisted continuation key only to the redacted projection of its exact source key. */
export function childWaitContinuationKeyMatchesSafeProjection(sourceKey: unknown, continuationKey: unknown): boolean {
  if (typeof sourceKey !== "string" || typeof continuationKey !== "string"
    || sourceKey.length < 1 || sourceKey.length > 256 || sourceKey.trim() !== sourceKey
    || continuationKey.length < 1 || continuationKey.length > 256 || continuationKey.trim() !== continuationKey) return false
  const projected = safeSubagentWaitJson(sourceKey, 16_384)
  return typeof projected === "string" && projected === continuationKey
}

/** Internal projection-query columns for the one SQL-validated child-wait claim. */
export const CHILD_WAIT_CLAIM_KEY_COLUMNS_SQL = `
  (SELECT CASE WHEN COUNT(*) = 1 THEN MAX(sourceCall."content"->'input'->>'idempotencyKey') END
    FROM "agent_items" AS sourceCall WHERE sourceCall."sessionId" = $1 AND sourceCall."turnId" = $3
      AND sourceCall."taskId" = $2 AND sourceCall."stepId" = latest_wait."stepId"
      AND sourceCall."type" = 'tool_call' AND sourceCall."content"->>'toolName' = 'wait_subagents') AS "sourceWaitKey",
  (SELECT CASE WHEN COUNT(*) = 1 THEN MAX(claimedCall."content"->'input'->>'idempotencyKey') END
    FROM "agent_items" AS claimedCall WHERE claimedCall."sessionId" = $1 AND claimedCall."turnId" = $3
      AND claimedCall."taskId" = $2 AND claimedCall."stepId" = $10
      AND claimedCall."id" = 'task:' || $2 || ':item:tool-call:' || started."correlationId" || ':attempt:' || latest_wait."attempt"::text
      AND claimedCall."type" = 'tool_call') AS "continuationWaitKey"`

/** Exact continuation-claim cut after the call row is completed but before item.completed is appended. */
export const CHILD_WAIT_CALL_ITEM_COMPLETED_NO_EVENT_SQL = `(
  claimedCall."status" = 'completed'
  AND claimedCall."revision" = 1
  AND claimedCall."content" = jsonb_build_object('toolCallId', started."correlationId", 'toolName', 'wait_subagents',
    'toolVersion', '1', 'input', claimedCall."content"->'input', 'status', 'completed', 'errorCode', NULL)
  AND (SELECT COUNT(*) FROM "agent_items" AS stepCall WHERE stepCall."sessionId" = claimedCall."sessionId"
    AND stepCall."turnId" = claimedCall."turnId" AND stepCall."taskId" = claimedCall."taskId"
    AND stepCall."stepId" = continuation."id" AND stepCall."type" = 'tool_call') = 1
  AND NOT EXISTS (SELECT 1 FROM "agent_events" AS itemCompleted WHERE itemCompleted."sessionId" = claimedCall."sessionId"
    AND itemCompleted."turnId" = claimedCall."turnId" AND itemCompleted."taskId" = claimedCall."taskId"
    AND (itemCompleted."itemId" = claimedCall."id" OR itemCompleted."correlationId" = claimedCall."id")
    AND itemCompleted."type" = 'item.completed')
  AND NOT EXISTS (SELECT 1 FROM "agent_events" AS extra WHERE extra."sessionId" = claimedCall."sessionId"
    AND extra."turnId" = claimedCall."turnId" AND extra."taskId" = claimedCall."taskId"
    AND (extra."itemId" = claimedCall."id" OR extra."correlationId" = claimedCall."id" OR extra."correlationId" = started."correlationId")
    AND extra."id" <> itemStarted."id" AND extra."id" <> started."id")
  AND NOT EXISTS (SELECT 1 FROM "agent_events" AS terminal WHERE terminal."sessionId" = claimedCall."sessionId"
    AND terminal."turnId" = claimedCall."turnId" AND terminal."taskId" = claimedCall."taskId"
    AND (terminal."itemId" = claimedCall."id" OR terminal."correlationId" = claimedCall."id" OR terminal."correlationId" = started."correlationId")
    AND terminal."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted', 'item.failed', 'item.interrupted'))
  AND NOT EXISTS (SELECT 1 FROM "agent_items" AS result WHERE result."sessionId" = claimedCall."sessionId"
    AND result."turnId" = claimedCall."turnId" AND result."taskId" = claimedCall."taskId"
    AND result."stepId" = continuation."id" AND result."type" = 'tool_result')
  AND NOT EXISTS (SELECT 1 FROM "agent_events" AS resultEvent WHERE resultEvent."sessionId" = claimedCall."sessionId"
    AND resultEvent."turnId" = claimedCall."turnId" AND resultEvent."taskId" = claimedCall."taskId"
    AND (resultEvent."itemId" = 'task:' || owner."id" || ':item:tool-result:' || started."correlationId" || ':attempt:' || owner."attemptCount"::text
      OR resultEvent."correlationId" = 'task:' || owner."id" || ':item:tool-result:' || started."correlationId" || ':attempt:' || owner."attemptCount"::text))
)`

export const CHILD_WAIT_CALL_LIFECYCLE_SQL = `(
  (claimedCall."status" = 'started' AND NOT EXISTS (SELECT 1 FROM "agent_events" AS itemCompleted
    WHERE itemCompleted."sessionId" = claimedCall."sessionId" AND itemCompleted."turnId" = claimedCall."turnId"
      AND itemCompleted."taskId" = claimedCall."taskId"
      AND (itemCompleted."itemId" = claimedCall."id" OR itemCompleted."correlationId" = claimedCall."id") AND itemCompleted."type" = 'item.completed'))
  OR (claimedCall."status" = 'completed' AND EXISTS (SELECT 1 FROM "agent_events" AS itemCompleted
    WHERE itemCompleted."sessionId" = claimedCall."sessionId" AND itemCompleted."turnId" = claimedCall."turnId"
      AND itemCompleted."taskId" = claimedCall."taskId" AND itemCompleted."itemId" = claimedCall."id" AND itemCompleted."type" = 'item.completed'
      AND itemCompleted."actor" = 'subagent' AND itemCompleted."correlationId" = claimedCall."id" AND itemCompleted."causationId" = started."id"
      AND started."sequence" < itemCompleted."sequence"
      AND itemCompleted."idempotencyKey" = 'task:' || owner."id" || ':event:tool-call-completed:' || started."correlationId" || ':' || claimedCall."id" || ':1'
      AND itemCompleted."payload" = jsonb_build_object('itemId', claimedCall."id", 'status', 'completed', 'content', claimedCall."content"))
    AND (SELECT COUNT(*) FROM "agent_events" AS itemCompleted WHERE itemCompleted."sessionId" = claimedCall."sessionId"
      AND itemCompleted."turnId" = claimedCall."turnId" AND itemCompleted."taskId" = claimedCall."taskId"
      AND (itemCompleted."itemId" = claimedCall."id" OR itemCompleted."correlationId" = claimedCall."id")
      AND itemCompleted."type" = 'item.completed') = 1)
  OR ${CHILD_WAIT_CALL_ITEM_COMPLETED_NO_EVENT_SQL}
)`

/** Only an exact wait-call item/event lifecycle may settle its external start. */
export const CHILD_WAIT_CALL_TERMINAL_SETTLEMENT_SQL = `(
  NOT (started."type" = 'tool_call.started' AND (
    started."payload"->>'toolName' = 'wait_subagents'
    OR settled."payload"->>'toolName' = 'wait_subagents'
    OR left(started."idempotencyKey", char_length('task:' || started."taskId" || ':event:child-wait-claim:'))
      = 'task:' || started."taskId" || ':event:child-wait-claim:'
    OR EXISTS (SELECT 1 FROM "agent_items" AS hint WHERE hint."id" = started."itemId"
      AND hint."sessionId" = started."sessionId" AND hint."turnId" = started."turnId" AND hint."taskId" = started."taskId"
      AND hint."type" = 'tool_call' AND hint."content"->>'toolName' = 'wait_subagents')
  ))
  OR EXISTS (
    SELECT 1 FROM "sub_agent_tasks" AS owner
    JOIN "agent_sessions" AS session ON session."id" = owner."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = owner."turnId" AND turn."sessionId" = owner."sessionId"
    JOIN "agent_items" AS callItem ON callItem."id" = started."itemId" AND callItem."sessionId" = started."sessionId"
      AND callItem."turnId" = started."turnId" AND callItem."taskId" = started."taskId" AND callItem."type" = 'tool_call'
    JOIN "agent_steps" AS callStep ON callStep."id" = callItem."stepId" AND callStep."sessionId" = callItem."sessionId"
      AND callStep."turnId" = callItem."turnId" AND callStep."taskId" = callItem."taskId"
    JOIN "agent_events" AS itemStarted ON itemStarted."sessionId" = callItem."sessionId" AND itemStarted."turnId" = callItem."turnId"
      AND itemStarted."taskId" = callItem."taskId" AND itemStarted."itemId" = callItem."id" AND itemStarted."type" = 'item.started'
    JOIN "agent_events" AS itemCompleted ON itemCompleted."sessionId" = callItem."sessionId" AND itemCompleted."turnId" = callItem."turnId"
      AND itemCompleted."taskId" = callItem."taskId" AND itemCompleted."itemId" = callItem."id" AND itemCompleted."type" = 'item.completed'
    WHERE owner."id" = started."taskId" AND owner."sessionId" = started."sessionId" AND owner."turnId" = started."turnId"
      AND owner."rootTaskId" = turn."rootTaskId" AND owner."parentTaskId" IS NOT NULL
      AND session."userId" = turn."userId" AND started."actor" = 'subagent' AND started."itemId" = callItem."id"
      AND started."correlationId" = callItem."content"->>'toolCallId' AND btrim(started."correlationId") <> ''
      AND started."payload" = jsonb_build_object('toolCallId', started."correlationId", 'toolName', 'wait_subagents', 'taskId', owner."id")
      AND (started."idempotencyKey" = 'task:' || owner."id" || ':event:tool-started:' || started."correlationId"
        OR started."idempotencyKey" = 'task:' || owner."id" || ':event:child-wait-claim:' || callStep."attempt"::text || ':' || callStep."id")
      AND callItem."status" = 'completed' AND callItem."revision" = 1
      AND callItem."content"->>'toolName' = 'wait_subagents' AND callItem."content"->>'toolVersion' = '1'
      AND callItem."content"->>'toolCallId' = started."correlationId"
      AND callItem."content"->>'status' IN ('completed', 'failed', 'cancelled')
      AND jsonb_typeof(callItem."content"->'input') = 'object'
      AND (SELECT COUNT(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(callItem."content"->'input') = 'object'
        THEN callItem."content"->'input' ELSE '{}'::jsonb END)) = 4
      AND callItem."content"->'input' ?& ARRAY['idempotencyKey', 'taskIds', 'mode', 'timeoutMs']
      AND jsonb_typeof(callItem."content"->'errorCode') IN ('null', 'string')
      AND (callItem."content"->>'status' <> 'completed' OR callItem."content"->'errorCode' = 'null'::jsonb)
      AND (callItem."content"->>'status' = 'completed' OR jsonb_typeof(callItem."content"->'errorCode') = 'string')
      AND callItem."content" = jsonb_build_object('toolCallId', started."correlationId", 'toolName', 'wait_subagents',
        'toolVersion', '1', 'input', callItem."content"->'input', 'status', callItem."content"->>'status', 'errorCode', callItem."content"->'errorCode')
      AND itemStarted."actor" = 'subagent' AND itemStarted."correlationId" = callStep."id"
      AND ((itemStarted."causationId" IS NULL AND NOT EXISTS (SELECT 1 FROM "agent_events" AS prior WHERE prior."sessionId" = callItem."sessionId"
          AND prior."turnId" = callItem."turnId" AND prior."taskId" = callItem."taskId" AND prior."sequence" < itemStarted."sequence"))
        OR EXISTS (SELECT 1 FROM "agent_events" AS prior WHERE prior."id" = itemStarted."causationId"
          AND prior."sessionId" = callItem."sessionId" AND prior."turnId" = callItem."turnId" AND prior."taskId" = callItem."taskId"
          AND prior."sequence" < itemStarted."sequence"))
      AND itemStarted."idempotencyKey" = 'task:' || owner."id" || ':event:item-started:' || callItem."id"
      AND itemStarted."payload" = jsonb_build_object('itemId', callItem."id", 'type', 'tool_call', 'phase', NULL)
      AND started."causationId" = itemStarted."id" AND itemStarted."sequence" < started."sequence"
      AND itemCompleted."actor" = 'subagent' AND itemCompleted."correlationId" = callItem."id"
      AND started."sequence" < itemCompleted."sequence"
      AND itemCompleted."payload" = jsonb_build_object('itemId', callItem."id", 'status', 'completed', 'content', callItem."content")
      AND itemCompleted."idempotencyKey" = 'task:' || owner."id" || ':event:tool-call-completed:' || started."correlationId" || ':' || callItem."id" || ':1'
      AND itemCompleted."causationId" = started."id"
      AND settled."sessionId" = callItem."sessionId" AND settled."turnId" = callItem."turnId" AND settled."taskId" = callItem."taskId"
      AND settled."itemId" = callItem."id" AND settled."correlationId" = started."correlationId"
      AND settled."actor" = 'subagent' AND settled."causationId" = itemCompleted."id"
      AND itemCompleted."sequence" < settled."sequence"
      AND ((callItem."content"->>'status' = 'completed' AND settled."type" = 'tool_call.completed')
        OR (callItem."content"->>'status' IN ('failed', 'cancelled') AND settled."type" = 'tool_call.failed'))
      AND settled."idempotencyKey" = 'task:' || owner."id" || ':event:tool-finished:' || started."correlationId"
      AND settled."payload" = jsonb_build_object('toolCallId', started."correlationId", 'toolName', 'wait_subagents',
        'status', callItem."content"->>'status', 'errorCode', callItem."content"->'errorCode', 'taskId', owner."id")
      AND (SELECT COUNT(*) FROM "agent_events" AS itemStart WHERE itemStart."sessionId" = callItem."sessionId"
        AND itemStart."turnId" = callItem."turnId" AND itemStart."taskId" = callItem."taskId"
        AND itemStart."itemId" = callItem."id" AND itemStart."type" = 'item.started') = 1
      AND (SELECT COUNT(*) FROM "agent_events" AS callStart WHERE callStart."sessionId" = callItem."sessionId"
        AND callStart."turnId" = callItem."turnId" AND callStart."taskId" = callItem."taskId"
        AND (callStart."itemId" = callItem."id" OR callStart."correlationId" = started."correlationId")
        AND callStart."type" = 'tool_call.started') = 1
      AND (SELECT COUNT(*) FROM "agent_events" AS itemDone WHERE itemDone."sessionId" = callItem."sessionId"
        AND itemDone."turnId" = callItem."turnId" AND itemDone."taskId" = callItem."taskId"
        AND (itemDone."itemId" = callItem."id" OR itemDone."correlationId" = callItem."id") AND itemDone."type" = 'item.completed') = 1
      AND (SELECT COUNT(*) FROM "agent_events" AS terminal WHERE terminal."sessionId" = callItem."sessionId"
        AND terminal."turnId" = callItem."turnId" AND terminal."taskId" = callItem."taskId"
        AND (terminal."itemId" = callItem."id" OR terminal."correlationId" = started."correlationId" OR terminal."correlationId" = callItem."id")
        AND terminal."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted')) = 1
      AND NOT EXISTS (SELECT 1 FROM "agent_events" AS extra WHERE extra."sessionId" = callItem."sessionId"
        AND extra."turnId" = callItem."turnId" AND extra."taskId" = callItem."taskId"
        AND (extra."itemId" = callItem."id" OR extra."correlationId" = started."correlationId" OR extra."correlationId" = callItem."id")
        AND extra."id" NOT IN (itemStarted."id", started."id", itemCompleted."id", settled."id"))
  )
)`
