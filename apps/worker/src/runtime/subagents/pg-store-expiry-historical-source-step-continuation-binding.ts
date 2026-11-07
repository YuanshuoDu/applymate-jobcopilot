import { MAX_STEP_TOOL_CALLS } from "./pg-store-expiry-step-tool-chain-proof.js"
export { historicalSourceStepWindowUnionBinding } from "./pg-store-expiry-historical-source-step-continuation-window-binding.js"

/** Preserves the source-step call-count fence when a bounded successor is present. */
export function historicalSourceStepCallCountBinding(path: string): string {
  const events = `(CASE WHEN jsonb_typeof(${path}->'events') = 'array' THEN ${path}->'events' ELSE '[]'::jsonb END)`
  const continuation = `(${path}->'continuationPrefix')`
  const callTarget = `${callsExpression()} + CASE WHEN jsonb_typeof(${continuation}) = 'object' THEN 1 ELSE 0 END`
  const scopedCalls = `callItem."sessionId" = boundSource."sessionId" AND callItem."turnId" = boundSource."turnId"
    AND callItem."taskId" = boundSource."taskId" AND callItem."stepId" = boundSource."id" AND callItem."type" = 'tool_call'`
  const calls = `(SELECT COUNT(*) FROM "agent_items" AS callItem WHERE ${scopedCalls})`
  const distinctCalls = `(SELECT COUNT(DISTINCT callItem."content"->>'toolCallId') FROM "agent_items" AS callItem WHERE ${scopedCalls})`
  const firstEvent = `(${events}->0->>'id')`, lastEvent = `(${events}->(jsonb_array_length(${events}) - 1)->>'id')`
  const scopedStarts = `started."sessionId" = boundSource."sessionId" AND started."turnId" = boundSource."turnId"
    AND started."taskId" = boundSource."taskId" AND started."type" = 'tool_call.started'
    AND started."sequence" BETWEEN (SELECT anchor."sequence" FROM "agent_events" AS anchor WHERE anchor."id" = ${firstEvent}
      AND anchor."sessionId" = boundSource."sessionId" AND anchor."turnId" = boundSource."turnId" AND anchor."taskId" = boundSource."taskId")
      AND (SELECT anchor."sequence" FROM "agent_events" AS anchor WHERE anchor."id" = ${lastEvent}
        AND anchor."sessionId" = boundSource."sessionId" AND anchor."turnId" = boundSource."turnId" AND anchor."taskId" = boundSource."taskId")`
  const started = `(SELECT COUNT(*) FROM "agent_events" AS started WHERE ${scopedStarts})`
  const distinctStarts = `(SELECT COUNT(DISTINCT started."correlationId") FROM "agent_events" AS started WHERE ${scopedStarts})`
  const startedCalls = `(SELECT COUNT(DISTINCT started."correlationId") FROM "agent_events" AS started JOIN "agent_items" AS callItem
    ON callItem."id" = started."itemId" AND ${scopedCalls} WHERE ${scopedStarts}
      AND started."actor" = 'subagent' AND started."correlationId" = callItem."content"->>'toolCallId'
      AND started."idempotencyKey" = 'task:' || owner."id" || ':event:tool-started:' || (callItem."content"->>'toolCallId')
      AND started."payload" = jsonb_build_object('toolCallId', callItem."content"->>'toolCallId', 'toolName', callItem."content"->>'toolName', 'taskId', owner."id"))`
  const finalSourceStart = `(SELECT MAX(sourceStart."sequence") FROM "agent_events" AS sourceStart WHERE sourceStart."sessionId" = boundSource."sessionId"
    AND sourceStart."turnId" = boundSource."turnId" AND sourceStart."taskId" = boundSource."taskId" AND sourceStart."type" = 'tool_call.started'
    AND sourceStart."actor" = 'subagent' AND sourceStart."itemId" = boundSourceCall."id"
    AND sourceStart."correlationId" = boundSourceCall."content"->>'toolCallId'
    AND sourceStart."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:tool-started:' || (boundSourceCall."content"->>'toolCallId'))`
  return `(SELECT COUNT(*) FROM jsonb_array_elements(${events}) AS projected(value) JOIN "agent_events" AS modelDone ON modelDone."id" = projected.value->>'id'
    AND modelDone."sessionId" = boundSource."sessionId" AND modelDone."turnId" = boundSource."turnId" AND modelDone."taskId" = boundSource."taskId"
      AND modelDone."type" = 'model.completed' WHERE jsonb_typeof(modelDone."payload"->'toolCallCount') = 'number'
      AND CASE WHEN modelDone."payload"->>'toolCallCount' ~ '^(0|[1-9][0-9]?)$'
        THEN (modelDone."payload"->>'toolCallCount')::integer BETWEEN ${calls} AND ${MAX_STEP_TOOL_CALLS} ELSE FALSE END
      AND ${calls} = ${distinctCalls} AND ${started} = ${callTarget} AND ${distinctStarts} = ${callTarget}
      AND ${startedCalls} = ${calls}
      AND CASE WHEN jsonb_typeof(${continuation}) = 'object' THEN ${finalSourceStart} IS NOT NULL
        ELSE (SELECT MAX(started."sequence") FROM "agent_events" AS started WHERE ${scopedStarts}) = ${finalSourceStart} END) = 1`
}

function callsExpression(): string {
  const scopedCalls = `callItem."sessionId" = boundSource."sessionId" AND callItem."turnId" = boundSource."turnId"
    AND callItem."taskId" = boundSource."taskId" AND callItem."stepId" = boundSource."id" AND callItem."type" = 'tool_call'`
  return `(SELECT COUNT(*) FROM "agent_items" AS callItem WHERE ${scopedCalls})`
}

/** Rechecks the exact seven-event current-attempt streaming wait claim and its sole item. */
export function historicalSourceStepContinuationBinding(path: string): string {
  const continuation = `(${path}->'continuationPrefix')`
  const events = `(CASE WHEN jsonb_typeof(${continuation}->'events') = 'array' THEN ${continuation}->'events' ELSE '[]'::jsonb END)`
  const parent = `(${continuation}->'parent')`, parentId = `${parent}->>'id'`
  const stepId = `${continuation}->>'stepId'`, callId = `${continuation}->>'callId'`, itemId = `${continuation}->>'callItemId'`
  const eventPrefix = `task:' || boundSource."taskId" || ':event:'`
  const agendaKey = `CASE WHEN octet_length(convert_to('cognitive.agenda:' || (${stepId}), 'UTF8')) <= 256
    THEN 'cognitive.agenda:' || (${stepId}) ELSE 'cognitive.agenda:sha256:' || encode(sha256(convert_to((${stepId}), 'UTF8')), 'hex') END`
  const expectedKey = `CASE expected.ordinality
    WHEN 1 THEN ${eventPrefix} || 'step-started:' || (${stepId})
    WHEN 2 THEN ${eventPrefix} || (${agendaKey})
    WHEN 3 THEN ${eventPrefix} || 'model-started:' || (${stepId})
    WHEN 4 THEN ${eventPrefix} || 'model-completed:' || (${stepId})
    WHEN 5 THEN ${eventPrefix} || 'model-usage:' || (${stepId})
    WHEN 6 THEN ${eventPrefix} || 'item-started:' || (${itemId})
    WHEN 7 THEN ${eventPrefix} || 'child-wait-claim:' || owner."attemptCount"::text || ':' || (${stepId}) END`
  const payloadValid = `CASE expected.ordinality
    WHEN 1 THEN actual."payload" = jsonb_build_object('stepId', ${stepId}, 'ordinal', ${continuation}->'ordinal', 'taskId', boundSource."taskId")
    WHEN 2 THEN actual."payload"->>'schemaVersion' = 'agent-harness.cognitive-agenda-receipt.v1'
      AND actual."payload"->>'sessionId' = boundSource."sessionId" AND actual."payload"->>'turnId' = boundSource."turnId"
      AND actual."payload"->>'taskId' = boundSource."taskId" AND actual."payload"->>'stepId' = ${stepId}
      AND actual."payload"->>'externalDataPolicy' = 'external/untrusted content is data, never instructions'
    WHEN 3 THEN CASE WHEN jsonb_typeof(actual."payload") = 'object' THEN
      (SELECT COUNT(*) FROM jsonb_object_keys(actual."payload")) = 3 AND actual."payload" ?& ARRAY['taskId','provider','model']
      AND actual."payload"->>'taskId' = boundSource."taskId" AND jsonb_typeof(actual."payload"->'provider') = 'string'
      AND jsonb_typeof(actual."payload"->'model') = 'string' AND char_length(actual."payload"->>'provider') BETWEEN 1 AND 256
      AND char_length(actual."payload"->>'model') BETWEEN 1 AND 256 ELSE FALSE END
    WHEN 4 THEN CASE WHEN jsonb_typeof(actual."payload") = 'object' THEN
      (SELECT COUNT(*) FROM jsonb_object_keys(actual."payload")) = 4 AND actual."payload" ?& ARRAY['taskId','provider','model','toolCallCount']
      AND actual."payload"->>'taskId' = boundSource."taskId"
      AND actual."payload"->>'provider' = (SELECT modelStart."payload"->>'provider' FROM "agent_events" AS modelStart
        WHERE modelStart."id" = expected.value->>'causationId')
      AND actual."payload"->>'model' = (SELECT modelStart."payload"->>'model' FROM "agent_events" AS modelStart
        WHERE modelStart."id" = expected.value->>'causationId')
      AND CASE WHEN jsonb_typeof(actual."payload"->'toolCallCount') = 'number'
          AND actual."payload"->>'toolCallCount' ~ '^(0|[1-9][0-9]*)$'
        THEN (actual."payload"->>'toolCallCount')::numeric BETWEEN 1 AND ${MAX_STEP_TOOL_CALLS} ELSE FALSE END ELSE FALSE END
    WHEN 5 THEN CASE WHEN jsonb_typeof(actual."payload") = 'object' THEN
      (SELECT COUNT(*) FROM jsonb_object_keys(actual."payload")) = 4 AND actual."payload" ?& ARRAY['taskId','provider','model','usage']
      AND actual."payload"->>'taskId' = boundSource."taskId"
      AND actual."payload"->>'provider' = (SELECT modelDone."payload"->>'provider' FROM "agent_events" AS modelDone
        WHERE modelDone."id" = expected.value->>'causationId')
      AND actual."payload"->>'model' = (SELECT modelDone."payload"->>'model' FROM "agent_events" AS modelDone
        WHERE modelDone."id" = expected.value->>'causationId')
      AND (actual."payload"->'usage' = 'null'::jsonb OR CASE WHEN jsonb_typeof(actual."payload"->'usage') = 'object'
        THEN (SELECT COUNT(*) FROM jsonb_object_keys(actual."payload"->'usage')) = 3
          AND actual."payload"->'usage' ?& ARRAY['inputTokens','outputTokens','estimatedCostUsd']
          AND CASE WHEN jsonb_typeof(actual."payload"->'usage'->'inputTokens') = 'number'
            THEN (actual."payload"->'usage'->>'inputTokens')::numeric >= 0 ELSE FALSE END
          AND CASE WHEN jsonb_typeof(actual."payload"->'usage'->'outputTokens') = 'number'
            THEN (actual."payload"->'usage'->>'outputTokens')::numeric >= 0 ELSE FALSE END
          AND CASE WHEN jsonb_typeof(actual."payload"->'usage'->'estimatedCostUsd') = 'number'
            THEN (actual."payload"->'usage'->>'estimatedCostUsd')::numeric >= 0 ELSE FALSE END ELSE FALSE END) ELSE FALSE END
    WHEN 6 THEN actual."payload" = jsonb_build_object('itemId', ${itemId}, 'type', 'tool_call', 'phase', NULL)
    WHEN 7 THEN actual."payload" = jsonb_build_object('toolCallId', ${callId}, 'toolName', 'wait_subagents', 'taskId', boundSource."taskId")
    ELSE FALSE END`
  const arrayChain = `(SELECT COUNT(*) FROM jsonb_array_elements(${events}) WITH ORDINALITY AS expected(value, ordinality)
    JOIN "agent_events" AS actual ON actual."id" = expected.value->>'id'
      AND actual."sessionId" = boundSource."sessionId" AND actual."turnId" = boundSource."turnId" AND actual."taskId" = boundSource."taskId"
    WHERE expected.ordinality BETWEEN 1 AND 7
      AND CASE WHEN jsonb_typeof(expected.value) = 'object' THEN
        (SELECT COUNT(*) FROM jsonb_object_keys(expected.value)) = 9
        AND expected.value ?& ARRAY['id','sequence','type','actor','itemId','correlationId','causationId','idempotencyKey','payloadDigest']
        ELSE FALSE END
      AND expected.value->>'sequence' ~ '^[1-9][0-9]{0,18}$'
      AND expected.value->>'actor' = 'subagent'
      AND expected.value->>'type' = CASE expected.ordinality WHEN 1 THEN 'step.started' WHEN 2 THEN 'cognitive.agenda'
        WHEN 3 THEN 'model.started' WHEN 4 THEN 'model.completed' WHEN 5 THEN 'model.usage'
        WHEN 6 THEN 'item.started' WHEN 7 THEN 'tool_call.started' ELSE NULL END
      AND expected.value->>'correlationId' = CASE WHEN expected.ordinality = 7 THEN ${callId} ELSE ${stepId} END
      AND expected.value->'itemId' IS NOT DISTINCT FROM CASE WHEN expected.ordinality >= 6
        THEN to_jsonb(${itemId}) ELSE 'null'::jsonb END
      AND expected.value->'causationId' IS NOT DISTINCT FROM CASE WHEN expected.ordinality = 1
        THEN to_jsonb(${parentId}) ELSE to_jsonb(${events}->(expected.ordinality - 2)->>'id') END
      AND actual."sequence"::text = expected.value->>'sequence'
      AND actual."type" = CASE expected.ordinality WHEN 1 THEN 'step.started' WHEN 2 THEN 'cognitive.agenda'
        WHEN 3 THEN 'model.started' WHEN 4 THEN 'model.completed' WHEN 5 THEN 'model.usage'
        WHEN 6 THEN 'item.started' WHEN 7 THEN 'tool_call.started' ELSE NULL END
      AND actual."actor" = 'subagent' AND actual."itemId" IS NOT DISTINCT FROM expected.value->>'itemId'
      AND actual."correlationId" = CASE WHEN expected.ordinality = 7 THEN ${callId} ELSE ${stepId} END
      AND (expected.ordinality = 1 OR actual."sequence" > (SELECT previous."sequence" FROM "agent_events" AS previous
        WHERE previous."id" = (${events}->(expected.ordinality - 2)->>'id')
          AND previous."sessionId" = boundSource."sessionId" AND previous."turnId" = boundSource."turnId"
          AND previous."taskId" = boundSource."taskId"))
      AND actual."causationId" IS NOT DISTINCT FROM CASE WHEN expected.ordinality = 1 THEN ${parentId}
        ELSE (${events}->(expected.ordinality - 2)->>'id') END
      AND actual."idempotencyKey" = ${expectedKey} AND expected.value->>'idempotencyKey' = ${expectedKey}
      AND expected.value->>'payloadDigest' ~ '^[0-9a-f]{64}$'
      AND encode(sha256(convert_to(actual."payload"::text,'UTF8')),'hex') = expected.value->>'payloadDigest'
      AND actual."sequence" BETWEEN (SELECT anchor."sequence" FROM "agent_events" AS anchor
        WHERE anchor."id" = (${path}->'events'->0->>'id') AND anchor."sessionId" = boundSource."sessionId"
          AND anchor."turnId" = boundSource."turnId" AND anchor."taskId" = boundSource."taskId")
        AND (SELECT anchor."sequence" FROM "agent_events" AS anchor
          WHERE anchor."id" = (${path}->'events'->(jsonb_array_length(${path}->'events') - 1)->>'id')
            AND anchor."sessionId" = boundSource."sessionId" AND anchor."turnId" = boundSource."turnId" AND anchor."taskId" = boundSource."taskId")
      AND ${payloadValid}) = 7`
  const parentBinding = `CASE WHEN jsonb_typeof(${parent}) = 'object' THEN
    (SELECT COUNT(*) FROM jsonb_object_keys(${parent})) = 3 AND ${parent} ?& ARRAY['id','sequence','payloadDigest']
    AND char_length(${parentId}) BETWEEN 1 AND 256 AND ${parentId} = btrim(${parentId})
    AND (${parent}->>'sequence') ~ '^[1-9][0-9]{0,18}$' AND (${parent}->>'payloadDigest') ~ '^[0-9a-f]{64}$'
    AND ${events}->0->>'causationId' = ${parentId}
    AND EXISTS (SELECT 1 FROM "agent_events" AS parentEvent WHERE parentEvent."id" = ${parentId}
      AND parentEvent."sessionId" = boundSource."sessionId" AND parentEvent."turnId" = boundSource."turnId"
      AND parentEvent."taskId" = boundSource."taskId" AND parentEvent."sequence"::text = ${parent}->>'sequence'
      AND parentEvent."type" = 'task.started' AND parentEvent."actor" = 'subagent' AND parentEvent."itemId" IS NULL
      AND parentEvent."correlationId" = boundSource."turnId" AND parentEvent."causationId" IS NULL
      AND parentEvent."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:turn-started'
      AND CASE WHEN jsonb_typeof(parentEvent."payload") = 'object' THEN
        (SELECT COUNT(*) FROM jsonb_object_keys(parentEvent."payload")) = 3
        AND parentEvent."payload" ?& ARRAY['goal','taskId','rootTaskId']
        AND jsonb_typeof(parentEvent."payload"->'goal') = 'string'
        AND char_length(parentEvent."payload"->>'goal') > 0
        AND parentEvent."payload"->>'taskId' = boundSource."taskId"
        AND parentEvent."payload"->>'rootTaskId' = owner."rootTaskId" ELSE FALSE END
      AND encode(sha256(convert_to(parentEvent."payload"::text,'UTF8')),'hex') = ${parent}->>'payloadDigest'
      AND parentEvent."sequence" < (SELECT firstEvent."sequence" FROM "agent_events" AS firstEvent
        WHERE firstEvent."id" = ${events}->0->>'id' AND firstEvent."sessionId" = boundSource."sessionId"
          AND firstEvent."turnId" = boundSource."turnId" AND firstEvent."taskId" = boundSource."taskId"))
    AND (SELECT COUNT(*) FROM "agent_events" AS duplicateParent WHERE duplicateParent."sessionId" = boundSource."sessionId"
      AND duplicateParent."turnId" = boundSource."turnId" AND duplicateParent."taskId" = boundSource."taskId"
      AND duplicateParent."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:turn-started') = 1
  ELSE FALSE END`
  return `CASE WHEN jsonb_typeof(${continuation}) = 'object' THEN
    (SELECT COUNT(*) FROM jsonb_object_keys(${continuation})) = 8
    AND ${continuation} ?& ARRAY['stepId','attempt','ordinal','callItemId','callId','parent','events','item']
    AND jsonb_array_length(${events}) = 7 AND ${continuation}->>'attempt' = owner."attemptCount"::text
    AND char_length(${stepId}) BETWEEN 1 AND 256 AND ${stepId} = btrim(${stepId}) AND ${stepId} <> boundSource."id"
    AND char_length(${callId}) BETWEEN 1 AND 256 AND ${callId} = btrim(${callId})
    AND ${callId} <> boundSourceCall."content"->>'toolCallId'
    AND char_length(${itemId}) BETWEEN 1 AND 512 AND ${itemId} = btrim(${itemId}) AND ${itemId} <> boundSourceCall."id"
    AND ${continuation}->>'ordinal' ~ '^(0|[1-9][0-9]*)$'
    AND EXISTS (SELECT 1 FROM "agent_steps" AS successor WHERE successor."id" = ${stepId}
      AND successor."sessionId" = boundSource."sessionId" AND successor."turnId" = boundSource."turnId"
      AND successor."taskId" = boundSource."taskId" AND successor."attempt" = owner."attemptCount"
      AND successor."ordinal"::text = ${continuation}->>'ordinal' AND successor."status" = 'streaming'
      AND successor."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later WHERE later."sessionId" = boundSource."sessionId"
        AND later."turnId" = boundSource."turnId" AND later."taskId" = boundSource."taskId"
        AND later."attempt" = owner."attemptCount" AND later."ordinal" > boundSource."ordinal")
      AND (SELECT COUNT(*) FROM "agent_steps" AS uniqueSuccessor WHERE uniqueSuccessor."sessionId" = successor."sessionId"
        AND uniqueSuccessor."turnId" = successor."turnId" AND uniqueSuccessor."taskId" = successor."taskId"
        AND uniqueSuccessor."attempt" = successor."attempt" AND uniqueSuccessor."ordinal" = successor."ordinal") = 1
      AND EXISTS (SELECT 1 FROM "agent_items" AS continuationItem WHERE continuationItem."id" = ${itemId}
        AND continuationItem."sessionId" = successor."sessionId" AND continuationItem."turnId" = successor."turnId"
        AND continuationItem."taskId" = successor."taskId" AND continuationItem."stepId" = successor."id"
        AND continuationItem."type" = 'tool_call' AND continuationItem."status" = 'started'
        AND continuationItem."revision" = 0 AND continuationItem."phase" IS NULL
        AND continuationItem."id" = 'task:' || boundSource."taskId" || ':item:tool-call:' || (${callId}) || ':attempt:' || owner."attemptCount"::text
        AND (SELECT COUNT(*) FROM "agent_items" AS onlyItem WHERE onlyItem."sessionId" = successor."sessionId"
          AND onlyItem."turnId" = successor."turnId" AND onlyItem."taskId" = successor."taskId" AND onlyItem."stepId" = successor."id") = 1
        AND CASE WHEN jsonb_typeof(continuationItem."content") = 'object' THEN
          (SELECT COUNT(*) FROM jsonb_object_keys(continuationItem."content")) = 4
          AND continuationItem."content" ?& ARRAY['toolCallId','toolName','toolVersion','input'] ELSE FALSE END
        AND continuationItem."content"->>'toolCallId' = ${callId} AND continuationItem."content"->>'toolName' = 'wait_subagents'
        AND continuationItem."content"->>'toolVersion' = '1'
        AND continuationItem."content"->'input' = boundSourceCall."content"->'input'
        AND continuationItem."content"->>'toolCallId' <> boundSourceCall."content"->>'toolCallId'
        AND continuationItem."id" <> boundSourceCall."id"
        AND encode(sha256(convert_to(continuationItem."content"::text,'UTF8')),'hex') = (${continuation}->'item'->>'contentDigest')))
    AND CASE WHEN jsonb_typeof(${continuation}->'item') = 'object' THEN
      (SELECT COUNT(*) FROM jsonb_object_keys(${continuation}->'item')) = 6
      AND ${continuation}->'item' ?& ARRAY['id','type','status','revision','phase','contentDigest'] ELSE FALSE END
    AND ${continuation}->'item'->>'id' = ${itemId} AND ${continuation}->'item'->>'type' = 'tool_call'
    AND ${continuation}->'item'->>'status' = 'started' AND ${continuation}->'item'->>'revision' = '0'
    AND ${continuation}->'item'->'phase' = 'null'::jsonb
    AND ${continuation}->'item'->>'contentDigest' ~ '^[0-9a-f]{64}$' AND ${parentBinding} AND ${arrayChain}
    AND NOT EXISTS (SELECT 1 FROM "agent_events" AS terminal WHERE terminal."sessionId" = boundSource."sessionId"
      AND terminal."turnId" = boundSource."turnId" AND terminal."taskId" = boundSource."taskId"
      AND ((terminal."type" = 'step.completed' AND (terminal."correlationId" = ${stepId}
          OR terminal."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:step-completed:' || (${stepId})))
        OR (terminal."type" IN ('tool_call.completed','tool_call.failed','tool_call.interrupted')
          AND (terminal."correlationId" = ${callId} OR terminal."itemId" = ${itemId}))
        OR (terminal."type" IN ('item.completed','item.failed') AND terminal."itemId" = ${itemId})))
    AND (SELECT COUNT(DISTINCT value->>'id') FROM jsonb_array_elements(${events}) AS event(value)) = 7
    AND (SELECT COUNT(DISTINCT value->>'idempotencyKey') FROM jsonb_array_elements(${events}) AS event(value)) = 7
    AND (SELECT COUNT(DISTINCT event."sequence") FROM jsonb_array_elements(${events}) AS expected(value)
      JOIN "agent_events" AS event ON event."id" = expected.value->>'id'
        AND event."sessionId" = boundSource."sessionId" AND event."turnId" = boundSource."turnId" AND event."taskId" = boundSource."taskId") = 7
    AND NOT EXISTS (SELECT 1 FROM "agent_events" AS extra WHERE extra."sessionId" = boundSource."sessionId"
      AND extra."turnId" = boundSource."turnId" AND extra."taskId" = boundSource."taskId"
      AND (extra."causationId" IN (SELECT event.value->>'id' FROM jsonb_array_elements(${events}) AS event(value))
        OR extra."correlationId" = ${stepId} OR extra."correlationId" = ${callId} OR extra."itemId" = ${itemId})
      AND extra."id" NOT IN (SELECT event.value->>'id' FROM jsonb_array_elements(${events}) AS event(value)))
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${events}) AS expected(value)
      JOIN "agent_events" AS descendant ON descendant."sessionId" = boundSource."sessionId"
        AND descendant."turnId" = boundSource."turnId" AND descendant."taskId" = boundSource."taskId"
        AND descendant."causationId" = expected.value->>'id'
      WHERE NOT (descendant."id" IN (SELECT event.value->>'id' FROM jsonb_array_elements(${events}) AS event(value))))
  ELSE FALSE END`
}

