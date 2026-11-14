/** Rebinds every persisted call/result pair to its exact six-event writer chain. */
export function historicalSourceStepCallChainBinding(path: string): string {
  return historicalSourceStepCallChainSql(path).binding
}

export function historicalSourceStepCallChainSql(path: string): Readonly<{
  binding: string; itemCardinality: string; allItems: string; commentCardinality: string; eventCardinality: string
  anchorChain: string; finalClose: string; validCallCount: string; callCount: string; callScope: string; validCallItem: string; chain: string
}> {
  const items = `(CASE WHEN jsonb_typeof(${path}->'items') = 'array' THEN ${path}->'items' ELSE '[]'::jsonb END)`
  const events = `(CASE WHEN jsonb_typeof(${path}->'events') = 'array' THEN ${path}->'events' ELSE '[]'::jsonb END)`
  const firstEvent = `(${events}->0->>'id')`, lastEvent = `(${events}->(jsonb_array_length(${events}) - 1)->>'id')`
  const sourceWindow = (event: string) => `${event}."sequence" BETWEEN (SELECT anchor."sequence" FROM "agent_events" AS anchor
    WHERE anchor."id" = ${firstEvent} AND anchor."sessionId" = boundSource."sessionId" AND anchor."turnId" = boundSource."turnId" AND anchor."taskId" = boundSource."taskId")
    AND (SELECT anchor."sequence" FROM "agent_events" AS anchor WHERE anchor."id" = ${lastEvent}
      AND anchor."sessionId" = boundSource."sessionId" AND anchor."turnId" = boundSource."turnId" AND anchor."taskId" = boundSource."taskId")`
  const calls = `(SELECT COUNT(*) FROM "agent_items" AS callItem WHERE callItem."sessionId" = boundSource."sessionId"
    AND callItem."turnId" = boundSource."turnId" AND callItem."taskId" = boundSource."taskId"
    AND callItem."stepId" = boundSource."id" AND callItem."type" = 'tool_call')`
  const results = `(SELECT COUNT(*) FROM "agent_items" AS resultItem WHERE resultItem."sessionId" = boundSource."sessionId"
    AND resultItem."turnId" = boundSource."turnId" AND resultItem."taskId" = boundSource."taskId"
    AND resultItem."stepId" = boundSource."id" AND resultItem."type" = 'tool_result')`
  const comments = `(SELECT COUNT(*) FROM "agent_items" AS commentItem WHERE commentItem."sessionId" = boundSource."sessionId"
    AND commentItem."turnId" = boundSource."turnId" AND commentItem."taskId" = boundSource."taskId"
    AND commentItem."stepId" = boundSource."id" AND commentItem."type" IN ('agent_message','reasoning_summary'))`
  const allItems = `(SELECT COUNT(*) FROM "agent_items" AS scopedItem WHERE scopedItem."sessionId" = boundSource."sessionId"
    AND scopedItem."turnId" = boundSource."turnId" AND scopedItem."taskId" = boundSource."taskId" AND scopedItem."stepId" = boundSource."id")`
  const callScope = `callItem."sessionId" = boundSource."sessionId" AND callItem."turnId" = boundSource."turnId"
    AND callItem."taskId" = boundSource."taskId" AND callItem."stepId" = boundSource."id" AND callItem."type" = 'tool_call'`
  const resultScope = `resultItem."sessionId" = boundSource."sessionId" AND resultItem."turnId" = boundSource."turnId"
    AND resultItem."taskId" = boundSource."taskId" AND resultItem."stepId" = boundSource."id" AND resultItem."type" = 'tool_result'`
  const commentScope = `commentItem."sessionId" = boundSource."sessionId" AND commentItem."turnId" = boundSource."turnId"
    AND commentItem."taskId" = boundSource."taskId" AND commentItem."stepId" = boundSource."id"
    AND commentItem."type" IN ('agent_message','reasoning_summary')`
  const resultForCall = `resultItem."content"->>'toolCallId' = callItem."content"->>'toolCallId'`
  const previousCallCause = `(NOT EXISTS (SELECT 1 FROM "agent_events" AS earlierStart
    JOIN "agent_items" AS earlierCall ON earlierCall."id" = earlierStart."itemId"
      AND earlierCall."sessionId" = boundSource."sessionId" AND earlierCall."turnId" = boundSource."turnId"
      AND earlierCall."taskId" = boundSource."taskId" AND earlierCall."stepId" = boundSource."id" AND earlierCall."type" = 'tool_call'
    WHERE earlierStart."sessionId" = boundSource."sessionId" AND earlierStart."turnId" = boundSource."turnId"
    AND earlierStart."taskId" = boundSource."taskId" AND earlierCall."id" = 'task:' || boundSource."taskId" || ':item:tool-call:'
      || (earlierCall."content"->>'toolCallId') || ':attempt:' || boundSource."attempt"::text
    AND earlierStart."type" = 'tool_call.started' AND ${sourceWindow("earlierStart")} AND earlierStart."sequence" < callItemStarted."sequence")
    OR callItemStarted."causationId" = (SELECT priorResultCompleted."id" FROM "agent_items" AS priorCall
      JOIN "agent_events" AS priorStart ON priorStart."sessionId" = boundSource."sessionId" AND priorStart."turnId" = boundSource."turnId"
        AND priorStart."taskId" = boundSource."taskId" AND priorStart."itemId" = priorCall."id" AND priorStart."type" = 'tool_call.started'
      JOIN "agent_items" AS priorResult ON priorResult."sessionId" = priorCall."sessionId" AND priorResult."turnId" = priorCall."turnId"
        AND priorResult."taskId" = priorCall."taskId" AND priorResult."stepId" = priorCall."stepId" AND priorResult."type" = 'tool_result'
        AND priorResult."content"->>'toolCallId' = priorCall."content"->>'toolCallId'
      JOIN "agent_events" AS priorResultCompleted ON priorResultCompleted."sessionId" = priorStart."sessionId"
        AND priorResultCompleted."turnId" = priorStart."turnId" AND priorResultCompleted."taskId" = priorStart."taskId"
        AND priorResultCompleted."itemId" = priorResult."id" AND priorResultCompleted."type" = 'item.completed'
        AND priorResultCompleted."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:tool-result-completed:'
          || (priorCall."content"->>'toolCallId') || ':' || priorResult."id" || ':1'
      WHERE priorCall."sessionId" = boundSource."sessionId" AND priorCall."turnId" = boundSource."turnId"
        AND priorCall."taskId" = boundSource."taskId" AND priorCall."stepId" = boundSource."id" AND priorCall."type" = 'tool_call'
        AND priorCall."id" = 'task:' || boundSource."taskId" || ':item:tool-call:' || (priorCall."content"->>'toolCallId') || ':attempt:' || boundSource."attempt"::text
        AND ${sourceWindow("priorStart")} AND priorStart."sequence" < callItemStarted."sequence"
      ORDER BY priorStart."sequence" DESC LIMIT 1))`
  const chain = `EXISTS (SELECT 1 FROM "agent_items" AS resultItem
    JOIN "agent_events" AS callItemStarted ON callItemStarted."sessionId" = boundSource."sessionId"
      AND callItemStarted."turnId" = boundSource."turnId" AND callItemStarted."taskId" = boundSource."taskId"
      AND callItemStarted."itemId" = callItem."id" AND callItemStarted."type" = 'item.started'
    JOIN "agent_events" AS callStarted ON callStarted."sessionId" = callItemStarted."sessionId"
      AND callStarted."turnId" = callItemStarted."turnId" AND callStarted."taskId" = callItemStarted."taskId"
      AND callStarted."causationId" = callItemStarted."id" AND callStarted."sequence" > callItemStarted."sequence"
    JOIN "agent_events" AS callCompleted ON callCompleted."sessionId" = callStarted."sessionId"
      AND callCompleted."turnId" = callStarted."turnId" AND callCompleted."taskId" = callStarted."taskId"
      AND callCompleted."causationId" = callStarted."id" AND callCompleted."sequence" > callStarted."sequence"
    JOIN "agent_events" AS terminal ON terminal."sessionId" = callCompleted."sessionId"
      AND terminal."turnId" = callCompleted."turnId" AND terminal."taskId" = callCompleted."taskId"
      AND terminal."causationId" = callCompleted."id" AND terminal."sequence" > callCompleted."sequence"
    JOIN "agent_events" AS resultStarted ON resultStarted."sessionId" = terminal."sessionId"
      AND resultStarted."turnId" = terminal."turnId" AND resultStarted."taskId" = terminal."taskId"
      AND resultStarted."causationId" = terminal."id" AND resultStarted."sequence" > terminal."sequence"
    JOIN "agent_events" AS resultCompleted ON resultCompleted."sessionId" = resultStarted."sessionId"
      AND resultCompleted."turnId" = resultStarted."turnId" AND resultCompleted."taskId" = resultStarted."taskId"
      AND resultCompleted."causationId" = resultStarted."id" AND resultCompleted."sequence" > resultStarted."sequence"
    WHERE ${resultScope} AND ${resultForCall}
      AND callItem."id" = 'task:' || boundSource."taskId" || ':item:tool-call:' || (callItem."content"->>'toolCallId') || ':attempt:' || boundSource."attempt"::text
      AND (resultItem."id" = 'task:' || boundSource."taskId" || ':item:tool-result:' || (callItem."content"->>'toolCallId') || ':attempt:' || boundSource."attempt"::text
        OR (callItem."id" = boundSourceCall."id" AND callItem."content"->>'toolName' = 'wait_subagents'
          AND resultItem."id" = 'task:' || boundSource."taskId" || ':item:tool-result:source-wait-recovery:' || encode(sha256(
            convert_to('child-wait-source-result:v1','UTF8') || decode('00','hex') || convert_to(boundWait."id",'UTF8') || decode('00','hex')
            || convert_to((callItem."content"->>'toolCallId'),'UTF8')), 'hex')))
      AND CASE WHEN jsonb_typeof(resultItem."content") = 'object' THEN (SELECT COUNT(*) FROM jsonb_object_keys(resultItem."content")) = 3
        AND resultItem."content" ?& ARRAY['toolCallId','output','errorCode'] ELSE FALSE END
      AND resultItem."content"->'errorCode' = callItem."content"->'errorCode'
      AND resultItem."status" = 'completed' AND resultItem."revision" = 1 AND resultItem."phase" IS NULL
      AND callItemStarted."actor" = 'subagent' AND callItemStarted."correlationId" = boundSource."id"
      AND callItemStarted."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:item-started:' || callItem."id"
      AND callItemStarted."payload" = jsonb_build_object('itemId', callItem."id", 'type', 'tool_call', 'phase', NULL)
      AND ${previousCallCause}
      AND callStarted."actor" = 'subagent' AND callStarted."type" = 'tool_call.started'
      AND callStarted."itemId" = callItem."id" AND callStarted."correlationId" = callItem."content"->>'toolCallId'
      AND callStarted."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:tool-started:' || (callItem."content"->>'toolCallId')
      AND callStarted."payload" = jsonb_build_object('toolCallId', callItem."content"->>'toolCallId',
        'toolName', callItem."content"->>'toolName', 'taskId', boundSource."taskId")
      AND callCompleted."actor" = 'subagent' AND callCompleted."type" = 'item.completed'
      AND callCompleted."itemId" = callItem."id" AND callCompleted."correlationId" = callItem."id"
      AND callCompleted."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:tool-call-completed:'
        || (callItem."content"->>'toolCallId') || ':' || callItem."id" || ':1'
      AND (callItem."id" = boundSourceCall."id" OR callCompleted."payload" = jsonb_build_object('itemId', callItem."id",
        'status', 'completed', 'content', callItem."content"))
      AND terminal."actor" = 'subagent' AND terminal."itemId" = callItem."id"
      AND terminal."correlationId" = callItem."content"->>'toolCallId'
      AND terminal."type" = CASE callItem."content"->>'status' WHEN 'completed' THEN 'tool_call.completed' ELSE 'tool_call.failed' END
      AND terminal."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:tool-finished:' || (callItem."content"->>'toolCallId')
      AND terminal."payload" = jsonb_build_object('toolCallId', callItem."content"->>'toolCallId',
        'toolName', callItem."content"->>'toolName', 'status', callItem."content"->>'status',
        'errorCode', callItem."content"->'errorCode', 'taskId', boundSource."taskId")
      AND resultStarted."actor" = 'subagent' AND resultStarted."type" = 'item.started'
      AND resultStarted."itemId" = resultItem."id" AND resultStarted."correlationId" = boundSource."id"
      AND resultStarted."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:item-started:' || resultItem."id"
      AND resultStarted."payload" = jsonb_build_object('itemId', resultItem."id", 'type', 'tool_result', 'phase', NULL)
      AND resultCompleted."actor" = 'subagent' AND resultCompleted."type" = 'item.completed'
      AND resultCompleted."itemId" = resultItem."id" AND resultCompleted."correlationId" = resultItem."id"
      AND resultCompleted."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:tool-result-completed:'
        || (callItem."content"->>'toolCallId') || ':' || resultItem."id" || ':1'
      AND resultCompleted."payload" = jsonb_build_object('itemId', resultItem."id", 'status', 'completed', 'content', resultItem."content"))`
  const projectedCalls = `(SELECT COUNT(*) FROM jsonb_array_elements(${items}) AS projected(value) WHERE projected.value->>'type' = 'tool_call')`
  const projectedResults = `(SELECT COUNT(*) FROM jsonb_array_elements(${items}) AS projected(value) WHERE projected.value->>'type' = 'tool_result')`
  const projectedComments = `(SELECT COUNT(*) FROM jsonb_array_elements(${items}) AS projected(value) WHERE projected.value->>'type' IN ('agent_message','reasoning_summary'))`
  const finalClose = `(CASE WHEN ${path}->>'terminalMode' = 'step_completed' THEN EXISTS (SELECT 1 FROM "agent_events" AS closeEvent
    JOIN "agent_events" AS modelDone ON modelDone."sessionId" = boundSource."sessionId" AND modelDone."turnId" = boundSource."turnId"
      AND modelDone."taskId" = boundSource."taskId" AND modelDone."type" = 'model.completed'
      AND modelDone."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:model-completed:' || boundSource."id"
    WHERE closeEvent."sessionId" = boundSource."sessionId" AND closeEvent."turnId" = boundSource."turnId"
      AND closeEvent."taskId" = boundSource."taskId" AND closeEvent."type" = 'step.completed'
      AND closeEvent."actor" = 'subagent' AND closeEvent."itemId" IS NULL AND closeEvent."correlationId" = boundSource."id"
      AND closeEvent."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:step-completed:' || boundSource."id"
      AND closeEvent."id" = ${events}->(jsonb_array_length(${events}) - 1)->>'id'
      AND closeEvent."payload" = jsonb_build_object('stepId', boundSource."id", 'status', 'waiting_for_dependency',
        'toolCallCount', modelDone."payload"->'toolCallCount', 'taskId', boundSource."taskId")) ELSE TRUE END)`
  const validCallItem = `CASE WHEN jsonb_typeof(callItem."content") = 'object' THEN (SELECT COUNT(*) FROM jsonb_object_keys(callItem."content")) = 6
      AND callItem."content" ?& ARRAY['toolCallId','toolName','toolVersion','status','errorCode','input'] ELSE FALSE END
    AND callItem."status" = 'completed' AND callItem."revision" = 1 AND callItem."phase" IS NULL
    AND jsonb_typeof(callItem."content"->'input') = 'object' AND callItem."content"->>'toolVersion' = '1'
    AND jsonb_typeof(callItem."content"->'toolCallId') = 'string' AND jsonb_typeof(callItem."content"->'toolName') = 'string'
    AND jsonb_typeof(callItem."content"->'toolVersion') = 'string' AND jsonb_typeof(callItem."content"->'status') = 'string'
    AND jsonb_typeof(callItem."content"->'errorCode') IN ('null','string')
    AND char_length(callItem."content"->>'toolCallId') BETWEEN 1 AND 256
    AND char_length(callItem."content"->>'toolName') BETWEEN 1 AND 256
    AND callItem."content"->>'toolCallId' = btrim(callItem."content"->>'toolCallId')
    AND callItem."content"->>'toolName' = btrim(callItem."content"->>'toolName')
    AND callItem."content"->>'toolName' NOT IN ('agent.wait','agent.ask_user')
    AND ((callItem."content"->>'toolName' = 'wait_subagents' AND callItem."id" = boundSourceCall."id")
      OR (callItem."content"->>'toolName' <> 'wait_subagents' AND callItem."id" <> boundSourceCall."id"))
    AND ((callItem."content"->>'status' = 'completed' AND callItem."content"->'errorCode' = 'null'::jsonb)
      OR (callItem."content"->>'status' IN ('failed','cancelled')
        AND jsonb_typeof(callItem."content"->'errorCode') IN ('null','string')
        AND (callItem."content"->'errorCode' = 'null'::jsonb OR callItem."content"->>'errorCode' ~ '^[A-Za-z0-9_.:-]{1,128}$')
        AND COALESCE(callItem."content"->>'errorCode','') NOT IN ('policy_requires_approval','policy_requires_user_input','gmail_oauth_required','session_pause_requested')))`
  const validCalls = `(SELECT COUNT(*) FROM "agent_items" AS callItem WHERE ${callScope}
    AND ${validCallItem}
    AND (SELECT COUNT(*) FROM "agent_items" AS resultItem WHERE ${resultScope} AND ${resultForCall}) = 1
    AND ${chain})`
  const validComments = `(SELECT COUNT(*) FROM "agent_items" AS commentItem WHERE ${commentScope}
    AND commentItem."status" = 'completed' AND commentItem."revision" = 2 AND commentItem."phase" = 'commentary'
    AND CASE WHEN jsonb_typeof(commentItem."content") = 'object' AND commentItem."type" = 'agent_message'
      THEN (SELECT COUNT(*) FROM jsonb_object_keys(commentItem."content")) = 1 AND commentItem."content" ? 'text'
        AND jsonb_typeof(commentItem."content"->'text') = 'string' AND char_length(commentItem."content"->>'text') > 0
      WHEN jsonb_typeof(commentItem."content") = 'object' AND commentItem."type" = 'reasoning_summary'
      THEN (SELECT COUNT(*) FROM jsonb_object_keys(commentItem."content")) = 1 AND commentItem."content" ? 'body'
        AND jsonb_typeof(commentItem."content"->'body') = 'string' AND char_length(commentItem."content"->>'body') > 0 ELSE FALSE END
    AND EXISTS (SELECT 1 FROM "agent_events" AS commentStarted
      JOIN "agent_events" AS commentDelta ON commentDelta."sessionId" = commentStarted."sessionId"
        AND commentDelta."turnId" = commentStarted."turnId" AND commentDelta."taskId" = commentStarted."taskId"
        AND commentDelta."causationId" = commentStarted."id" AND commentDelta."sequence" > commentStarted."sequence"
      JOIN "agent_events" AS commentCompleted ON commentCompleted."sessionId" = commentDelta."sessionId"
        AND commentCompleted."turnId" = commentDelta."turnId" AND commentCompleted."taskId" = commentDelta."taskId"
        AND commentCompleted."causationId" = commentDelta."id" AND commentCompleted."sequence" > commentDelta."sequence"
      WHERE commentStarted."sessionId" = boundSource."sessionId" AND commentStarted."turnId" = boundSource."turnId"
        AND commentStarted."taskId" = boundSource."taskId" AND commentStarted."actor" = 'subagent'
        AND commentStarted."type" = 'item.started' AND commentStarted."itemId" = commentItem."id"
        AND commentStarted."correlationId" = boundSource."id"
        AND commentStarted."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:item-started:' || commentItem."id"
        AND commentStarted."payload" = jsonb_build_object('itemId', commentItem."id", 'type', commentItem."type", 'phase', 'commentary')
        AND commentDelta."actor" = 'subagent' AND commentDelta."type" = 'item.delta'
        AND commentDelta."itemId" = commentItem."id" AND commentDelta."correlationId" = commentItem."id"
        AND commentDelta."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:' ||
          CASE commentItem."type" WHEN 'agent_message' THEN 'commentary-delta:' ELSE 'reasoning-delta:' END || commentItem."id" || ':1'
        AND commentDelta."payload" = jsonb_build_object('itemId', commentItem."id", 'status', 'streaming', 'content', commentItem."content")
        AND commentCompleted."actor" = 'subagent' AND commentCompleted."type" = 'item.completed'
        AND commentCompleted."itemId" = commentItem."id" AND commentCompleted."correlationId" = commentItem."id"
        AND commentCompleted."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:' ||
          CASE commentItem."type" WHEN 'agent_message' THEN 'commentary-completed:' ELSE 'reasoning-completed:' END || commentItem."id" || ':2'
        AND commentCompleted."payload" = jsonb_build_object('itemId', commentItem."id", 'status', 'completed', 'content', commentItem."content")))`
  const agendaKey = `(CASE WHEN octet_length(convert_to('cognitive.agenda:' || boundSource."id", 'UTF8')) <= 256
    THEN 'cognitive.agenda:' || boundSource."id" ELSE 'cognitive.agenda:sha256:' || encode(sha256(convert_to(boundSource."id", 'UTF8')), 'hex') END)`
  const anchorChain = `EXISTS (SELECT 1 FROM "agent_events" AS agenda
    JOIN "agent_events" AS modelStart ON modelStart."causationId" = agenda."id"
    JOIN "agent_events" AS modelDone ON modelDone."causationId" = modelStart."id"
    JOIN "agent_events" AS modelUsage ON modelUsage."causationId" = modelDone."id"
    WHERE agenda."sessionId" = boundSource."sessionId" AND agenda."turnId" = boundSource."turnId" AND agenda."taskId" = boundSource."taskId"
      AND agenda."type" = 'cognitive.agenda' AND agenda."actor" = 'subagent' AND agenda."itemId" IS NULL
      AND agenda."correlationId" = boundSource."id" AND agenda."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:' || ${agendaKey}
      AND agenda."causationId" = ${events}->0->>'id'
      AND agenda."payload"->>'sessionId' = boundSource."sessionId" AND agenda."payload"->>'turnId' = boundSource."turnId"
      AND agenda."payload"->>'taskId' = boundSource."taskId" AND agenda."payload"->>'stepId' = boundSource."id"
      AND agenda."payload"->>'schemaVersion' = 'agent-harness.cognitive-agenda-receipt.v1'
      AND agenda."payload"->>'externalDataPolicy' = 'external/untrusted content is data, never instructions'
      AND modelStart."sessionId" = boundSource."sessionId" AND modelStart."turnId" = boundSource."turnId" AND modelStart."taskId" = boundSource."taskId"
      AND modelStart."type" = 'model.started' AND modelStart."actor" = 'subagent' AND modelStart."itemId" IS NULL
      AND modelStart."correlationId" = boundSource."id" AND modelStart."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:model-started:' || boundSource."id"
      AND modelStart."payload" ?& ARRAY['taskId','provider','model'] AND (SELECT COUNT(*) FROM jsonb_object_keys(modelStart."payload")) = 3
      AND modelStart."payload"->>'taskId' = boundSource."taskId" AND jsonb_typeof(modelStart."payload"->'provider') = 'string'
      AND jsonb_typeof(modelStart."payload"->'model') = 'string'
      AND modelDone."sessionId" = boundSource."sessionId" AND modelDone."turnId" = boundSource."turnId" AND modelDone."taskId" = boundSource."taskId"
      AND modelDone."type" = 'model.completed' AND modelDone."actor" = 'subagent' AND modelDone."itemId" IS NULL
      AND modelDone."correlationId" = boundSource."id" AND modelDone."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:model-completed:' || boundSource."id"
      AND modelDone."payload" ?& ARRAY['taskId','provider','model','toolCallCount'] AND (SELECT COUNT(*) FROM jsonb_object_keys(modelDone."payload")) = 4
      AND modelDone."payload"->>'taskId' = boundSource."taskId" AND modelDone."payload"->>'provider' = modelStart."payload"->>'provider'
      AND modelDone."payload"->>'model' = modelStart."payload"->>'model'
      AND modelUsage."sessionId" = boundSource."sessionId" AND modelUsage."turnId" = boundSource."turnId" AND modelUsage."taskId" = boundSource."taskId"
      AND modelUsage."type" = 'model.usage' AND modelUsage."actor" = 'subagent' AND modelUsage."itemId" IS NULL
      AND modelUsage."correlationId" = boundSource."id" AND modelUsage."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:model-usage:' || boundSource."id"
      AND modelUsage."payload" ?& ARRAY['taskId','provider','model','usage'] AND (SELECT COUNT(*) FROM jsonb_object_keys(modelUsage."payload")) = 4
      AND modelUsage."payload"->>'taskId' = boundSource."taskId" AND modelUsage."payload"->>'provider' = modelStart."payload"->>'provider'
      AND modelUsage."payload"->>'model' = modelStart."payload"->>'model'
      AND (modelUsage."payload"->'usage' = 'null'::jsonb OR CASE WHEN jsonb_typeof(modelUsage."payload"->'usage') = 'object'
        THEN (SELECT COUNT(*) FROM jsonb_object_keys(modelUsage."payload"->'usage')) = 3
          AND modelUsage."payload"->'usage' ?& ARRAY['inputTokens','outputTokens','estimatedCostUsd']
          AND CASE WHEN jsonb_typeof(modelUsage."payload"->'usage'->'inputTokens') = 'number'
            THEN (modelUsage."payload"->'usage'->>'inputTokens')::numeric >= 0 ELSE FALSE END
          AND CASE WHEN jsonb_typeof(modelUsage."payload"->'usage'->'outputTokens') = 'number'
            THEN (modelUsage."payload"->'usage'->>'outputTokens')::numeric >= 0 ELSE FALSE END
          AND CASE WHEN jsonb_typeof(modelUsage."payload"->'usage'->'estimatedCostUsd') = 'number'
            THEN (modelUsage."payload"->'usage'->>'estimatedCostUsd')::numeric >= 0 ELSE FALSE END ELSE FALSE END))`
  const itemCardinality = `${calls} = ${results} AND ${projectedCalls} = ${calls} AND ${projectedResults} = ${results}`
  const allItemsValid = `${allItems} = ${calls} + ${results} + ${comments}`
  const commentCardinality = `${comments} <= 2 AND ${projectedComments} = ${comments} AND ${validComments} = ${comments}`
  const eventCardinality = `jsonb_array_length(${events}) = 5 + ${calls} * 6 + ${comments} * 3 + CASE WHEN ${path}->>'terminalMode' = 'step_completed' THEN 1 ELSE 0 END
    AND (SELECT COUNT(DISTINCT projected.value->>'idempotencyKey') FROM jsonb_array_elements(${events}) AS projected(value)) = jsonb_array_length(${events})`
  const binding = `(${itemCardinality} AND ${allItemsValid} AND ${commentCardinality} AND ${anchorChain} AND ${finalClose} AND ${eventCardinality}
    AND ${validCalls} = ${calls})`
  return { binding, itemCardinality, allItems: allItemsValid, commentCardinality, eventCardinality, anchorChain, finalClose,
    validCallCount: validCalls, callCount: calls, callScope, validCallItem, chain }
}
