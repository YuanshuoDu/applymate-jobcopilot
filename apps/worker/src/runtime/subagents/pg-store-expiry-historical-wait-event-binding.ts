import { MAX_STEP_TOOL_CALLS } from "./pg-store-expiry-step-tool-chain-proof.js"
import { historicalSourceStepCallChainBinding, historicalSourceStepCallCountBinding, historicalSourceStepEventChainBinding } from "./pg-store-expiry-historical-source-step-prefix.js"

const targets = `CASE WHEN jsonb_typeof(boundWait."targetTaskIds") = 'array' THEN boundWait."targetTaskIds" ELSE '[]'::jsonb END`
const handoff = "proof.value->'sourceStepHandoff'", handoffEvents = `(CASE WHEN jsonb_typeof(${handoff}->'events') = 'array' THEN ${handoff}->'events' ELSE '[]'::jsonb END)`
const handoffKeys = "'schemaVersion','waitId','stepId','attempt','sourceCallItemId','sourceCallId','sourceResultItemId','events','sourceStepPrefix'"
const anchorKey = (suffix: string) => `'task:' || owner."id" || ':event:${suffix}' || boundSource."id"`
const agendaKey = `(CASE WHEN octet_length(convert_to('cognitive.agenda:' || boundSource."id", 'UTF8')) <= 256
  THEN 'cognitive.agenda:' || boundSource."id" ELSE 'cognitive.agenda:sha256:' || encode(sha256(convert_to(boundSource."id", 'UTF8')), 'hex') END)`
const sourcePrefixBinding = (path: string) => {
  const prefixEvents = `(CASE WHEN jsonb_typeof(${path}->'events') = 'array' THEN ${path}->'events' ELSE '[]'::jsonb END)`
  const prefixItems = `(CASE WHEN jsonb_typeof(${path}->'items') = 'array' THEN ${path}->'items' ELSE '[]'::jsonb END)`
  return `CASE WHEN jsonb_typeof(${path}) = 'object' THEN
    (SELECT COUNT(*) FROM jsonb_object_keys(${path})) = 11 AND ${path} ?& ARRAY['stepId','attempt','sourceCallItemId','sourceCallId',
      'sourceResultItemId','waitKind','terminalMode','stepStartedEventId','stepCompletedEventId','events','items']
    AND ${path}->>'stepId' = boundSource."id" AND ${path}->>'attempt' = boundSource."attempt"::text
    AND ${path}->>'sourceCallItemId' = boundSourceCall."id" AND ${path}->>'sourceCallId' = boundSourceCall."content"->>'toolCallId'
    AND ${path}->>'sourceResultItemId' = boundSourceResult."id" AND ${path}->>'waitKind' = proof.value->'sourceWait'->>'sourceKind'
    AND ${path}->>'terminalMode' IN ('step_completed','recovered_handoff')
    AND ${path}->>'stepStartedEventId' = ${prefixEvents}->0->>'id'
    AND CASE WHEN ${path}->>'terminalMode' = 'step_completed' THEN
      jsonb_array_length(${prefixEvents}) BETWEEN 12 AND ${MAX_STEP_TOOL_CALLS * 9 + 16}
      AND ${path}->>'stepCompletedEventId' = ${prefixEvents}->(jsonb_array_length(${prefixEvents}) - 1)->>'id'
      AND ${prefixEvents}->(jsonb_array_length(${prefixEvents}) - 1)->>'type' = 'step.completed'
    ELSE jsonb_array_length(${prefixEvents}) BETWEEN 11 AND ${MAX_STEP_TOOL_CALLS * 9 + 16}
      AND proof.value->'sourceWait'->>'sourceKind' = 'recovered' AND boundSource."status" = 'waiting_for_tool'
      AND ${path}->'stepCompletedEventId' = 'null'::jsonb
      AND ${prefixEvents}->(jsonb_array_length(${prefixEvents}) - 1)->>'id' = sourceResultCompleted."id"
      AND ${prefixEvents}->(jsonb_array_length(${prefixEvents}) - 1)->>'type' = 'item.completed'
      AND NOT EXISTS (SELECT 1 FROM "agent_events" AS sourceStepDone WHERE sourceStepDone."sessionId" = boundSource."sessionId"
        AND sourceStepDone."turnId" = boundSource."turnId" AND sourceStepDone."taskId" = boundSource."taskId"
        AND sourceStepDone."type" = 'step.completed' AND (sourceStepDone."correlationId" = boundSource."id"
          OR sourceStepDone."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:step-completed:' || boundSource."id")) END
    AND jsonb_array_length(${prefixItems}) BETWEEN 2 AND ${MAX_STEP_TOOL_CALLS * 2 + 2}
    AND (SELECT COUNT(*) FROM jsonb_array_elements(${prefixEvents}) AS expected(value)
      JOIN "agent_events" AS exactEvent ON exactEvent."id" = expected.value->>'id'
        AND exactEvent."sessionId" = boundSource."sessionId" AND exactEvent."turnId" = boundSource."turnId" AND exactEvent."taskId" = boundSource."taskId"
      WHERE exactEvent."sequence"::text = expected.value->>'sequence' AND exactEvent."type" = expected.value->>'type'
        AND exactEvent."actor" = expected.value->>'actor' AND exactEvent."itemId" IS NOT DISTINCT FROM expected.value->>'itemId'
        AND exactEvent."correlationId" = expected.value->>'correlationId' AND exactEvent."causationId" IS NOT DISTINCT FROM expected.value->>'causationId'
        AND exactEvent."idempotencyKey" = expected.value->>'idempotencyKey'
        AND CASE WHEN exactEvent."type" IN ('tool_call.completed','tool_call.failed') THEN exactEvent."payload" ? 'status'
          AND exactEvent."payload"->>'status' = expected.value->>'status' AND exactEvent."payload" ? 'errorCode'
          AND exactEvent."payload"->'errorCode' = expected.value->'errorCode' ELSE NOT (expected.value ? 'status' OR expected.value ? 'errorCode') END
        AND encode(sha256(convert_to(exactEvent."payload"::text,'UTF8')),'hex') = expected.value->>'payloadDigest') = jsonb_array_length(${prefixEvents})
    AND ${historicalSourceStepEventChainBinding(path)} AND ${historicalSourceStepCallChainBinding(path)} AND ${historicalSourceStepCallCountBinding(path)}
    AND (SELECT COUNT(DISTINCT expected.value->>'id') FROM jsonb_array_elements(${prefixEvents}) AS expected(value)) = jsonb_array_length(${prefixEvents})
    AND (SELECT COUNT(*) FROM jsonb_array_elements(${prefixEvents}) AS expected(value) WHERE CASE WHEN jsonb_typeof(expected.value) = 'object' THEN
      CASE WHEN expected.value->>'type' IN ('tool_call.completed','tool_call.failed') THEN
        (SELECT COUNT(*) FROM jsonb_object_keys(expected.value)) = 11 AND expected.value ?& ARRAY['id','sequence','type','actor','itemId','correlationId','causationId','idempotencyKey','payloadDigest','status','errorCode']
        AND ((expected.value->>'type' = 'tool_call.completed' AND expected.value->>'status' = 'completed' AND expected.value->'errorCode' = 'null'::jsonb)
          OR (expected.value->>'type' = 'tool_call.failed' AND expected.value->>'status' IN ('failed','cancelled')
            AND jsonb_typeof(expected.value->'errorCode') IN ('null','string') AND (expected.value->'errorCode' = 'null'::jsonb
              OR expected.value->>'errorCode' ~ '^[A-Za-z0-9_.:-]{1,128}$') AND COALESCE(expected.value->>'errorCode','')
              NOT IN ('policy_requires_approval','policy_requires_user_input','gmail_oauth_required','session_pause_requested')))
      ELSE (SELECT COUNT(*) FROM jsonb_object_keys(expected.value)) = 9
        AND expected.value ?& ARRAY['id','sequence','type','actor','itemId','correlationId','causationId','idempotencyKey','payloadDigest']
        AND NOT (expected.value ? 'status' OR expected.value ? 'errorCode') END ELSE FALSE END
      AND expected.value->>'payloadDigest' ~ '^[0-9a-f]{64}$' AND expected.value->>'sequence' ~ '^[1-9][0-9]{0,18}$') = jsonb_array_length(${prefixEvents})
    AND (SELECT COUNT(*) FROM "agent_events" AS ordered WHERE ordered."sessionId" = boundSource."sessionId"
      AND ordered."turnId" = boundSource."turnId" AND ordered."taskId" = boundSource."taskId"
      AND ordered."sequence" BETWEEN (${prefixEvents}->0->>'sequence')::bigint
        AND (${prefixEvents}->(jsonb_array_length(${prefixEvents}) - 1)->>'sequence')::bigint) = jsonb_array_length(${prefixEvents})
    AND NOT EXISTS (SELECT 1 FROM "agent_events" AS extra WHERE extra."sessionId" = boundSource."sessionId"
      AND extra."turnId" = boundSource."turnId" AND extra."taskId" = boundSource."taskId"
      AND (extra."correlationId" = boundSource."id" OR extra."itemId" IN (SELECT item."id" FROM "agent_items" AS item
        WHERE item."sessionId" = boundSource."sessionId" AND item."turnId" = boundSource."turnId" AND item."taskId" = boundSource."taskId" AND item."stepId" = boundSource."id"))
      AND extra."id" NOT IN (SELECT expected.value->>'id' FROM jsonb_array_elements(${prefixEvents}) AS expected(value)))
    AND (SELECT COUNT(*) FROM jsonb_array_elements(${prefixItems}) AS expected(value)
      JOIN "agent_items" AS exactItem ON exactItem."id" = expected.value->>'id' AND exactItem."sessionId" = boundSource."sessionId"
        AND exactItem."turnId" = boundSource."turnId" AND exactItem."taskId" = boundSource."taskId" AND exactItem."stepId" = boundSource."id"
      WHERE exactItem."type" = expected.value->>'type' AND exactItem."status" = expected.value->>'status'
        AND exactItem."revision"::text = expected.value->>'revision' AND exactItem."phase" IS NOT DISTINCT FROM expected.value->>'phase'
        AND encode(sha256(convert_to(exactItem."content"::text,'UTF8')),'hex') = expected.value->>'contentDigest') = jsonb_array_length(${prefixItems})
    AND (SELECT COUNT(DISTINCT expected.value->>'id') FROM jsonb_array_elements(${prefixItems}) AS expected(value)) = jsonb_array_length(${prefixItems})
    AND (SELECT COUNT(*) FROM jsonb_array_elements(${prefixItems}) AS expected(value) WHERE CASE WHEN jsonb_typeof(expected.value) = 'object' THEN
      (SELECT COUNT(*) FROM jsonb_object_keys(expected.value)) = 6 AND expected.value ?& ARRAY['id','type','status','revision','phase','contentDigest']
      ELSE FALSE END AND expected.value->>'contentDigest' ~ '^[0-9a-f]{64}$') = jsonb_array_length(${prefixItems})
    AND jsonb_array_length(${prefixItems}) = (SELECT COUNT(*) FROM "agent_items" AS scopedItem
      WHERE scopedItem."sessionId" = boundSource."sessionId" AND scopedItem."turnId" = boundSource."turnId"
        AND scopedItem."taskId" = boundSource."taskId" AND scopedItem."stepId" = boundSource."id")
  ELSE FALSE END`
}
export const HISTORICAL_SOURCE_STEP_PREFIX_SQL = sourcePrefixBinding("proof.value->'sourceStepPrefix'")
/** Source call closure is independent of step completion and only supports a recovered, still-waiting step. */
const sourcePrefixEventsInHandoff = `(CASE WHEN jsonb_typeof(${handoff}->'sourceStepPrefix'->'events') = 'array'
  THEN ${handoff}->'sourceStepPrefix'->'events' ELSE '[]'::jsonb END)`
export const HISTORICAL_SOURCE_WAIT_HANDOFF_SQL = `CASE WHEN jsonb_typeof(${handoff}) = 'object' THEN
  CASE WHEN (SELECT COUNT(*) FROM jsonb_object_keys(${handoff})) = 9 AND ${handoff} ?& ARRAY[${handoffKeys}]
    AND ${handoff}->>'schemaVersion' = 'recovered_wait_handoff.v1' AND ${handoff}->>'waitId' = boundWait."id"
    AND ${handoff}->>'stepId' = boundSource."id" AND ${handoff}->>'attempt' = boundSource."attempt"::text
    AND ${handoff}->>'sourceCallItemId' = boundSourceCall."id" AND ${handoff}->>'sourceCallId' = boundSourceCall."content"->>'toolCallId'
    AND ${handoff}->>'sourceResultItemId' = boundSourceResult."id" AND jsonb_array_length(${handoffEvents}) = 6
    AND proof.value->'sourceWait'->>'sourceKind' = 'recovered'
    AND ${sourcePrefixBinding(`${handoff}->'sourceStepPrefix'`)}
    AND (SELECT COUNT(*) FROM jsonb_array_elements(${handoffEvents}) AS anchor(value)
      JOIN jsonb_array_elements(${sourcePrefixEventsInHandoff}) AS fullEvent(value) ON anchor.value = fullEvent.value) = 6
    AND ${handoffEvents}->0->>'type' = 'step.started' AND ${handoffEvents}->0->>'idempotencyKey' = ${anchorKey('step-started:')}
    AND ${handoffEvents}->1->>'type' = 'cognitive.agenda' AND ${handoffEvents}->1->>'idempotencyKey' = 'task:' || owner."id" || ':event:' || ${agendaKey}
    AND ${handoffEvents}->2->>'type' = 'model.started' AND ${handoffEvents}->2->>'idempotencyKey' = ${anchorKey('model-started:')}
    AND ${handoffEvents}->3->>'type' = 'model.completed' AND ${handoffEvents}->3->>'idempotencyKey' = ${anchorKey('model-completed:')}
    AND ${handoffEvents}->4->>'type' = 'model.usage' AND ${handoffEvents}->4->>'idempotencyKey' = ${anchorKey('model-usage:')}
    AND ${handoffEvents}->5->>'type' = 'item.started' AND ${handoffEvents}->5->>'idempotencyKey' = 'task:' || owner."id" || ':event:item-started:' || boundSourceCall."id"
    AND ${handoffEvents}->5->>'id' = sourceItemStarted."id" AND ${handoffEvents}->5->>'itemId' = boundSourceCall."id"
  THEN TRUE ELSE FALSE END ELSE FALSE END`

/** Claims retain their own proof; this only selects which exact source-step evidence is carried. */
export const HISTORICAL_SOURCE_STEP_BINDING_SQL = `CASE
  WHEN proof.value ? 'sourceStepPrefix' AND NOT (proof.value ? 'sourceStepHandoff') THEN ${HISTORICAL_SOURCE_STEP_PREFIX_SQL}
  WHEN proof.value ? 'sourceStepHandoff' AND NOT (proof.value ? 'sourceStepPrefix') THEN ${HISTORICAL_SOURCE_WAIT_HANDOFF_SQL}
  ELSE FALSE END`

/** Revalidates the exact recovered source lifecycle chain in the final settlement statement. */
export const CHILD_WAIT_HISTORICAL_SOURCE_EVENT_BINDING_SQL = `EXISTS (SELECT 1 FROM "agent_events" AS sourceItemStarted
  JOIN "agent_events" AS sourceCallStarted ON sourceCallStarted."sessionId" = sourceItemStarted."sessionId"
    AND sourceCallStarted."turnId" = sourceItemStarted."turnId" AND sourceCallStarted."taskId" = sourceItemStarted."taskId"
    AND sourceCallStarted."causationId" = sourceItemStarted."id" AND sourceCallStarted."sequence" > sourceItemStarted."sequence"
  JOIN "agent_events" AS sourceCallCompleted ON sourceCallCompleted."sessionId" = sourceCallStarted."sessionId"
    AND sourceCallCompleted."turnId" = sourceCallStarted."turnId" AND sourceCallCompleted."taskId" = sourceCallStarted."taskId"
    AND sourceCallCompleted."causationId" = sourceCallStarted."id" AND sourceCallCompleted."sequence" > sourceCallStarted."sequence"
  JOIN "agent_events" AS sourceTerminal ON sourceTerminal."sessionId" = sourceCallCompleted."sessionId"
    AND sourceTerminal."turnId" = sourceCallCompleted."turnId" AND sourceTerminal."taskId" = sourceCallCompleted."taskId"
    AND sourceTerminal."causationId" = sourceCallCompleted."id" AND sourceTerminal."sequence" > sourceCallCompleted."sequence"
  JOIN "agent_events" AS sourceResultStarted ON sourceResultStarted."sessionId" = sourceTerminal."sessionId"
    AND sourceResultStarted."turnId" = sourceTerminal."turnId" AND sourceResultStarted."taskId" = sourceTerminal."taskId"
    AND sourceResultStarted."causationId" = sourceTerminal."id" AND sourceResultStarted."sequence" > sourceTerminal."sequence"
  JOIN "agent_events" AS sourceResultCompleted ON sourceResultCompleted."sessionId" = sourceResultStarted."sessionId"
    AND sourceResultCompleted."turnId" = sourceResultStarted."turnId" AND sourceResultCompleted."taskId" = sourceResultStarted."taskId"
    AND sourceResultCompleted."causationId" = sourceResultStarted."id" AND sourceResultCompleted."sequence" > sourceResultStarted."sequence"
  WHERE sourceItemStarted."sessionId" = boundSourceCall."sessionId" AND sourceItemStarted."turnId" = boundSourceCall."turnId"
    AND sourceItemStarted."taskId" = boundSourceCall."taskId" AND sourceItemStarted."itemId" = boundSourceCall."id"
    AND sourceItemStarted."type" = 'item.started' AND sourceItemStarted."actor" = 'subagent'
    AND sourceItemStarted."correlationId" = boundSource."id"
    AND sourceItemStarted."idempotencyKey" = 'task:' || owner."id" || ':event:item-started:' || boundSourceCall."id"
    AND sourceItemStarted."payload" = jsonb_build_object('itemId', boundSourceCall."id", 'type', 'tool_call', 'phase', NULL)
    AND sourceCallStarted."itemId" = boundSourceCall."id" AND sourceCallStarted."type" = 'tool_call.started'
    AND sourceCallStarted."actor" = 'subagent' AND sourceCallStarted."correlationId" = boundSourceCall."content"->>'toolCallId'
    AND sourceCallStarted."idempotencyKey" = 'task:' || owner."id" || ':event:tool-started:' || (boundSourceCall."content"->>'toolCallId')
    AND sourceCallStarted."payload" = jsonb_build_object('toolCallId', boundSourceCall."content"->>'toolCallId',
      'toolName', 'wait_subagents', 'taskId', owner."id")
    AND sourceCallCompleted."itemId" = boundSourceCall."id" AND sourceCallCompleted."type" = 'item.completed'
    AND sourceCallCompleted."actor" = 'subagent' AND sourceCallCompleted."correlationId" = boundSourceCall."id"
    AND sourceCallCompleted."idempotencyKey" = 'task:' || owner."id" || ':event:tool-call-completed:'
      || (boundSourceCall."content"->>'toolCallId') || ':' || boundSourceCall."id" || ':1'
    AND sourceCallCompleted."payload" = jsonb_build_object('itemId', boundSourceCall."id", 'status', 'completed', 'content',
      jsonb_build_object('toolName', 'wait_subagents', 'toolVersion', '1', 'status', 'completed', 'errorCode', NULL,
        'toolCallId', proof.value->'sourceWait'->>'projectedSourceCallId', 'input', jsonb_build_object('idempotencyKey', '[REDACTED]',
          'taskIds', (SELECT jsonb_agg(to_jsonb('[REDACTED]'::text) ORDER BY target.ordinal)
            FROM generate_series(1, jsonb_array_length(${targets})) AS target(ordinal)),
          'mode', boundWait."mode", 'timeoutMs', boundWait."result"->'request'->'timeoutMs')))
    AND sourceTerminal."itemId" = boundSourceCall."id" AND sourceTerminal."type" = 'tool_call.completed'
    AND sourceTerminal."actor" = 'subagent' AND sourceTerminal."correlationId" = boundSourceCall."content"->>'toolCallId'
    AND sourceTerminal."idempotencyKey" = 'task:' || owner."id" || ':event:tool-finished:' || (boundSourceCall."content"->>'toolCallId')
    AND sourceTerminal."payload" = jsonb_build_object('toolCallId', boundSourceCall."content"->>'toolCallId',
      'toolName', 'wait_subagents', 'status', 'completed', 'errorCode', NULL, 'taskId', owner."id")
    AND sourceResultStarted."itemId" = boundSourceResult."id" AND sourceResultStarted."type" = 'item.started'
    AND sourceResultStarted."actor" = 'subagent' AND sourceResultStarted."correlationId" = boundSource."id"
    AND sourceResultStarted."idempotencyKey" = 'task:' || owner."id" || ':event:item-started:' || boundSourceResult."id"
    AND sourceResultStarted."payload" = jsonb_build_object('itemId', boundSourceResult."id", 'type', 'tool_result', 'phase', NULL)
    AND sourceResultCompleted."itemId" = boundSourceResult."id" AND sourceResultCompleted."type" = 'item.completed'
    AND sourceResultCompleted."actor" = 'subagent' AND sourceResultCompleted."correlationId" = boundSourceResult."id"
    AND sourceResultCompleted."idempotencyKey" = 'task:' || owner."id" || ':event:tool-result-completed:'
      || (boundSourceCall."content"->>'toolCallId') || ':' || boundSourceResult."id" || ':1'
    AND sourceResultCompleted."payload" = jsonb_build_object('itemId', boundSourceResult."id", 'status', 'completed',
      'content', boundSourceResult."content")
    AND ${HISTORICAL_SOURCE_STEP_BINDING_SQL}
    AND (SELECT COUNT(*) FROM "agent_events" AS sourceEvent WHERE sourceEvent."sessionId" = boundSourceCall."sessionId"
      AND sourceEvent."turnId" = boundSourceCall."turnId" AND sourceEvent."taskId" = boundSourceCall."taskId"
      AND sourceEvent."idempotencyKey" = ANY(ARRAY[
        'task:' || owner."id" || ':event:item-started:' || boundSourceCall."id",
        'task:' || owner."id" || ':event:tool-started:' || (boundSourceCall."content"->>'toolCallId'),
        'task:' || owner."id" || ':event:tool-call-completed:' || (boundSourceCall."content"->>'toolCallId') || ':' || boundSourceCall."id" || ':1',
        'task:' || owner."id" || ':event:tool-finished:' || (boundSourceCall."content"->>'toolCallId'),
        'task:' || owner."id" || ':event:item-started:' || boundSourceResult."id",
        'task:' || owner."id" || ':event:tool-result-completed:' || (boundSourceCall."content"->>'toolCallId') || ':' || boundSourceResult."id" || ':1'
      ])) = 6
    AND NOT EXISTS (SELECT 1 FROM "agent_events" AS extra WHERE extra."sessionId" = boundSourceCall."sessionId"
      AND extra."turnId" = boundSourceCall."turnId" AND extra."taskId" = boundSourceCall."taskId"
      AND (extra."itemId" IN (boundSourceCall."id", boundSourceResult."id")
        OR extra."correlationId" IN (boundSourceCall."content"->>'toolCallId', boundSourceCall."id", boundSourceResult."id")
        OR extra."causationId" IN (sourceItemStarted."id", sourceCallStarted."id", sourceCallCompleted."id", sourceTerminal."id", sourceResultStarted."id"))
      AND extra."id" NOT IN (sourceItemStarted."id", sourceCallStarted."id", sourceCallCompleted."id", sourceTerminal."id",
        sourceResultStarted."id", sourceResultCompleted."id")))`

const exactObject = (expression: string, count: number) => `CASE WHEN jsonb_typeof(${expression}) = 'object'
  THEN (SELECT COUNT(*) FROM jsonb_object_keys(${expression})) = ${count} ELSE FALSE END`
const targetArray = `CASE WHEN jsonb_typeof(boundWait."targetTaskIds") = 'array' THEN boundWait."targetTaskIds" ELSE '[]'::jsonb END`
const waitingSnapshots = `CASE WHEN jsonb_typeof(boundSourceResult."content"->'output'->'tasks') = 'array'
  THEN boundSourceResult."content"->'output'->'tasks' ELSE '[]'::jsonb END`
const terminalStatuses = "'completed', 'failed', 'interrupted', 'cancelled', 'closed', 'passed', 'skipped'"

/** Distinguishes an ordinary registration receipt from a marked crash-recovery result. */
export const CHILD_WAIT_HISTORICAL_SOURCE_RESULT_RECEIPT_SQL = `CASE
  WHEN proof.value->'sourceWait'->>'sourceKind' = 'normal_waiting' THEN
    proof.value->'sourceWait'->'sourceLifecycleRecoveryOwnerDigest' = 'null'::jsonb
    AND
    ${exactObject('boundSourceResult."content"', 3)}
    AND boundSourceResult."content" = jsonb_build_object('toolCallId', boundSourceCall."content"->>'toolCallId',
      'output', boundSourceResult."content"->'output', 'errorCode', NULL)
    AND boundSourceResult."id" = 'task:' || owner."id" || ':item:tool-result:' || (boundSourceCall."content"->>'toolCallId')
      || ':attempt:' || boundSource."attempt"::text
    AND ${exactObject('boundSourceResult."content"->\'output\'', 6)}
    AND boundSourceResult."content"->'output' ?& ARRAY['waitId','status','taskIds','deadlineAt','matchedTaskIds','tasks']
    AND boundSourceResult."content"->'output'->>'waitId' = boundWait."id"
    AND boundSourceResult."content"->'output'->>'status' = 'waiting'
    AND boundSourceResult."content"->'output'->'taskIds' = boundWait."targetTaskIds"
    AND boundSourceResult."content"->'output'->>'deadlineAt' = proof.value->'sourceWait'->>'deadlineAt'
    AND boundSourceResult."content"->'output'->'matchedTaskIds' = '[]'::jsonb
    AND jsonb_array_length(${waitingSnapshots}) = jsonb_array_length(${targetArray})
    AND (SELECT COUNT(*) FROM jsonb_array_elements(${waitingSnapshots}) AS saved(value)
      WHERE CASE WHEN jsonb_typeof(saved.value) = 'object' THEN
        (SELECT COUNT(*) FROM jsonb_object_keys(saved.value)) = 5
          AND saved.value ?& ARRAY['taskId','status','role','result','failureReason']
          AND jsonb_typeof(saved.value->'taskId') = 'string' AND char_length(saved.value->>'taskId') BETWEEN 1 AND 256
          AND btrim(saved.value->>'taskId') = saved.value->>'taskId'
          AND saved.value->>'status' IN ('queued','running','retrying','waiting','waiting_for_user',${terminalStatuses})
          AND jsonb_typeof(saved.value->'role') = 'string' AND char_length(saved.value->>'role') BETWEEN 1 AND 80
          AND btrim(saved.value->>'role') <> '' AND jsonb_typeof(saved.value->'failureReason') IN ('null','string')
          AND (jsonb_typeof(saved.value->'failureReason') = 'null' OR char_length(saved.value->>'failureReason') <= 256)
        ELSE FALSE END) = jsonb_array_length(${targetArray})
    AND (SELECT ARRAY(SELECT saved.value->>'taskId' FROM jsonb_array_elements(${waitingSnapshots}) AS saved(value) ORDER BY 1))
      = (SELECT ARRAY(SELECT target.id FROM jsonb_array_elements_text(${targetArray}) AS target(id) ORDER BY 1))
  WHEN proof.value->'sourceWait'->>'sourceKind' = 'recovered' THEN
    ${exactObject('boundWait."result"->\'sourceLifecycleRecovery\'', 13)}
    AND boundWait."result"->'sourceLifecycleRecovery' ?& ARRAY['schemaVersion','userId','sessionId','turnId','rootTaskId','taskId',
      'ownerId','attempt','stepId','waitId','toolCallId','callItemId','resultItemId']
    AND boundWait."result"->'sourceLifecycleRecovery'->>'schemaVersion' = 'child-wait-source-lifecycle.v1'
    AND boundWait."result"->'sourceLifecycleRecovery'->>'userId' = session."userId"
    AND boundWait."result"->'sourceLifecycleRecovery'->>'sessionId' = owner."sessionId"
    AND boundWait."result"->'sourceLifecycleRecovery'->>'turnId' = owner."turnId"
    AND boundWait."result"->'sourceLifecycleRecovery'->>'rootTaskId' = owner."rootTaskId"
    AND boundWait."result"->'sourceLifecycleRecovery'->>'taskId' = owner."id"
    AND jsonb_typeof(boundWait."result"->'sourceLifecycleRecovery'->'ownerId') = 'string'
    AND char_length(boundWait."result"->'sourceLifecycleRecovery'->>'ownerId') BETWEEN 1 AND 256
    AND btrim(boundWait."result"->'sourceLifecycleRecovery'->>'ownerId') = boundWait."result"->'sourceLifecycleRecovery'->>'ownerId'
    AND proof.value->'sourceWait'->>'sourceLifecycleRecoveryOwnerDigest' ~ '^[0-9a-f]{64}$'
    AND proof.value->'sourceWait'->>'sourceLifecycleRecoveryOwnerDigest' = encode(sha256(convert_to(
      boundWait."result"->'sourceLifecycleRecovery'->>'ownerId', 'UTF8')), 'hex')
    AND boundWait."result"->'sourceLifecycleRecovery'->>'attempt' = boundSource."attempt"::text
    AND boundWait."result"->'sourceLifecycleRecovery'->>'stepId' = boundSource."id"
    AND boundWait."result"->'sourceLifecycleRecovery'->>'waitId' = boundWait."id"
    AND boundWait."result"->'sourceLifecycleRecovery'->>'toolCallId' = boundSourceCall."content"->>'toolCallId'
    AND boundWait."result"->'sourceLifecycleRecovery'->>'callItemId' = boundSourceCall."id"
    AND boundWait."result"->'sourceLifecycleRecovery'->>'resultItemId' = boundSourceResult."id"
    AND boundSourceResult."id" = 'task:' || owner."id" || ':item:tool-result:source-wait-recovery:' || encode(sha256(
      convert_to('child-wait-source-result:v1', 'UTF8') || decode('00', 'hex') || convert_to(boundWait."id", 'UTF8') || decode('00', 'hex')
      || convert_to((boundSourceCall."content"->>'toolCallId'), 'UTF8')), 'hex')
    AND boundSourceResult."content" = jsonb_build_object('toolCallId', boundSourceCall."content"->>'toolCallId',
      'output', boundWait."result"->'outcome', 'errorCode', NULL)
  ELSE FALSE END`
