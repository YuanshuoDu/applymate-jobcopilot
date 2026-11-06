import { HISTORICAL_SOURCE_STEP_PREFIX_SQL } from "./pg-store-expiry-historical-source-step-prefix.js"

const targets = `CASE WHEN jsonb_typeof(boundWait."targetTaskIds") = 'array' THEN boundWait."targetTaskIds" ELSE '[]'::jsonb END`
const handoff = "proof.value->'sourceStepHandoff'", handoffEvents = `(CASE WHEN jsonb_typeof(${handoff}->'events') = 'array' THEN ${handoff}->'events' ELSE '[]'::jsonb END)`
const handoffKeys = "'schemaVersion','waitId','stepId','attempt','sourceCallItemId','sourceCallId','sourceResultItemId','events'"
const handoffEventKeys = "'id','sequence','type','actor','itemId','correlationId','causationId','idempotencyKey','payloadDigest'"
const anchorKey = (suffix: string) => `'task:' || owner."id" || ':event:${suffix}' || boundSource."id"`
const agendaKey = `(CASE WHEN octet_length(convert_to('cognitive.agenda:' || boundSource."id", 'UTF8')) <= 256
  THEN 'cognitive.agenda:' || boundSource."id" ELSE 'cognitive.agenda:sha256:' || encode(sha256(convert_to(boundSource."id", 'UTF8')), 'hex') END)`

/** Source call closure is independent of step completion and only supports a recovered, still-waiting step. */
export const HISTORICAL_SOURCE_WAIT_HANDOFF_SQL = `CASE WHEN jsonb_typeof(${handoff}) = 'object' THEN
  CASE WHEN (SELECT COUNT(*) FROM jsonb_object_keys(${handoff})) = 8 AND ${handoff} ?& ARRAY[${handoffKeys}]
    AND ${handoff}->>'schemaVersion' = 'recovered_wait_handoff.v1'
    AND ${handoff}->>'waitId' = boundWait."id" AND ${handoff}->>'stepId' = boundSource."id"
    AND ${handoff}->>'attempt' = boundSource."attempt"::text AND ${handoff}->>'sourceCallItemId' = boundSourceCall."id"
    AND ${handoff}->>'sourceCallId' = boundSourceCall."content"->>'toolCallId'
    AND ${handoff}->>'sourceResultItemId' = boundSourceResult."id"
    AND proof.value->'sourceWait'->>'sourceKind' = 'recovered' AND boundSource."status" = 'waiting_for_tool'
    AND jsonb_array_length(${handoffEvents}) = 6
    AND (SELECT COUNT(*) FROM jsonb_array_elements(${handoffEvents}) AS expected(value)
      JOIN "agent_events" AS exactEvent ON exactEvent."id" = expected.value->>'id'
        AND exactEvent."sessionId" = boundSource."sessionId" AND exactEvent."turnId" = boundSource."turnId" AND exactEvent."taskId" = boundSource."taskId"
      WHERE CASE WHEN jsonb_typeof(expected.value) = 'object' THEN
        (SELECT COUNT(*) FROM jsonb_object_keys(expected.value)) = 9 AND expected.value ?& ARRAY[${handoffEventKeys}]
        AND exactEvent."sequence"::text = expected.value->>'sequence' AND exactEvent."type" = expected.value->>'type'
        AND exactEvent."actor" = expected.value->>'actor' AND exactEvent."itemId" IS NOT DISTINCT FROM expected.value->>'itemId'
        AND exactEvent."correlationId" = expected.value->>'correlationId' AND exactEvent."causationId" IS NOT DISTINCT FROM expected.value->>'causationId'
        AND exactEvent."idempotencyKey" = expected.value->>'idempotencyKey'
        AND encode(sha256(convert_to(exactEvent."payload"::text, 'UTF8')), 'hex') = expected.value->>'payloadDigest'
        AND expected.value->>'sequence' ~ '^[1-9][0-9]{0,18}$' AND expected.value->>'payloadDigest' ~ '^[0-9a-f]{64}$'
      ELSE FALSE END) = 6
    AND (SELECT COUNT(DISTINCT expected.value->>'id') FROM jsonb_array_elements(${handoffEvents}) AS expected(value)) = 6
    AND (SELECT COUNT(*) FROM "agent_events" AS keyed WHERE keyed."sessionId" = boundSource."sessionId" AND keyed."turnId" = boundSource."turnId"
      AND keyed."taskId" = boundSource."taskId" AND keyed."idempotencyKey" IN (SELECT expected.value->>'idempotencyKey' FROM jsonb_array_elements(${handoffEvents}) AS expected(value))) = 6
    AND ${handoffEvents}->0->>'type' = 'step.started' AND ${handoffEvents}->0->>'idempotencyKey' = ${anchorKey('step-started:')}
    AND ${handoffEvents}->0->>'correlationId' = boundSource."id" AND ${handoffEvents}->0->'itemId' = 'null'::jsonb
    AND ${handoffEvents}->1->>'type' = 'cognitive.agenda' AND ${handoffEvents}->1->>'idempotencyKey' = 'task:' || owner."id" || ':event:' || ${agendaKey}
    AND ${handoffEvents}->2->>'type' = 'model.started' AND ${handoffEvents}->2->>'idempotencyKey' = ${anchorKey('model-started:')}
    AND ${handoffEvents}->3->>'type' = 'model.completed' AND ${handoffEvents}->3->>'idempotencyKey' = ${anchorKey('model-completed:')}
    AND ${handoffEvents}->4->>'type' = 'model.usage' AND ${handoffEvents}->4->>'idempotencyKey' = ${anchorKey('model-usage:')}
    AND ${handoffEvents}->5->>'type' = 'item.started' AND ${handoffEvents}->5->>'idempotencyKey' = 'task:' || owner."id" || ':event:item-started:' || boundSourceCall."id"
    AND ${handoffEvents}->5->>'id' = sourceItemStarted."id" AND ${handoffEvents}->5->>'itemId' = boundSourceCall."id"
    AND ${handoffEvents}->0->>'actor' = 'subagent' AND ${handoffEvents}->1->>'actor' = 'subagent'
    AND ${handoffEvents}->2->>'actor' = 'subagent' AND ${handoffEvents}->3->>'actor' = 'subagent'
    AND ${handoffEvents}->4->>'actor' = 'subagent' AND ${handoffEvents}->5->>'actor' = 'subagent'
    AND ${handoffEvents}->1->>'correlationId' = boundSource."id" AND ${handoffEvents}->2->>'correlationId' = boundSource."id"
    AND ${handoffEvents}->3->>'correlationId' = boundSource."id" AND ${handoffEvents}->4->>'correlationId' = boundSource."id"
    AND ${handoffEvents}->5->>'correlationId' = boundSource."id"
    AND ${handoffEvents}->1->'itemId' = 'null'::jsonb AND ${handoffEvents}->2->'itemId' = 'null'::jsonb
    AND ${handoffEvents}->3->'itemId' = 'null'::jsonb AND ${handoffEvents}->4->'itemId' = 'null'::jsonb
    AND (${handoffEvents}->1->>'causationId') = ${handoffEvents}->0->>'id'
    AND (${handoffEvents}->2->>'causationId') = ${handoffEvents}->1->>'id'
    AND (${handoffEvents}->3->>'causationId') = ${handoffEvents}->2->>'id'
    AND (${handoffEvents}->4->>'causationId') = ${handoffEvents}->3->>'id'
    AND (${handoffEvents}->5->>'causationId') = ${handoffEvents}->4->>'id'
    AND CASE WHEN (${handoffEvents}->0->>'sequence' ~ '^[1-9][0-9]{0,18}$' AND ${handoffEvents}->1->>'sequence' ~ '^[1-9][0-9]{0,18}$'
      AND ${handoffEvents}->2->>'sequence' ~ '^[1-9][0-9]{0,18}$' AND ${handoffEvents}->3->>'sequence' ~ '^[1-9][0-9]{0,18}$'
      AND ${handoffEvents}->4->>'sequence' ~ '^[1-9][0-9]{0,18}$' AND ${handoffEvents}->5->>'sequence' ~ '^[1-9][0-9]{0,18}$')
      THEN (${handoffEvents}->0->>'sequence')::numeric < (${handoffEvents}->1->>'sequence')::numeric
        AND (${handoffEvents}->1->>'sequence')::numeric < (${handoffEvents}->2->>'sequence')::numeric
        AND (${handoffEvents}->2->>'sequence')::numeric < (${handoffEvents}->3->>'sequence')::numeric
        AND (${handoffEvents}->3->>'sequence')::numeric < (${handoffEvents}->4->>'sequence')::numeric
        AND (${handoffEvents}->4->>'sequence')::numeric < (${handoffEvents}->5->>'sequence')::numeric ELSE FALSE END
    AND EXISTS (SELECT 1 FROM "agent_events" AS stepStarted WHERE stepStarted."id" = ${handoffEvents}->0->>'id'
      AND stepStarted."payload" = jsonb_build_object('stepId', boundSource."id", 'ordinal', boundSource."ordinal", 'taskId', owner."id"))
    AND (SELECT COUNT(*) FROM "agent_items" AS sourceItem WHERE sourceItem."sessionId" = boundSource."sessionId"
      AND sourceItem."turnId" = boundSource."turnId" AND sourceItem."taskId" = boundSource."taskId" AND sourceItem."stepId" = boundSource."id") = 2
    AND NOT EXISTS (SELECT 1 FROM "agent_events" AS sourceStepDone WHERE sourceStepDone."sessionId" = boundSource."sessionId"
      AND sourceStepDone."turnId" = boundSource."turnId" AND sourceStepDone."taskId" = boundSource."taskId"
      AND ((sourceStepDone."type" = 'step.completed' AND sourceStepDone."correlationId" = boundSource."id")
        OR sourceStepDone."idempotencyKey" = 'task:' || owner."id" || ':event:step-completed:' || boundSource."id"))
    AND NOT EXISTS (SELECT 1 FROM "agent_events" AS extraStepEvent WHERE extraStepEvent."sessionId" = boundSource."sessionId"
      AND extraStepEvent."turnId" = boundSource."turnId" AND extraStepEvent."taskId" = boundSource."taskId"
      AND extraStepEvent."correlationId" = boundSource."id" AND extraStepEvent."id" NOT IN
        (${handoffEvents}->0->>'id', ${handoffEvents}->1->>'id', ${handoffEvents}->2->>'id', ${handoffEvents}->3->>'id',
          ${handoffEvents}->4->>'id', ${handoffEvents}->5->>'id', sourceResultStarted."id"))
    AND (SELECT COUNT(*) FROM "agent_events" AS betweenAnchors WHERE betweenAnchors."sessionId" = boundSource."sessionId"
      AND betweenAnchors."turnId" = boundSource."turnId" AND betweenAnchors."taskId" = boundSource."taskId"
      AND CASE WHEN (${handoffEvents}->0->>'sequence' ~ '^[1-9][0-9]{0,18}$' AND ${handoffEvents}->5->>'sequence' ~ '^[1-9][0-9]{0,18}$')
        THEN betweenAnchors."sequence"::numeric BETWEEN (${handoffEvents}->0->>'sequence')::numeric AND (${handoffEvents}->5->>'sequence')::numeric ELSE FALSE END) = 6
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
