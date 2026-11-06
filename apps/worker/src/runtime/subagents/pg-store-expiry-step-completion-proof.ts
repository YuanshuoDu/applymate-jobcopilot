import { canonicalJson } from "@jobcopilot/shared"
import { MAX_STEP_CHAIN_EVENTS, MAX_STEP_TOOL_CALLS, STEP_TOOL_CHAIN_AGENDA_JOIN_SQL, STEP_TOOL_CHAIN_AGENDA_WHERE_SQL,
  STEP_TOOL_CHAIN_MODEL_START_JOIN_SQL, STEP_TOOL_CHAIN_MODEL_START_WHERE_SQL, type StepToolChainProof } from "./pg-store-expiry-step-tool-chain-proof.js"
type Event = Readonly<Record<string, unknown>>
const events = `CASE WHEN jsonb_typeof(proof.value->'stepToolChain'->'events') = 'array' THEN proof.value->'stepToolChain'->'events' ELSE '[]'::jsonb END`
const calls = `CASE WHEN jsonb_typeof(proof.value->'stepToolChain'->'calls') = 'array' THEN proof.value->'stepToolChain'->'calls' ELSE '[]'::jsonb END`

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(), expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
function sequence(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null
  try { return BigInt(value) } catch { return null }
}
function boundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
}
function sameJson(left: unknown, right: unknown): boolean {
  try { return canonicalJson(left) === canonicalJson(right) } catch { return false }
}
export function partitionWaitResultEvents(rows: readonly Event[], keys: readonly string[]): { started: Event; completed: Event; extra?: Event } | null {
  if (keys.length !== 2 || rows.length < 2 || rows.length > 3) return null
  const started = rows.filter(row => row.idempotencyKey === keys[0]), completed = rows.filter(row => row.idempotencyKey === keys[1])
  const extra = rows.filter(row => row.idempotencyKey !== keys[0] && row.idempotencyKey !== keys[1])
  return started.length === 1 && completed.length === 1 && extra.length <= 1
    ? { started: started[0]!, completed: completed[0]!, ...(extra[0] ? { extra: extra[0] } : {}) } : null
}

export function isCanonicalWaitResultPair(terminal: Event, started: Event, completed: Event,
  resultItemId: string, stepId: string, content: Record<string, unknown>): boolean {
  const terminalAt = sequence(terminal.sequence), startAt = sequence(started.sequence), completeAt = sequence(completed.sequence)
  return boundedString(terminal.id) && boundedString(started.id) && boundedString(completed.id) && started.id !== completed.id
    && terminal.type === "tool_call.completed" && started.type === "item.started" && started.actor === "subagent"
    && started.itemId === resultItemId && started.correlationId === stepId && started.causationId === terminal.id
    && sameJson(started.payload, { itemId: resultItemId, type: "tool_result", phase: null })
    && completed.type === "item.completed" && completed.actor === "subagent" && completed.itemId === resultItemId
    && completed.correlationId === resultItemId && completed.causationId === started.id
    && sameJson(completed.payload, { itemId: resultItemId, status: "completed", content })
    && Boolean(terminalAt && startAt && completeAt && terminalAt < startAt && startAt < completeAt)
}

const objectHasExactKeyCount = (expression: string, count: number) => `(CASE WHEN jsonb_typeof(${expression}) = 'object'
  THEN (SELECT COUNT(*) FROM jsonb_object_keys(${expression})) = ${count} ELSE FALSE END)`
/** Final SQL validates the ordered event projection and allows only the proven immediate descendant. */
export const CHILD_WAIT_STEP_TOOL_CHAIN_EXCEPTION_SQL = `(
  resultExtra."id" = proof.value->'stepToolChain'->>'nextEventId'
  AND resultExtra."causationId" = proof.value->>'resultCompletedEventId'
  AND proof.value->'stepToolChain'->>'waitCallItemId' = callItem."id"
  AND proof.value->'stepToolChain'->>'waitCallId' = started."correlationId"
  AND proof.value->'stepToolChain'->>'waitResultItemId' = proof.value->>'resultItemId'
  AND proof.value->'stepToolChain'->>'stepId' = callItem."stepId"
  AND jsonb_typeof(proof.value->'stepToolChain'->'events') = 'array'
  AND jsonb_array_length(${events}) BETWEEN 12 AND ${MAX_STEP_CHAIN_EVENTS}
  AND jsonb_typeof(proof.value->'stepToolChain'->'calls') = 'array'
  AND jsonb_array_length(${calls}) BETWEEN 1 AND ${MAX_STEP_TOOL_CALLS}
  AND (SELECT COUNT(*) FROM jsonb_array_elements(${events}) WITH ORDINALITY AS expected(value, ordinal)
    JOIN "agent_events" AS actual ON actual."id" = expected.value->>'id'
    WHERE actual."sessionId" = callItem."sessionId" AND actual."turnId" = callItem."turnId" AND actual."taskId" = callItem."taskId"
      AND actual."sequence"::text = expected.value->>'sequence' AND actual."type" = expected.value->>'type'
      AND actual."actor" = expected.value->>'actor' AND actual."itemId" IS NOT DISTINCT FROM expected.value->>'itemId'
      AND actual."correlationId" = expected.value->>'correlationId'
      AND actual."causationId" IS NOT DISTINCT FROM expected.value->>'causationId'
      AND actual."idempotencyKey" = expected.value->>'idempotencyKey') = jsonb_array_length(${events})
  AND (SELECT COUNT(*) FROM "agent_events" AS inRange
    WHERE inRange."sessionId" = callItem."sessionId" AND inRange."turnId" = callItem."turnId" AND inRange."taskId" = callItem."taskId"
      AND inRange."sequence" BETWEEN ((${events})->0->>'sequence')::bigint
        AND ((${events})->(jsonb_array_length(${events}) - 1)->>'sequence')::bigint)
    = jsonb_array_length(${events})
  AND (SELECT COUNT(*) FROM (SELECT actual."id", actual."causationId", actual."sequence",
      lag(expected.value->>'id') OVER (ORDER BY expected.ordinal) AS "previousId",
      lag(actual."sequence") OVER (ORDER BY expected.ordinal) AS "previousSequence", expected.ordinal
    FROM jsonb_array_elements(${events}) WITH ORDINALITY AS expected(value, ordinal)
    JOIN "agent_events" AS actual ON actual."id" = expected.value->>'id'
      AND actual."sessionId" = callItem."sessionId" AND actual."turnId" = callItem."turnId" AND actual."taskId" = callItem."taskId") AS ordered
    WHERE ordered.ordinal > 1 AND (ordered."causationId" IS DISTINCT FROM ordered."previousId" OR ordered."sequence" <= ordered."previousSequence")) = 0
  AND (SELECT COUNT(*) FROM "agent_items" AS toolCall WHERE toolCall."sessionId" = callItem."sessionId"
    AND toolCall."turnId" = callItem."turnId" AND toolCall."taskId" = callItem."taskId"
    AND toolCall."stepId" = proof.value->'stepToolChain'->>'stepId' AND toolCall."type" = 'tool_call')
    = jsonb_array_length(${calls})
  AND (SELECT COUNT(*) FROM "agent_items" AS toolResult WHERE toolResult."sessionId" = callItem."sessionId"
    AND toolResult."turnId" = callItem."turnId" AND toolResult."taskId" = callItem."taskId"
    AND toolResult."stepId" = proof.value->'stepToolChain'->>'stepId' AND toolResult."type" = 'tool_result')
    = jsonb_array_length(${calls})
  AND (SELECT COUNT(DISTINCT row."id") FROM jsonb_array_elements(${calls}) AS callProof(value)
    JOIN "agent_items" AS proofCall ON proofCall."id" = callProof.value->>'callItemId' AND proofCall."sessionId" = callItem."sessionId"
      AND proofCall."turnId" = callItem."turnId" AND proofCall."taskId" = callItem."taskId" AND proofCall."stepId" = proof.value->'stepToolChain'->>'stepId'
      AND proofCall."type" = 'tool_call' AND proofCall."content"->>'toolCallId' = callProof.value->>'toolCallId')
    = jsonb_array_length(${calls})
  AND (SELECT COUNT(*) FROM jsonb_array_elements(${calls}) AS expected(value)
    JOIN "agent_items" AS toolCall ON toolCall."id" = expected.value->>'callItemId'
      AND toolCall."sessionId" = callItem."sessionId" AND toolCall."turnId" = callItem."turnId" AND toolCall."taskId" = callItem."taskId"
      AND toolCall."stepId" = proof.value->'stepToolChain'->>'stepId' AND toolCall."type" = 'tool_call'
      AND toolCall."status" = 'completed' AND toolCall."revision" = 1 AND toolCall."phase" IS NULL
      AND toolCall."content"->>'toolCallId' = expected.value->>'toolCallId'
      AND toolCall."content"->>'toolName' = expected.value->>'toolName'
      AND ${objectHasExactKeyCount('toolCall."content"', 6)}
      AND toolCall."content" ?& ARRAY['toolCallId', 'toolName', 'toolVersion', 'input', 'status', 'errorCode']
      AND toolCall."content"->>'toolVersion' = '1' AND jsonb_typeof(toolCall."content"->'input') = 'object'
      AND toolCall."content"->>'status' = 'completed' AND toolCall."content"->'errorCode' = 'null'::jsonb
      AND (expected.value->>'toolName' <> 'wait_subagents' OR toolCall."id" = proof.value->'stepToolChain'->>'waitCallItemId')
    JOIN "agent_items" AS toolResult ON toolResult."id" = expected.value->>'resultItemId'
      AND toolResult."sessionId" = toolCall."sessionId" AND toolResult."turnId" = toolCall."turnId" AND toolResult."taskId" = toolCall."taskId"
      AND toolResult."stepId" = toolCall."stepId" AND toolResult."type" = 'tool_result'
      AND toolResult."status" = 'completed' AND toolResult."revision" = 1 AND toolResult."phase" IS NULL
      AND ${objectHasExactKeyCount('toolResult."content"', 3)}
      AND toolResult."content" ?& ARRAY['toolCallId', 'output', 'errorCode']
      AND toolResult."content"->>'toolCallId' = toolCall."content"->>'toolCallId'
      AND toolResult."content"->'errorCode' = 'null'::jsonb)
    = jsonb_array_length(${calls})
  AND (SELECT COUNT(*) FROM jsonb_array_elements(${calls}) AS callProof(value)
    JOIN "agent_items" AS callRow ON callRow."id" = callProof.value->>'callItemId'
      AND callRow."sessionId" = callItem."sessionId" AND callRow."turnId" = callItem."turnId" AND callRow."taskId" = callItem."taskId"
      AND callRow."stepId" = proof.value->'stepToolChain'->>'stepId'
    JOIN "agent_items" AS resultRow ON resultRow."id" = callProof.value->>'resultItemId'
      AND resultRow."sessionId" = callRow."sessionId" AND resultRow."turnId" = callRow."turnId" AND resultRow."taskId" = callRow."taskId"
      AND resultRow."stepId" = callRow."stepId" AND resultRow."content"->>'toolCallId' = callRow."content"->>'toolCallId'
    JOIN "agent_events" AS callItemStart ON callItemStart."id" = callProof.value->>'itemStartedEventId'
      AND callItemStart."type" = 'item.started' AND callItemStart."actor" = 'subagent' AND callItemStart."itemId" = callRow."id"
      AND callItemStart."correlationId" = callRow."stepId" AND callItemStart."idempotencyKey" = 'task:' || callRow."taskId" || ':event:item-started:' || callRow."id"
      AND callItemStart."payload" = jsonb_build_object('itemId', callRow."id", 'type', 'tool_call', 'phase', NULL)
    JOIN "agent_events" AS callStart ON callStart."id" = callProof.value->>'callStartedEventId'
      AND callStart."type" = 'tool_call.started' AND callStart."actor" = 'subagent' AND callStart."itemId" = callRow."id"
      AND callStart."correlationId" = callRow."content"->>'toolCallId' AND callStart."causationId" = callItemStart."id"
      AND callStart."payload" = jsonb_build_object('toolCallId', callRow."content"->>'toolCallId', 'toolName', callRow."content"->>'toolName', 'taskId', callRow."taskId")
      AND callStart."idempotencyKey" = CASE WHEN callRow."id" = proof.value->'stepToolChain'->>'waitCallItemId'
        THEN 'task:' || callRow."taskId" || ':event:child-wait-claim:' || (proof.value->'stepToolChain'->>'attempt') || ':' || callRow."stepId"
        ELSE 'task:' || callRow."taskId" || ':event:tool-started:' || (callRow."content"->>'toolCallId') END
    JOIN "agent_events" AS callItemDone ON callItemDone."id" = callProof.value->>'callCompletedEventId'
      AND callItemDone."type" = 'item.completed' AND callItemDone."actor" = 'subagent' AND callItemDone."itemId" = callRow."id"
      AND callItemDone."correlationId" = callRow."id" AND callItemDone."causationId" = callStart."id"
      AND callItemDone."idempotencyKey" = 'task:' || callRow."taskId" || ':event:tool-call-completed:'
        || (callRow."content"->>'toolCallId') || ':' || callRow."id" || ':1'
      AND (callRow."id" = proof.value->'stepToolChain'->>'waitCallItemId' OR callItemDone."payload" = jsonb_build_object(
        'itemId', callRow."id", 'status', 'completed', 'content', callRow."content"))
    JOIN "agent_events" AS callDone ON callDone."id" = callProof.value->>'callTerminalEventId'
      AND callDone."type" = 'tool_call.completed' AND callDone."actor" = 'subagent' AND callDone."itemId" = callRow."id"
      AND callDone."correlationId" = callRow."content"->>'toolCallId' AND callDone."causationId" = callItemDone."id"
      AND callDone."idempotencyKey" = 'task:' || callRow."taskId" || ':event:tool-finished:' || (callRow."content"->>'toolCallId')
      AND callDone."payload" = jsonb_build_object('toolCallId', callRow."content"->>'toolCallId',
        'toolName', callRow."content"->>'toolName', 'status', 'completed', 'errorCode', NULL, 'taskId', callRow."taskId")
    JOIN "agent_events" AS resultStart ON resultStart."id" = callProof.value->>'resultStartedEventId'
      AND resultStart."type" = 'item.started' AND resultStart."actor" = 'subagent' AND resultStart."itemId" = resultRow."id"
      AND resultStart."correlationId" = resultRow."stepId" AND resultStart."causationId" = callDone."id"
      AND resultStart."idempotencyKey" = 'task:' || resultRow."taskId" || ':event:item-started:' || resultRow."id"
      AND resultStart."payload" = jsonb_build_object('itemId', resultRow."id", 'type', 'tool_result', 'phase', NULL)
    JOIN "agent_events" AS resultDone ON resultDone."id" = callProof.value->>'resultCompletedEventId'
      AND resultDone."type" = 'item.completed' AND resultDone."actor" = 'subagent' AND resultDone."itemId" = resultRow."id"
      AND resultDone."correlationId" = resultRow."id" AND resultDone."causationId" = resultStart."id"
      AND resultDone."idempotencyKey" = 'task:' || resultRow."taskId" || ':event:tool-result-completed:'
        || (resultRow."content"->>'toolCallId') || ':' || resultRow."id" || ':1'
      AND resultDone."payload" = jsonb_build_object('itemId', resultRow."id", 'status', 'completed', 'content', resultRow."content")
    WHERE callItemStart."sessionId" = callRow."sessionId" AND callItemStart."turnId" = callRow."turnId" AND callItemStart."taskId" = callRow."taskId"
      AND callStart."sessionId" = callRow."sessionId" AND callStart."turnId" = callRow."turnId" AND callStart."taskId" = callRow."taskId"
      AND callItemDone."sessionId" = callRow."sessionId" AND callItemDone."turnId" = callRow."turnId" AND callItemDone."taskId" = callRow."taskId"
      AND callDone."sessionId" = callRow."sessionId" AND callDone."turnId" = callRow."turnId" AND callDone."taskId" = callRow."taskId"
      AND resultStart."sessionId" = callRow."sessionId" AND resultStart."turnId" = callRow."turnId" AND resultStart."taskId" = callRow."taskId"
      AND resultDone."sessionId" = callRow."sessionId" AND resultDone."turnId" = callRow."turnId" AND resultDone."taskId" = callRow."taskId")
    = jsonb_array_length(${calls})
  AND (SELECT COUNT(DISTINCT proofResult."id") FROM jsonb_array_elements(${calls}) AS callProof(value)
    JOIN "agent_items" AS proofResult ON proofResult."id" = callProof.value->>'resultItemId' AND proofResult."sessionId" = callItem."sessionId"
      AND proofResult."turnId" = callItem."turnId" AND proofResult."taskId" = callItem."taskId" AND proofResult."stepId" = proof.value->'stepToolChain'->>'stepId'
      AND proofResult."type" = 'tool_result') = jsonb_array_length(${calls})
  AND (SELECT COUNT(*) FROM "agent_items" AS inStep WHERE inStep."sessionId" = callItem."sessionId"
    AND inStep."turnId" = callItem."turnId" AND inStep."taskId" = callItem."taskId" AND inStep."stepId" = proof.value->'stepToolChain'->>'stepId')
    = jsonb_array_length(${calls}) * 2 + CASE WHEN proof.value->'stepToolChain' ? 'commentary' THEN 1 ELSE 0 END
  AND (NOT (proof.value->'stepToolChain' ? 'commentary') OR EXISTS (
    SELECT 1 FROM "agent_items" AS commentItem
    JOIN "agent_events" AS commentStarted ON commentStarted."id" = proof.value->'stepToolChain'->'commentary'->>'startedEventId'
      AND commentStarted."sessionId" = commentItem."sessionId" AND commentStarted."turnId" = commentItem."turnId" AND commentStarted."taskId" = commentItem."taskId"
      AND commentStarted."type" = 'item.started' AND commentStarted."actor" = 'subagent' AND commentStarted."itemId" = commentItem."id"
      AND commentStarted."correlationId" = commentItem."stepId" AND commentStarted."idempotencyKey" = 'task:' || commentItem."taskId" || ':event:item-started:' || commentItem."id"
      AND commentStarted."payload" = jsonb_build_object('itemId', commentItem."id", 'type', 'agent_message', 'phase', 'commentary')
    JOIN "agent_events" AS commentDelta ON commentDelta."id" = proof.value->'stepToolChain'->'commentary'->>'deltaEventId'
      AND commentDelta."sessionId" = commentItem."sessionId" AND commentDelta."turnId" = commentItem."turnId" AND commentDelta."taskId" = commentItem."taskId"
      AND commentDelta."type" = 'item.delta' AND commentDelta."actor" = 'subagent' AND commentDelta."itemId" = commentItem."id"
      AND commentDelta."correlationId" = commentItem."id" AND commentDelta."causationId" = commentStarted."id"
      AND commentDelta."idempotencyKey" = 'task:' || commentItem."taskId" || ':event:commentary-delta:' || commentItem."id" || ':1'
      AND commentDelta."payload" = jsonb_build_object('itemId', commentItem."id", 'status', 'streaming', 'content', commentItem."content")
    JOIN "agent_events" AS commentDone ON commentDone."id" = proof.value->'stepToolChain'->'commentary'->>'completedEventId'
      AND commentDone."sessionId" = commentItem."sessionId" AND commentDone."turnId" = commentItem."turnId" AND commentDone."taskId" = commentItem."taskId"
      AND commentDone."type" = 'item.completed' AND commentDone."actor" = 'subagent' AND commentDone."itemId" = commentItem."id"
      AND commentDone."correlationId" = commentItem."id" AND commentDone."causationId" = commentDelta."id"
      AND commentDone."idempotencyKey" = 'task:' || commentItem."taskId" || ':event:commentary-completed:' || commentItem."id" || ':2'
      AND commentDone."payload" = jsonb_build_object('itemId', commentItem."id", 'status', 'completed', 'content', commentItem."content")
    WHERE commentItem."id" = proof.value->'stepToolChain'->'commentary'->>'itemId'
      AND commentItem."sessionId" = callItem."sessionId" AND commentItem."turnId" = callItem."turnId" AND commentItem."taskId" = callItem."taskId"
      AND commentItem."stepId" = proof.value->'stepToolChain'->>'stepId' AND commentItem."type" = 'agent_message'
      AND commentItem."status" = 'completed' AND commentItem."revision" = 2 AND commentItem."phase" = 'commentary'
      AND ${objectHasExactKeyCount('commentItem."content"', 1)} AND commentItem."content" ? 'text'
      AND jsonb_typeof(commentItem."content"->'text') = 'string' AND char_length(commentItem."content"->>'text') > 0))
  AND EXISTS (SELECT 1 FROM ${STEP_TOOL_CHAIN_AGENDA_JOIN_SQL}
    ${STEP_TOOL_CHAIN_MODEL_START_JOIN_SQL}
    JOIN "agent_events" AS modelDone
    ON modelDone."id" = proof.value->'stepToolChain'->>'modelCompletedEventId'
      AND modelDone."sessionId" = modelStart."sessionId" AND modelDone."turnId" = modelStart."turnId" AND modelDone."taskId" = modelStart."taskId"
      AND modelDone."type" = 'model.completed' AND modelDone."actor" = 'subagent' AND modelDone."itemId" IS NULL
      AND modelDone."correlationId" = proof.value->'stepToolChain'->>'stepId'
      AND modelDone."causationId" = modelStart."id"
      AND modelDone."idempotencyKey" = 'task:' || callItem."taskId" || ':event:model-completed:' || (proof.value->'stepToolChain'->>'stepId')
    JOIN "agent_events" AS modelUsage ON modelUsage."id" = proof.value->'stepToolChain'->>'modelUsageEventId'
      AND modelUsage."sessionId" = modelStart."sessionId" AND modelUsage."turnId" = modelStart."turnId" AND modelUsage."taskId" = modelStart."taskId"
      AND modelUsage."type" = 'model.usage' AND modelUsage."actor" = 'subagent' AND modelUsage."itemId" IS NULL
      AND modelUsage."correlationId" = proof.value->'stepToolChain'->>'stepId' AND modelUsage."causationId" = modelDone."id"
      AND modelUsage."idempotencyKey" = 'task:' || callItem."taskId" || ':event:model-usage:' || (proof.value->'stepToolChain'->>'stepId')
    JOIN "agent_events" AS stepDone ON stepDone."id" = proof.value->'stepToolChain'->>'stepCompletedEventId'
      AND stepDone."sessionId" = modelStart."sessionId" AND stepDone."turnId" = modelStart."turnId" AND stepDone."taskId" = modelStart."taskId"
      AND stepDone."type" = 'step.completed' AND stepDone."actor" = 'subagent' AND stepDone."itemId" IS NULL
      AND stepDone."correlationId" = proof.value->'stepToolChain'->>'stepId'
      AND stepDone."idempotencyKey" = 'task:' || callItem."taskId" || ':event:step-completed:' || (proof.value->'stepToolChain'->>'stepId')
      AND stepDone."payload" = jsonb_build_object('stepId', proof.value->'stepToolChain'->>'stepId', 'status', 'completed',
        'toolCallCount', modelDone."payload"->'toolCallCount', 'taskId', callItem."taskId")
    WHERE ${STEP_TOOL_CHAIN_AGENDA_WHERE_SQL}
      AND ${STEP_TOOL_CHAIN_MODEL_START_WHERE_SQL}
      AND ${objectHasExactKeyCount('modelStart."payload"', 3)}
      AND modelStart."payload" ?& ARRAY['taskId', 'provider', 'model']
      AND jsonb_typeof(modelStart."payload"->'provider') = 'string' AND char_length(modelStart."payload"->>'provider') BETWEEN 1 AND 256
      AND btrim(modelStart."payload"->>'provider') = modelStart."payload"->>'provider'
      AND jsonb_typeof(modelStart."payload"->'model') = 'string' AND char_length(modelStart."payload"->>'model') BETWEEN 1 AND 256
      AND btrim(modelStart."payload"->>'model') = modelStart."payload"->>'model'
      AND modelStart."payload" = jsonb_build_object('taskId', callItem."taskId", 'provider', modelStart."payload"->'provider', 'model', modelStart."payload"->'model')
      AND ${objectHasExactKeyCount('modelDone."payload"', 4)}
      AND modelDone."payload" ?& ARRAY['taskId', 'provider', 'model', 'toolCallCount']
      AND CASE WHEN jsonb_typeof(modelDone."payload"->'toolCallCount') = 'number'
        THEN (modelDone."payload"->>'toolCallCount')::numeric = jsonb_array_length(${calls})
          AND (modelDone."payload"->>'toolCallCount')::numeric BETWEEN 1 AND ${MAX_STEP_TOOL_CALLS}
          AND (modelDone."payload"->>'toolCallCount')::numeric = trunc((modelDone."payload"->>'toolCallCount')::numeric) ELSE FALSE END
      AND modelDone."payload" = jsonb_build_object('taskId', callItem."taskId", 'provider', modelStart."payload"->'provider',
        'model', modelStart."payload"->'model', 'toolCallCount', jsonb_array_length(${calls}))
      AND ${objectHasExactKeyCount('modelUsage."payload"', 4)}
      AND modelUsage."payload" ?& ARRAY['taskId', 'provider', 'model', 'usage']
      AND modelUsage."payload"->'provider' = modelStart."payload"->'provider' AND modelUsage."payload"->'model' = modelStart."payload"->'model'
      AND CASE WHEN modelUsage."payload"->'usage' = 'null'::jsonb THEN TRUE
        WHEN jsonb_typeof(modelUsage."payload"->'usage') = 'object'
          THEN (SELECT COUNT(*) FROM jsonb_object_keys(modelUsage."payload"->'usage')) = 3
        AND modelUsage."payload"->'usage' ?& ARRAY['inputTokens', 'outputTokens', 'estimatedCostUsd']
        AND jsonb_typeof(modelUsage."payload"->'usage'->'inputTokens') = 'number'
        AND jsonb_typeof(modelUsage."payload"->'usage'->'outputTokens') = 'number'
        AND jsonb_typeof(modelUsage."payload"->'usage'->'estimatedCostUsd') = 'number'
        AND (modelUsage."payload"->'usage'->>'inputTokens')::numeric >= 0
        AND (modelUsage."payload"->'usage'->>'outputTokens')::numeric >= 0
        AND (modelUsage."payload"->'usage'->>'estimatedCostUsd')::numeric >= 0 ELSE FALSE END
      AND modelUsage."payload" = jsonb_build_object('taskId', callItem."taskId", 'provider', modelStart."payload"->'provider',
        'model', modelStart."payload"->'model', 'usage', modelUsage."payload"->'usage')
  AND stepDone."causationId" = (${events})->(jsonb_array_length(${events}) - 2)->>'id')
 )`
