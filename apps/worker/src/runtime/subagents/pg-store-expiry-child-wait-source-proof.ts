/** Exact crash cut for a registered source wait whose executor never returned. */
export const CHILD_WAIT_SOURCE_STARTED_NO_RESULT_SQL = `(
  sourceCall."status" = 'started'
  AND sourceCall."revision" = 0
  AND sourceResult."id" IS NULL
  AND sourceCall."content"->>'toolCallId' IS NOT NULL
  AND char_length(sourceCall."content"->>'toolCallId') BETWEEN 1 AND 256
  AND btrim(sourceCall."content"->>'toolCallId') = sourceCall."content"->>'toolCallId'
  AND sourceCall."id" = 'task:' || owner."id" || ':item:tool-call:' || (sourceCall."content"->>'toolCallId') || ':attempt:' || owner."attemptCount"::text
  AND sourceCall."content" = jsonb_build_object('toolCallId', sourceCall."content"->>'toolCallId',
    'toolName', 'wait_subagents', 'toolVersion', '1', 'input', sourceCall."content"->'input')
  AND (SELECT COUNT(*) FROM "agent_events" AS sourceItemStarted
    WHERE sourceItemStarted."sessionId" = sourceCall."sessionId" AND sourceItemStarted."turnId" = sourceCall."turnId"
      AND sourceItemStarted."taskId" = sourceCall."taskId" AND sourceItemStarted."itemId" = sourceCall."id"
      AND sourceItemStarted."type" = 'item.started' AND sourceItemStarted."actor" = 'subagent'
      AND sourceItemStarted."correlationId" = source."id"
      AND sourceItemStarted."idempotencyKey" = 'task:' || owner."id" || ':event:item-started:' || sourceCall."id"
      AND sourceItemStarted."payload" = jsonb_build_object('itemId', sourceCall."id", 'type', 'tool_call', 'phase', NULL)) = 1
  AND (SELECT COUNT(*) FROM "agent_events" AS sourceCallStarted
    JOIN "agent_events" AS sourceItemStarted ON sourceItemStarted."sessionId" = sourceCallStarted."sessionId"
      AND sourceItemStarted."turnId" = sourceCallStarted."turnId" AND sourceItemStarted."taskId" = sourceCallStarted."taskId"
      AND sourceItemStarted."itemId" = sourceCall.id AND sourceItemStarted."type" = 'item.started'
      AND sourceItemStarted."actor" = 'subagent' AND sourceItemStarted."correlationId" = source."id"
      AND sourceItemStarted."idempotencyKey" = 'task:' || owner."id" || ':event:item-started:' || sourceCall."id"
      AND sourceItemStarted."payload" = jsonb_build_object('itemId', sourceCall."id", 'type', 'tool_call', 'phase', NULL)
    WHERE sourceCallStarted."sessionId" = sourceCall."sessionId" AND sourceCallStarted."turnId" = sourceCall."turnId"
      AND sourceCallStarted."taskId" = sourceCall."taskId" AND sourceCallStarted."itemId" = sourceCall."id"
      AND sourceCallStarted."type" = 'tool_call.started' AND sourceCallStarted."actor" = 'subagent'
      AND sourceCallStarted."correlationId" = sourceCall."content"->>'toolCallId'
      AND sourceCallStarted."causationId" = sourceItemStarted."id"
      AND sourceCallStarted."sequence" > sourceItemStarted."sequence"
      AND sourceCallStarted."idempotencyKey" = 'task:' || owner."id" || ':event:tool-started:' || (sourceCall."content"->>'toolCallId')
      AND sourceCallStarted."payload" = jsonb_build_object('toolCallId', sourceCall."content"->>'toolCallId',
        'toolName', 'wait_subagents', 'taskId', owner."id")) = 1
  AND NOT EXISTS (SELECT 1 FROM "agent_events" AS sourceExtra
    WHERE sourceExtra."sessionId" = sourceCall."sessionId" AND sourceExtra."turnId" = sourceCall."turnId"
      AND sourceExtra."taskId" = sourceCall."taskId"
      AND (sourceExtra."itemId" = sourceCall."id" OR sourceExtra."correlationId" = sourceCall."content"->>'toolCallId')
      AND NOT (
        (sourceExtra."type" = 'item.started' AND sourceExtra."actor" = 'subagent'
          AND sourceExtra."itemId" = sourceCall."id" AND sourceExtra."correlationId" = source."id"
          AND sourceExtra."idempotencyKey" = 'task:' || owner."id" || ':event:item-started:' || sourceCall."id"
          AND sourceExtra."payload" = jsonb_build_object('itemId', sourceCall."id", 'type', 'tool_call', 'phase', NULL)) IS TRUE
        OR (sourceExtra."type" = 'tool_call.started' AND sourceExtra."actor" = 'subagent'
          AND sourceExtra."itemId" = sourceCall."id" AND sourceExtra."correlationId" = sourceCall."content"->>'toolCallId'
          AND sourceExtra."idempotencyKey" = 'task:' || owner."id" || ':event:tool-started:' || (sourceCall."content"->>'toolCallId')
          AND sourceExtra."payload" = jsonb_build_object('toolCallId', sourceCall."content"->>'toolCallId',
            'toolName', 'wait_subagents', 'taskId', owner."id")
          AND EXISTS (SELECT 1 FROM "agent_events" AS sourceItemStarted
            WHERE sourceItemStarted."sessionId" = sourceExtra."sessionId" AND sourceItemStarted."turnId" = sourceExtra."turnId"
              AND sourceItemStarted."taskId" = sourceExtra."taskId" AND sourceItemStarted."itemId" = sourceCall."id"
              AND sourceItemStarted."type" = 'item.started' AND sourceItemStarted."actor" = 'subagent'
              AND sourceItemStarted."correlationId" = source."id"
              AND sourceItemStarted."idempotencyKey" = 'task:' || owner."id" || ':event:item-started:' || sourceCall."id"
              AND sourceItemStarted."payload" = jsonb_build_object('itemId', sourceCall."id", 'type', 'tool_call', 'phase', NULL)
              AND sourceExtra."causationId" = sourceItemStarted."id" AND sourceExtra."sequence" > sourceItemStarted."sequence")) IS TRUE
      ))
  AND NOT EXISTS (SELECT 1 FROM "agent_items" AS sourceResultAny
    WHERE sourceResultAny."sessionId" = sourceCall."sessionId" AND sourceResultAny."turnId" = sourceCall."turnId"
      AND sourceResultAny."taskId" = sourceCall."taskId"
      AND (sourceResultAny."id" = 'task:' || owner."id" || ':item:tool-result:' || (sourceCall."content"->>'toolCallId') || ':attempt:' || owner."attemptCount"::text
        OR (sourceResultAny."type" = 'tool_result' AND sourceResultAny."content"->>'toolCallId' = sourceCall."content"->>'toolCallId')))
  AND NOT EXISTS (SELECT 1 FROM "agent_events" AS sourceResultEvent
    WHERE sourceResultEvent."sessionId" = sourceCall."sessionId" AND sourceResultEvent."turnId" = sourceCall."turnId"
      AND sourceResultEvent."taskId" = sourceCall."taskId"
      AND (sourceResultEvent."itemId" = 'task:' || owner."id" || ':item:tool-result:' || (sourceCall."content"->>'toolCallId') || ':attempt:' || owner."attemptCount"::text
        OR sourceResultEvent."correlationId" = 'task:' || owner."id" || ':item:tool-result:' || (sourceCall."content"->>'toolCallId') || ':attempt:' || owner."attemptCount"::text))
  AND (wait."status" <> 'timed_out' OR wait."result"->'outcome'->>'deadlineAt' <= to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
)`
