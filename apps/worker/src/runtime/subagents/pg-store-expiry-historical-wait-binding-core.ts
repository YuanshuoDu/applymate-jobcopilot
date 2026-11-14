import { CHILD_WAIT_HISTORICAL_SOURCE_EVENT_BINDING_SQL, CHILD_WAIT_HISTORICAL_SOURCE_RESULT_RECEIPT_SQL } from "./pg-store-expiry-historical-wait-event-binding.js"
import { safeSubagentWaitJson } from "./subagent-wait-structural-ids.js"

const objectHasExactKeyCount = (expression: string, count: number) => `(CASE WHEN jsonb_typeof(${expression}) = 'object'
  THEN (SELECT COUNT(*) FROM jsonb_object_keys(${expression})) = ${count} ELSE FALSE END)`
const array = (expression: string) => `CASE WHEN jsonb_typeof(${expression}) = 'array' THEN ${expression} ELSE '[]'::jsonb END`
const terminal = "'completed', 'failed', 'interrupted', 'cancelled', 'closed', 'passed', 'skipped'"
const targetIds = array('boundWait."targetTaskIds"'), matchedIds = array('boundWait."matchedTaskIds"')
const taskSnapshots = array('boundWait."result"->\'outcome\'->\'tasks\'')

/** Match a persisted continuation key only to the redacted projection of its exact source key. */
export function childWaitContinuationKeyMatchesSafeProjection(sourceKey: unknown, continuationKey: unknown): boolean {
  if (typeof sourceKey !== "string" || typeof continuationKey !== "string"
    || sourceKey.length < 1 || sourceKey.length > 256 || sourceKey.trim() !== sourceKey
    || continuationKey.length < 1 || continuationKey.length > 256 || continuationKey.trim() !== continuationKey) return false
  const projected = safeSubagentWaitJson(sourceKey, 16_384)
  return typeof projected === "string" && projected === continuationKey
}
/** Final settlement re-reads the bound receipt and all durable source/result rows under the locked session. */
export function buildHistoricalWaitBindingSql(extraPredicate: string): string { return `EXISTS (
  SELECT 1 FROM "agent_wait_conditions" AS boundWait
  JOIN "agent_steps" AS boundSource ON boundSource."id" = boundWait."stepId"
    AND boundSource."sessionId" = boundWait."sessionId" AND boundSource."turnId" = boundWait."turnId"
    AND boundSource."taskId" = boundWait."parentTaskId"
  JOIN "agent_items" AS boundSourceCall ON boundSourceCall."sessionId" = boundSource."sessionId"
    AND boundSourceCall."turnId" = boundSource."turnId" AND boundSourceCall."taskId" = boundSource."taskId"
    AND boundSourceCall."stepId" = boundSource."id" AND boundSourceCall."type" = 'tool_call'
  JOIN "agent_items" AS boundSourceResult ON boundSourceResult."sessionId" = boundSourceCall."sessionId"
    AND boundSourceResult."turnId" = boundSourceCall."turnId" AND boundSourceResult."taskId" = boundSourceCall."taskId"
    AND boundSourceResult."type" = 'tool_result'
    AND boundSourceResult."id" = proof.value->'sourceWait'->>'sourceResultItemId'
  WHERE jsonb_typeof(proof.value->'sourceWait') = 'object'
    AND CASE WHEN jsonb_typeof(proof.value->'sourceWait') = 'object'
      THEN (SELECT COUNT(*) FROM jsonb_object_keys(proof.value->'sourceWait')) = 17 ELSE FALSE END
    AND proof.value->'sourceWait' ?& ARRAY['waitId', 'sourceStepId', 'sourceAttempt', 'sourceCallItemId', 'sourceCallId',
      'projectedSourceCallId', 'sourceResultItemId', 'sourceKeyDigest', 'sourceLifecycleRecoveryOwnerDigest', 'claimKeyDigest', 'deadlineAt', 'status', 'mode',
      'targetTaskIds', 'matchedTaskIds', 'timeoutMs', 'sourceKind']
    AND boundWait."id" = proof.value->'sourceWait'->>'waitId'
    AND boundWait."parentTaskId" = owner."id" AND boundWait."sessionId" = owner."sessionId"
    AND boundWait."turnId" = owner."turnId" AND boundWait."userId" = session."userId"
    AND owner."id" = $2 AND owner."sessionId" = $1 AND owner."turnId" = $3 AND owner."rootTaskId" = $4
    AND owner."status" = 'running' AND owner."parentTaskId" IS NOT NULL AND owner."leaseOwner" = $5
    AND owner."attemptCount" = $6 AND owner."leaseExpiresAt" = $7 AND owner."interruptRequestedAt" IS NULL
    AND session."userId" = $8 AND turn."userId" = session."userId" AND turn."rootTaskId" = owner."rootTaskId"
    AND boundWait."status" IN ('ready', 'timed_out') AND boundWait."suspendedAt" IS NOT NULL AND boundWait."consumedAt" IS NOT NULL
    AND (SELECT COUNT(*) FROM "agent_wait_conditions" AS sameStepWait WHERE sameStepWait."parentTaskId" = owner."id"
      AND sameStepWait."sessionId" = owner."sessionId" AND sameStepWait."turnId" = owner."turnId"
      AND sameStepWait."stepId" = boundWait."stepId") = 1
    AND boundWait."status" = proof.value->'sourceWait'->>'status'
    AND boundWait."mode" IN ('any', 'all') AND boundWait."mode" = proof.value->'sourceWait'->>'mode'
    AND boundWait."deadlineAt" IS NOT NULL AND boundWait."resolvedAt" IS NOT NULL
    AND to_char(boundWait."deadlineAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = proof.value->'sourceWait'->>'deadlineAt'
    AND boundWait."targetTaskIds" = proof.value->'sourceWait'->'targetTaskIds'
    AND boundWait."matchedTaskIds" = proof.value->'sourceWait'->'matchedTaskIds'
    AND jsonb_typeof(boundWait."targetTaskIds") = 'array' AND jsonb_typeof(boundWait."matchedTaskIds") = 'array'
    AND (SELECT COUNT(*) FROM jsonb_array_elements(${targetIds}) AS target(value)) BETWEEN 1 AND 8
    AND (SELECT COUNT(*) FROM jsonb_array_elements_text(${targetIds}) AS target(id))
      = (SELECT COUNT(DISTINCT target.id) FROM jsonb_array_elements_text(${targetIds}) AS target(id))
    AND (SELECT COUNT(*) FROM jsonb_array_elements(${targetIds}) AS target(value)
      WHERE jsonb_typeof(target.value) = 'string' AND char_length(target.value #>> '{}') BETWEEN 1 AND 256
        AND btrim(target.value #>> '{}') = target.value #>> '{}') = jsonb_array_length(${targetIds})
    AND (SELECT COUNT(*) FROM jsonb_array_elements_text(${matchedIds}) AS target(id))
      = (SELECT COUNT(DISTINCT target.id) FROM jsonb_array_elements_text(${matchedIds}) AS target(id))
    AND (SELECT COUNT(*) FROM jsonb_array_elements(${matchedIds}) AS target(value)
      WHERE jsonb_typeof(target.value) = 'string' AND char_length(target.value #>> '{}') BETWEEN 1 AND 256
        AND btrim(target.value #>> '{}') = target.value #>> '{}') = jsonb_array_length(${matchedIds})
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(${targetIds}) AS target(id)
      WHERE NOT EXISTS (SELECT 1 FROM "sub_agent_tasks" AS child WHERE child."id" = target.id AND child."id" <> owner."id"
        AND child."parentTaskId" = owner."id" AND child."sessionId" = owner."sessionId" AND child."turnId" = owner."turnId"
        AND child."rootTaskId" = owner."rootTaskId"))
    AND CASE WHEN proof.value->'sourceWait'->>'sourceKind' = 'normal_waiting'
      THEN ${objectHasExactKeyCount('boundWait."result"', 2)} AND boundWait."result" ?& ARRAY['request', 'outcome']
        AND NOT (boundWait."result" ? 'sourceLifecycleRecovery')
      WHEN proof.value->'sourceWait'->>'sourceKind' = 'recovered'
      THEN ${objectHasExactKeyCount('boundWait."result"', 3)} AND boundWait."result" ?& ARRAY['request', 'outcome', 'sourceLifecycleRecovery']
      ELSE FALSE END
    AND ${objectHasExactKeyCount('boundWait."result"->\'request\'', 3)}
    AND boundWait."result"->'request' = jsonb_build_object('targetTaskIds', boundWait."targetTaskIds", 'mode', boundWait."mode",
      'timeoutMs', boundWait."result"->'request'->'timeoutMs')
    AND jsonb_typeof(boundWait."result"->'request'->'timeoutMs') = 'number'
    AND boundWait."result"->'request'->>'timeoutMs' ~ '^([1-9][0-9]{0,3}|[12][0-9]{4}|30000)$'
    AND boundWait."result"->'request'->>'timeoutMs' = proof.value->'sourceWait'->>'timeoutMs'
    AND ${objectHasExactKeyCount('boundWait."result"->\'outcome\'', 6)}
    AND boundWait."result"->'outcome' ?& ARRAY['waitId', 'status', 'taskIds', 'deadlineAt', 'matchedTaskIds', 'tasks']
    AND boundWait."result"->'outcome'->>'waitId' = boundWait."id"
    AND boundWait."result"->'outcome'->>'status' = boundWait."status"
    AND boundWait."result"->'outcome'->'taskIds' = boundWait."targetTaskIds"
    AND boundWait."result"->'outcome'->'matchedTaskIds' = boundWait."matchedTaskIds"
    AND boundWait."result"->'outcome'->>'deadlineAt' = proof.value->'sourceWait'->>'deadlineAt'
    AND jsonb_typeof(boundWait."result"->'outcome'->'tasks') = 'array'
    AND jsonb_array_length(${taskSnapshots}) = jsonb_array_length(${targetIds})
    AND (SELECT COUNT(*) FROM jsonb_array_elements(${taskSnapshots}) AS saved(value)
      WHERE CASE WHEN jsonb_typeof(saved.value) = 'object' THEN
        (SELECT COUNT(*) FROM jsonb_object_keys(saved.value)) = 5 AND saved.value ?& ARRAY['taskId', 'status', 'role', 'result', 'failureReason']
          AND jsonb_typeof(saved.value->'taskId') = 'string' AND char_length(saved.value->>'taskId') BETWEEN 1 AND 256
          AND btrim(saved.value->>'taskId') = saved.value->>'taskId'
          AND saved.value->>'status' IN ('queued', 'running', 'retrying', 'waiting', 'waiting_for_user', ${terminal})
          AND jsonb_typeof(saved.value->'role') = 'string' AND char_length(saved.value->>'role') BETWEEN 1 AND 80
          AND btrim(saved.value->>'role') <> ''
          AND jsonb_typeof(saved.value->'failureReason') IN ('null', 'string')
          AND (jsonb_typeof(saved.value->'failureReason') = 'null' OR char_length(saved.value->>'failureReason') <= 256)
        ELSE FALSE END) = jsonb_array_length(${targetIds})
    AND (SELECT ARRAY(SELECT saved.value->>'taskId' FROM jsonb_array_elements(${taskSnapshots}) AS saved(value) ORDER BY 1))
      = (SELECT ARRAY(SELECT target.id FROM jsonb_array_elements_text(${targetIds}) AS target(id) ORDER BY 1))
    AND (SELECT ARRAY(SELECT saved.value->>'taskId' FROM jsonb_array_elements(${taskSnapshots}) AS saved(value)
      WHERE saved.value->>'status' IN (${terminal}) ORDER BY 1))
      = (SELECT ARRAY(SELECT target.id FROM jsonb_array_elements_text(${matchedIds}) AS target(id) ORDER BY 1))
    AND ((boundWait."status" = 'timed_out' AND boundWait."resolvedAt" >= boundWait."deadlineAt")
      OR (boundWait."status" = 'ready' AND boundWait."resolvedAt" < boundWait."deadlineAt"
        AND ((boundWait."mode" = 'any' AND jsonb_array_length(${matchedIds}) > 0)
          OR (boundWait."mode" = 'all' AND jsonb_array_length(${matchedIds}) = jsonb_array_length(${targetIds})))))
    AND boundSource."id" = proof.value->'sourceWait'->>'sourceStepId'
    AND CASE WHEN jsonb_typeof(proof.value->'sourceWait'->'sourceAttempt') = 'number'
      AND proof.value->'sourceWait'->>'sourceAttempt' ~ '^[1-9][0-9]{0,9}$'
      AND (char_length(proof.value->'sourceWait'->>'sourceAttempt') < 10 OR
        (proof.value->'sourceWait'->>'sourceAttempt' COLLATE "C") <= ('2147483647'::text COLLATE "C"))
      THEN boundSource."attempt"::text = proof.value->'sourceWait'->>'sourceAttempt' ELSE FALSE END
    AND boundSource."attempt" BETWEEN 1 AND owner."attemptCount"
    AND boundSource."status" IN ('waiting_for_tool', 'completed')
    AND boundSourceCall."id" = proof.value->'sourceWait'->>'sourceCallItemId'
    AND boundSourceCall."content"->>'toolCallId' = proof.value->'sourceWait'->>'sourceCallId'
    AND boundSourceCall."content"->>'toolName' = 'wait_subagents' AND boundSourceCall."content"->>'toolVersion' = '1'
    AND boundSourceCall."status" = 'completed' AND boundSourceCall."revision" = 1 AND boundSourceCall."phase" IS NULL
    AND boundSourceCall."id" = 'task:' || owner."id" || ':item:tool-call:' || (boundSourceCall."content"->>'toolCallId') || ':attempt:' || boundSource."attempt"::text
    AND ${objectHasExactKeyCount('boundSourceCall."content"', 6)}
    AND boundSourceCall."content" = jsonb_build_object('toolCallId', boundSourceCall."content"->>'toolCallId', 'toolName', 'wait_subagents',
      'toolVersion', '1', 'input', boundSourceCall."content"->'input', 'status', 'completed', 'errorCode', NULL)
    AND ${objectHasExactKeyCount('boundSourceCall."content"->\'input\'', 4)}
    AND boundSourceCall."content"->'input' = jsonb_build_object('idempotencyKey', boundWait."idempotencyKey",
      'taskIds', boundWait."targetTaskIds", 'mode', boundWait."mode", 'timeoutMs', boundWait."result"->'request'->'timeoutMs')
    AND encode(sha256(convert_to(boundWait."idempotencyKey", 'UTF8')), 'hex') = proof.value->'sourceWait'->>'sourceKeyDigest'
    AND proof.value->>'callItemId' = callItem."id" AND proof.value->>'rawCallId' = callItem."content"->>'toolCallId'
    AND proof.value->>'stepId' = callStep."id" AND proof.value->>'attempt' = callStep."attempt"::text
    AND callItem."stepId" = callStep."id"
    AND CASE WHEN proof.value->'sourceWait'->'claimKeyDigest' = 'null'::jsonb THEN
      boundSourceCall."id" = proof.value->>'callItemId' AND boundSourceCall."content"->>'toolCallId' = proof.value->>'rawCallId'
      AND proof.value->>'projectedCallId' = proof.value->'sourceWait'->>'projectedSourceCallId'
    ELSE callItem."id" <> boundSourceCall."id" END
    AND boundSourceResult."status" = 'completed' AND boundSourceResult."revision" = 1 AND boundSourceResult."phase" IS NULL
    AND ${CHILD_WAIT_HISTORICAL_SOURCE_RESULT_RECEIPT_SQL}
    AND ${CHILD_WAIT_HISTORICAL_SOURCE_EVENT_BINDING_SQL}
    AND (SELECT COUNT(*) FROM "agent_items" AS sameSourceCall WHERE sameSourceCall."sessionId" = boundSource."sessionId"
      AND sameSourceCall."turnId" = boundSource."turnId" AND sameSourceCall."taskId" = boundSource."taskId"
      AND sameSourceCall."stepId" = boundSource."id" AND sameSourceCall."type" = 'tool_call'
      AND sameSourceCall."content"->>'toolName' = 'wait_subagents') = 1
    AND (SELECT COUNT(*) FROM "agent_items" AS sameResult WHERE sameResult."sessionId" = boundSourceCall."sessionId"
      AND sameResult."turnId" = boundSourceCall."turnId" AND sameResult."taskId" = boundSourceCall."taskId"
      AND sameResult."type" = 'tool_result' AND sameResult."content"->>'toolCallId' = boundSourceCall."content"->>'toolCallId') = 1
    AND CASE WHEN proof.value->'sourceWait'->'claimKeyDigest' = 'null'::jsonb THEN callItem."id" = boundSourceCall."id"
      ELSE callItem."id" <> boundSourceCall."id" AND callStep."attempt" = owner."attemptCount"
        AND callStep."status" = 'completed'
        AND callStep."id" = (SELECT nextStep."id" FROM "agent_steps" AS nextStep
          WHERE nextStep."sessionId" = boundSource."sessionId" AND nextStep."turnId" = boundSource."turnId"
            AND nextStep."taskId" = owner."id" AND nextStep."attempt" = owner."attemptCount"
            AND nextStep."ordinal" > boundSource."ordinal" ORDER BY nextStep."ordinal", nextStep."id" LIMIT 1)
        AND callItem."id" = 'task:' || owner."id" || ':item:tool-call:' || (callItem."content"->>'toolCallId') || ':attempt:' || callStep."attempt"::text
        AND CASE WHEN jsonb_typeof(callItem."content") = 'object'
          THEN (SELECT COUNT(*) FROM jsonb_object_keys(callItem."content")) = 6 ELSE FALSE END
        AND callItem."content" = jsonb_build_object('toolCallId', callItem."content"->>'toolCallId', 'toolName', 'wait_subagents',
          'toolVersion', '1', 'input', callItem."content"->'input', 'status', 'completed', 'errorCode', NULL)
        AND callItem."content"->>'status' = 'completed'
        AND callItem."content"->'errorCode' = 'null'::jsonb
        AND callItem."content"->'input' = jsonb_build_object('idempotencyKey', callItem."content"->'input'->'idempotencyKey',
          'taskIds', boundWait."targetTaskIds", 'mode', boundWait."mode", 'timeoutMs', boundWait."result"->'request'->'timeoutMs')
        AND encode(sha256(convert_to(callItem."content"->'input'->>'idempotencyKey', 'UTF8')), 'hex') = proof.value->'sourceWait'->>'claimKeyDigest'
      END
    AND ${extraPredicate}
)`
}

export const CHILD_WAIT_HISTORICAL_WAIT_CORE_BINDING_SQL = buildHistoricalWaitBindingSql("TRUE")
