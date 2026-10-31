import type pg from "pg"
import { projectWaitCallEventContent } from "../turns/turn-execution-wait-event-projection.js"

/** Reads only the latest, current-owner continuation's one completed source wait call. */
export const CHILD_WAIT_SOURCE_CALL_PROJECTION_SQL = `WITH latest_wait AS MATERIALIZED (SELECT wait."id", wait."stepId", wait."status", wait."suspendedAt", wait."consumedAt", wait."result" FROM "agent_wait_conditions" AS wait
  JOIN "agent_steps" AS latestStep ON latestStep."id" = wait."stepId" AND latestStep."sessionId" = wait."sessionId" AND latestStep."turnId" = wait."turnId" AND latestStep."taskId" = wait."parentTaskId"
  WHERE wait."parentTaskId" = $2 AND wait."sessionId" = $1 AND wait."turnId" = $3 AND latestStep."attempt" BETWEEN 1 AND $6
  ORDER BY latestStep."attempt" DESC, latestStep."ordinal" DESC, wait."createdAt" DESC, wait."id" DESC LIMIT 1
)
SELECT sourceCall."content"->>'toolCallId' AS "toolCallId" FROM "sub_agent_tasks" AS owner
JOIN "agent_sessions" AS session ON session."id" = owner."sessionId" AND session."userId" = $8 JOIN "agent_turns" AS turn ON turn."id" = owner."turnId" AND turn."sessionId" = owner."sessionId" AND turn."userId" = session."userId" AND turn."rootTaskId" = owner."rootTaskId"
JOIN latest_wait AS wait ON TRUE JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."sessionId" = wait."sessionId" AND source."turnId" = wait."turnId" AND source."taskId" = owner."id"
JOIN "agent_steps" AS continuation ON continuation."id" = $9 AND continuation."sessionId" = source."sessionId" AND continuation."turnId" = source."turnId" AND continuation."taskId" = source."taskId" AND continuation."attempt" = $6
JOIN "agent_items" AS sourceCall ON sourceCall."sessionId" = source."sessionId" AND sourceCall."turnId" = source."turnId" AND sourceCall."taskId" = source."taskId" AND sourceCall."stepId" = source."id" AND sourceCall."type" = 'tool_call'
WHERE owner."id" = $2 AND owner."sessionId" = $1 AND owner."turnId" = $3 AND owner."rootTaskId" = $4 AND owner."status" = 'running' AND owner."parentTaskId" IS NOT NULL AND owner."leaseOwner" = $5 AND owner."attemptCount" = $6 AND owner."leaseExpiresAt" = $7 AND owner."interruptRequestedAt" IS NULL
  AND wait."status" IN ('ready', 'timed_out') AND wait."suspendedAt" IS NOT NULL AND wait."consumedAt" IS NOT NULL AND jsonb_typeof(wait."result"->'sourceLifecycleRecovery') = 'object' AND source."attempt" BETWEEN 1 AND $6 AND source."status" IN ('waiting_for_tool', 'completed') AND continuation."status" = 'streaming'
  AND continuation."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later WHERE later."sessionId" = source."sessionId" AND later."turnId" = source."turnId" AND later."taskId" = source."taskId" AND later."attempt" = $6 AND later."ordinal" > source."ordinal") AND continuation."ordinal" = (SELECT MAX(current."ordinal") FROM "agent_steps" AS current WHERE current."sessionId" = owner."sessionId" AND current."turnId" = owner."turnId" AND current."taskId" = owner."id" AND current."attempt" = $6)
  AND sourceCall."status" = 'completed' AND sourceCall."revision" = 1 AND sourceCall."content"->>'toolName' = 'wait_subagents' AND sourceCall."content"->>'toolVersion' = '1' AND char_length(sourceCall."content"->>'toolCallId') BETWEEN 1 AND 256 AND btrim(sourceCall."content"->>'toolCallId') = sourceCall."content"->>'toolCallId'
  AND (SELECT COUNT(*) FROM "agent_items" AS sourceCallCandidate WHERE sourceCallCandidate."sessionId" = source."sessionId" AND sourceCallCandidate."turnId" = source."turnId" AND sourceCallCandidate."taskId" = source."taskId" AND sourceCallCandidate."stepId" = source."id" AND sourceCallCandidate."type" = 'tool_call' AND sourceCallCandidate."content"->>'toolName' = 'wait_subagents') = 1
LIMIT 2`

export type ChildWaitSourceCallProjection = Readonly<{ rawCallId: string; projectedCallId: string }>

export async function readChildWaitSourceCallProjection(client: pg.PoolClient, task: Record<string, unknown>, continuationId: string): Promise<ChildWaitSourceCallProjection | null> {
  const rows = await client.query<{ toolCallId: string | null }>(CHILD_WAIT_SOURCE_CALL_PROJECTION_SQL, [
    task.sessionId, task.id, task.turnId, task.rootTaskId, task.leaseOwner, task.attemptCount,
    task.leaseExpiresAt, task.userId, continuationId,
  ])
  const rawCallId = rows.rows.length === 1 ? rows.rows[0]?.toolCallId : null
  if (typeof rawCallId !== "string" || rawCallId.length < 1 || rawCallId.length > 256 || rawCallId.trim() !== rawCallId) return null
  const projected = projectWaitCallEventContent({ toolName: "wait_subagents", toolCallId: rawCallId })
  if (projected === null || typeof projected !== "object" || Array.isArray(projected)) return null
  const projectedCallId = (projected as Record<string, unknown>).toolCallId
  return typeof projectedCallId === "string" ? { rawCallId, projectedCallId } : null
}

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
      AND sourceItemStarted."causationId" IS NOT NULL
      AND EXISTS (SELECT 1 FROM "agent_events" AS sourcePrior WHERE sourcePrior."id" = sourceItemStarted."causationId"
        AND sourcePrior."sessionId" = sourceCall."sessionId" AND sourcePrior."turnId" = sourceCall."turnId"
        AND sourcePrior."taskId" = sourceCall."taskId" AND sourcePrior."actor" = 'subagent'
        AND sourcePrior."sequence" < sourceItemStarted."sequence"
        AND (sourcePrior."correlationId" = source."id" OR EXISTS (SELECT 1 FROM "agent_items" AS priorItem
          WHERE priorItem."id" = sourcePrior."itemId" AND priorItem."sessionId" = sourceCall."sessionId"
            AND priorItem."turnId" = sourceCall."turnId" AND priorItem."taskId" = sourceCall."taskId" AND priorItem."stepId" = source."id")))
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

/** Recovered source rows are accepted only when the private provenance sidecar and six-event lifecycle agree. */
export const CHILD_WAIT_SOURCE_RECOVERED_RESULT_SQL = `(
  sourceCall."status" = 'completed' AND sourceCall."revision" = 1 AND sourceCall."phase" IS NULL
  AND sourceResult."status" = 'completed' AND sourceResult."revision" = 1 AND sourceResult."phase" IS NULL
  AND $11::text IS NOT NULL AND $12::text IS NOT NULL AND sourceCall."content"->>'toolCallId' = $11::text
  AND sourceCall."id" = 'task:' || owner."id" || ':item:tool-call:' || (sourceCall."content"->>'toolCallId') || ':attempt:' || source."attempt"::text
  AND char_length(sourceCall."content"->>'toolCallId') BETWEEN 1 AND 256
  AND btrim(sourceCall."content"->>'toolCallId') = sourceCall."content"->>'toolCallId'
  AND (SELECT COUNT(*) FROM "agent_items" AS sourceWaitCallAny WHERE sourceWaitCallAny."sessionId" = source."sessionId"
    AND sourceWaitCallAny."turnId" = source."turnId" AND sourceWaitCallAny."taskId" = source."taskId"
    AND sourceWaitCallAny."stepId" = source."id" AND sourceWaitCallAny."type" = 'tool_call'
    AND sourceWaitCallAny."content"->>'toolName' = 'wait_subagents') = 1
  AND (SELECT COUNT(*) FROM "agent_items" AS sourceCallAny WHERE sourceCallAny."sessionId" = sourceCall."sessionId"
    AND sourceCallAny."turnId" = sourceCall."turnId" AND sourceCallAny."taskId" = sourceCall."taskId"
    AND sourceCallAny."type" = 'tool_call' AND sourceCallAny."content"->>'toolCallId' = sourceCall."content"->>'toolCallId') = 1
  AND (SELECT COUNT(*) FROM "agent_items" AS sourceResultAny WHERE sourceResultAny."sessionId" = sourceCall."sessionId"
    AND sourceResultAny."turnId" = sourceCall."turnId" AND sourceResultAny."taskId" = sourceCall."taskId"
    AND sourceResultAny."type" = 'tool_result' AND sourceResultAny."content"->>'toolCallId' = sourceCall."content"->>'toolCallId') = 1
  AND sourceCall."content" = jsonb_build_object('toolCallId', sourceCall."content"->>'toolCallId', 'toolName', 'wait_subagents',
    'toolVersion', '1', 'status', 'completed', 'errorCode', NULL, 'input', sourceCall."content"->'input')
  AND CASE WHEN jsonb_typeof(sourceCall."content"->'input') = 'object' THEN
    (SELECT COUNT(*) FROM jsonb_object_keys(sourceCall."content"->'input')) = 4
      AND sourceCall."content"->'input' ?& ARRAY['idempotencyKey', 'taskIds', 'mode', 'timeoutMs']
    ELSE FALSE END
  AND sourceCall."content"->'input' = jsonb_build_object('idempotencyKey', wait."idempotencyKey",
    'taskIds', wait."result"->'request'->'targetTaskIds', 'mode', wait."result"->'request'->'mode',
    'timeoutMs', wait."result"->'request'->'timeoutMs')
  AND sourceResult."id" = wait."result"->'sourceLifecycleRecovery'->>'resultItemId'
  AND sourceResult."id" ~ ('^task:' || owner."id" || ':item:tool-result:source-wait-recovery:[0-9a-f]{64}$')
  AND sourceResult."id" = 'task:' || owner."id" || ':item:tool-result:source-wait-recovery:' || encode(sha256(
    convert_to('child-wait-source-result:v1', 'UTF8') || decode('00', 'hex') || convert_to(wait."id", 'UTF8') || decode('00', 'hex')
    || convert_to(sourceCall."content"->>'toolCallId', 'UTF8')), 'hex')
  AND sourceResult."content" = jsonb_build_object('toolCallId', sourceCall."content"->>'toolCallId',
    'output', wait."result"->'outcome', 'errorCode', NULL)
  AND CASE WHEN jsonb_typeof(wait."result") = 'object' THEN
    (SELECT COUNT(*) FROM jsonb_object_keys(wait."result")) = 3 AND wait."result" ?& ARRAY['request', 'outcome', 'sourceLifecycleRecovery']
    ELSE FALSE END
  AND CASE WHEN jsonb_typeof(wait."result"->'sourceLifecycleRecovery') = 'object' THEN
    (SELECT COUNT(*) FROM jsonb_object_keys(wait."result"->'sourceLifecycleRecovery')) = 13
      AND wait."result"->'sourceLifecycleRecovery' ?& ARRAY['schemaVersion', 'userId', 'sessionId', 'turnId', 'rootTaskId', 'taskId', 'ownerId', 'attempt', 'stepId', 'waitId', 'toolCallId', 'callItemId', 'resultItemId']
    ELSE FALSE END
  AND wait."result"->'sourceLifecycleRecovery'->>'schemaVersion' = 'child-wait-source-lifecycle.v1'
  AND wait."result"->'sourceLifecycleRecovery'->>'userId' = session."userId"
  AND wait."result"->'sourceLifecycleRecovery'->>'sessionId' = owner."sessionId"
  AND wait."result"->'sourceLifecycleRecovery'->>'turnId' = owner."turnId"
  AND wait."result"->'sourceLifecycleRecovery'->>'rootTaskId' = owner."rootTaskId"
  AND wait."result"->'sourceLifecycleRecovery'->>'taskId' = owner."id"
  AND jsonb_typeof(wait."result"->'sourceLifecycleRecovery'->'ownerId') = 'string'
  AND char_length(wait."result"->'sourceLifecycleRecovery'->>'ownerId') BETWEEN 1 AND 256
  AND btrim(wait."result"->'sourceLifecycleRecovery'->>'ownerId') = wait."result"->'sourceLifecycleRecovery'->>'ownerId'
  AND wait."result"->'sourceLifecycleRecovery'->>'attempt' = source."attempt"::text
  AND wait."result"->'sourceLifecycleRecovery'->>'stepId' = source."id"
  AND wait."result"->'sourceLifecycleRecovery'->>'waitId' = wait."id"
  AND wait."result"->'sourceLifecycleRecovery'->>'toolCallId' = sourceCall."content"->>'toolCallId'
  AND wait."result"->'sourceLifecycleRecovery'->>'callItemId' = sourceCall."id"
  AND sourceResult."id" = wait."result"->'sourceLifecycleRecovery'->>'resultItemId'
  AND EXISTS (
    SELECT 1 FROM "agent_events" AS sourceItemStarted
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
    WHERE sourceItemStarted."sessionId" = sourceCall."sessionId" AND sourceItemStarted."turnId" = sourceCall."turnId"
      AND sourceItemStarted."taskId" = sourceCall."taskId" AND sourceItemStarted."itemId" = sourceCall."id"
      AND sourceItemStarted."type" = 'item.started' AND sourceItemStarted."actor" = 'subagent'
      AND sourceItemStarted."correlationId" = source."id"
      AND sourceItemStarted."idempotencyKey" = 'task:' || owner."id" || ':event:item-started:' || sourceCall."id"
      AND sourceItemStarted."payload" = jsonb_build_object('itemId', sourceCall."id", 'type', 'tool_call', 'phase', NULL)
      AND EXISTS (SELECT 1 FROM "agent_events" AS sourcePrior
        WHERE sourcePrior."id" = sourceItemStarted."causationId" AND sourcePrior."sessionId" = sourceCall."sessionId"
          AND sourcePrior."turnId" = sourceCall."turnId" AND sourcePrior."taskId" = sourceCall."taskId"
          AND sourcePrior."type" = 'model.usage' AND sourcePrior."actor" = 'subagent' AND sourcePrior."itemId" IS NULL
          AND sourcePrior."correlationId" = source."id"
          AND sourcePrior."idempotencyKey" = 'task:' || owner."id" || ':event:model-usage:' || source."id"
          AND sourcePrior."sequence" < sourceItemStarted."sequence")
      AND sourceCallStarted."itemId" = sourceCall."id" AND sourceCallStarted."type" = 'tool_call.started'
      AND sourceCallStarted."actor" = 'subagent' AND sourceCallStarted."correlationId" = sourceCall."content"->>'toolCallId'
      AND sourceCallStarted."idempotencyKey" = 'task:' || owner."id" || ':event:tool-started:' || (sourceCall."content"->>'toolCallId')
      AND sourceCallStarted."payload" = jsonb_build_object('toolCallId', sourceCall."content"->>'toolCallId', 'toolName', 'wait_subagents', 'taskId', owner."id")
      AND sourceCallCompleted."itemId" = sourceCall."id" AND sourceCallCompleted."type" = 'item.completed'
      AND sourceCallCompleted."actor" = 'subagent' AND sourceCallCompleted."correlationId" = sourceCall."id"
      AND sourceCallCompleted."idempotencyKey" = 'task:' || owner."id" || ':event:tool-call-completed:' || (sourceCall."content"->>'toolCallId') || ':' || sourceCall."id" || ':1'
      AND CASE WHEN jsonb_typeof(sourceCallCompleted."payload") = 'object' THEN
        (SELECT COUNT(*) FROM jsonb_object_keys(sourceCallCompleted."payload")) = 3
          AND sourceCallCompleted."payload" ?& ARRAY['itemId', 'status', 'content'] ELSE FALSE END
      AND sourceCallCompleted."payload"->>'itemId' = sourceCall."id" AND sourceCallCompleted."payload"->>'status' = 'completed'
      AND CASE WHEN jsonb_typeof(sourceCallCompleted."payload"->'content') = 'object' THEN
        (SELECT COUNT(*) FROM jsonb_object_keys(sourceCallCompleted."payload"->'content')) = 6
          AND sourceCallCompleted."payload"->'content'->>'toolName' = 'wait_subagents'
          AND sourceCallCompleted."payload"->'content'->>'toolVersion' = '1'
          AND sourceCallCompleted."payload"->'content'->>'status' = 'completed'
          AND jsonb_typeof(sourceCallCompleted."payload"->'content'->'toolCallId') = 'string' AND sourceCallCompleted."payload"->'content'->>'toolCallId' = $12::text
          AND sourceCallCompleted."payload"->'content'->'errorCode' = 'null'::jsonb
          AND sourceCallCompleted."payload"->'content'->'input' = jsonb_build_object('idempotencyKey', '[REDACTED]',
            'taskIds', (SELECT jsonb_agg(to_jsonb('[REDACTED]'::text) ORDER BY ordinal)
              FROM generate_series(1, CASE WHEN jsonb_typeof(sourceCall."content"->'input'->'taskIds') = 'array'
                THEN jsonb_array_length(sourceCall."content"->'input'->'taskIds') ELSE 0 END) AS target(ordinal)),
            'mode', sourceCall."content"->'input'->'mode', 'timeoutMs', sourceCall."content"->'input'->'timeoutMs')
        ELSE FALSE END
      AND sourceTerminal."itemId" = sourceCall."id" AND sourceTerminal."type" = 'tool_call.completed'
      AND sourceTerminal."actor" = 'subagent' AND sourceTerminal."correlationId" = sourceCall."content"->>'toolCallId'
      AND sourceTerminal."idempotencyKey" = 'task:' || owner."id" || ':event:tool-finished:' || (sourceCall."content"->>'toolCallId')
      AND sourceTerminal."payload" = jsonb_build_object('toolCallId', sourceCall."content"->>'toolCallId', 'toolName', 'wait_subagents',
        'status', 'completed', 'errorCode', NULL, 'taskId', owner."id")
      AND sourceResultStarted."itemId" = sourceResult."id" AND sourceResultStarted."type" = 'item.started'
      AND sourceResultStarted."actor" = 'subagent' AND sourceResultStarted."correlationId" = source."id"
      AND sourceResultStarted."idempotencyKey" = 'task:' || owner."id" || ':event:item-started:' || sourceResult."id"
      AND sourceResultStarted."payload" = jsonb_build_object('itemId', sourceResult."id", 'type', 'tool_result', 'phase', NULL)
      AND sourceResultCompleted."itemId" = sourceResult."id" AND sourceResultCompleted."type" = 'item.completed'
      AND sourceResultCompleted."actor" = 'subagent' AND sourceResultCompleted."correlationId" = sourceResult."id"
      AND sourceResultCompleted."idempotencyKey" = 'task:' || owner."id" || ':event:tool-result-completed:' || (sourceCall."content"->>'toolCallId') || ':' || sourceResult."id" || ':1'
      AND sourceResultCompleted."payload" = jsonb_build_object('itemId', sourceResult."id", 'status', 'completed', 'content', sourceResult."content")
      AND (SELECT COUNT(*) FROM "agent_events" AS sourceEvent WHERE sourceEvent."sessionId" = sourceCall."sessionId"
        AND sourceEvent."turnId" = sourceCall."turnId" AND sourceEvent."taskId" = sourceCall."taskId"
        AND (sourceEvent."itemId" = sourceCall."id" OR sourceEvent."correlationId" = sourceCall."content"->>'toolCallId'
          OR sourceEvent."itemId" = sourceResult."id" OR sourceEvent."correlationId" = sourceResult."id"
          OR sourceEvent."causationId" IN (sourceItemStarted."id", sourceCallStarted."id", sourceCallCompleted."id", sourceTerminal."id", sourceResultStarted."id")
          OR sourceEvent."idempotencyKey" = ANY(ARRAY['task:' || owner."id" || ':event:item-started:' || sourceCall."id",
            'task:' || owner."id" || ':event:tool-started:' || (sourceCall."content"->>'toolCallId'),
            'task:' || owner."id" || ':event:tool-call-completed:' || (sourceCall."content"->>'toolCallId') || ':' || sourceCall."id" || ':1',
            'task:' || owner."id" || ':event:tool-finished:' || (sourceCall."content"->>'toolCallId'),
            'task:' || owner."id" || ':event:item-started:' || sourceResult."id",
            'task:' || owner."id" || ':event:tool-result-completed:' || (sourceCall."content"->>'toolCallId') || ':' || sourceResult."id" || ':1']))) = 6
  )
)`
