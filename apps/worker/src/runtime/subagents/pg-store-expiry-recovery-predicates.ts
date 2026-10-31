import type pg from "pg"
import { dateValue } from "./pg-store-persistence.js"
import { CHILD_WAIT_CALL_LIFECYCLE_SQL, CHILD_WAIT_CALL_TERMINAL_SETTLEMENT_SQL, CHILD_WAIT_CLAIM_KEY_COLUMNS_SQL, childWaitContinuationKeyMatchesSafeProjection } from "./pg-store-expiry-child-wait-claim-call-proof.js"
import { CHILD_WAIT_SOURCE_RECOVERED_RESULT_SQL, CHILD_WAIT_SOURCE_STARTED_NO_RESULT_SQL } from "./pg-store-expiry-child-wait-source-proof.js"
const CLAIM_WAIT_DEADLINE_RECEIPT_SQL = `jsonb_typeof(wait."result"->'outcome'->'deadlineAt') = 'string' AND char_length(wait."result"->'outcome'->>'deadlineAt') = 24 AND CASE WHEN wait."result"->'outcome'->>'deadlineAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' THEN substring(wait."result"->'outcome'->>'deadlineAt', 1, 4)::int BETWEEN 1 AND 9999 AND substring(wait."result"->'outcome'->>'deadlineAt', 6, 2)::int BETWEEN 1 AND 12 AND substring(wait."result"->'outcome'->>'deadlineAt', 9, 2)::int BETWEEN 1 AND CASE substring(wait."result"->'outcome'->>'deadlineAt', 6, 2)::int WHEN 2 THEN CASE WHEN substring(wait."result"->'outcome'->>'deadlineAt', 1, 4)::int % 400 = 0 OR (substring(wait."result"->'outcome'->>'deadlineAt', 1, 4)::int % 4 = 0 AND substring(wait."result"->'outcome'->>'deadlineAt', 1, 4)::int % 100 <> 0) THEN 29 ELSE 28 END WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30 ELSE 31 END AND substring(wait."result"->'outcome'->>'deadlineAt', 12, 2)::int BETWEEN 0 AND 23 AND substring(wait."result"->'outcome'->>'deadlineAt', 15, 2)::int BETWEEN 0 AND 59 AND substring(wait."result"->'outcome'->>'deadlineAt', 18, 2)::int BETWEEN 0 AND 59 ELSE FALSE END AND sourceCall."status" = 'completed' AND sourceResult."status" = 'completed' AND sourceResult."content"->>'errorCode' IS NULL AND jsonb_typeof(sourceResult."content"->'output') = 'object' AND sourceResult."content"->'output'->>'waitId' = wait."id" AND sourceResult."content"->'output'->>'status' = 'waiting' AND jsonb_typeof(sourceResult."content"->'output'->'taskIds') = 'array' AND sourceResult."content"->'output'->'matchedTaskIds' = '[]'::jsonb AND jsonb_array_length(CASE WHEN jsonb_typeof(sourceResult."content"->'output'->'taskIds') = 'array' THEN sourceResult."content"->'output'->'taskIds' ELSE '[]'::jsonb END) = jsonb_array_length(wait."targetTaskIds") AND (SELECT COUNT(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(sourceResult."content"->'output'->'taskIds') = 'array' THEN sourceResult."content"->'output'->'taskIds' ELSE '[]'::jsonb END) AS receiptTarget(value) WHERE jsonb_typeof(receiptTarget.value) = 'string' AND char_length(receiptTarget.value #>> '{}') BETWEEN 1 AND 256 AND btrim(receiptTarget.value #>> '{}') = receiptTarget.value #>> '{}') = jsonb_array_length(CASE WHEN jsonb_typeof(sourceResult."content"->'output'->'taskIds') = 'array' THEN sourceResult."content"->'output'->'taskIds' ELSE '[]'::jsonb END) AND (SELECT COUNT(DISTINCT receiptTarget.id) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(sourceResult."content"->'output'->'taskIds') = 'array' THEN sourceResult."content"->'output'->'taskIds' ELSE '[]'::jsonb END) AS receiptTarget(id)) = jsonb_array_length(CASE WHEN jsonb_typeof(sourceResult."content"->'output'->'taskIds') = 'array' THEN sourceResult."content"->'output'->'taskIds' ELSE '[]'::jsonb END) AND (SELECT ARRAY(SELECT id FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(sourceResult."content"->'output'->'taskIds') = 'array' THEN sourceResult."content"->'output'->'taskIds' ELSE '[]'::jsonb END) AS receiptTarget(id) ORDER BY id)) = (SELECT ARRAY(SELECT id FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) AS target(id) ORDER BY id)) AND jsonb_typeof(sourceResult."content"->'output'->'deadlineAt') = 'string' AND sourceResult."content"->'output'->>'deadlineAt' = wait."result"->'outcome'->>'deadlineAt' AND jsonb_typeof(sourceResult."content"->'output'->'tasks') = 'array' AND jsonb_array_length(CASE WHEN jsonb_typeof(sourceResult."content"->'output'->'tasks') = 'array' THEN sourceResult."content"->'output'->'tasks' ELSE '[]'::jsonb END) = jsonb_array_length(wait."targetTaskIds") AND (SELECT COUNT(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(sourceResult."content"->'output'->'tasks') = 'array' THEN sourceResult."content"->'output'->'tasks' ELSE '[]'::jsonb END) AS receiptTask(value) WHERE jsonb_typeof(receiptTask.value) = 'object' AND jsonb_typeof(receiptTask.value->'taskId') = 'string' AND char_length(receiptTask.value->>'taskId') BETWEEN 1 AND 256 AND btrim(receiptTask.value->>'taskId') = receiptTask.value->>'taskId') = jsonb_array_length(CASE WHEN jsonb_typeof(sourceResult."content"->'output'->'tasks') = 'array' THEN sourceResult."content"->'output'->'tasks' ELSE '[]'::jsonb END) AND (SELECT COUNT(DISTINCT receiptTask.value->>'taskId') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(sourceResult."content"->'output'->'tasks') = 'array' THEN sourceResult."content"->'output'->'tasks' ELSE '[]'::jsonb END) AS receiptTask(value)) = jsonb_array_length(CASE WHEN jsonb_typeof(sourceResult."content"->'output'->'tasks') = 'array' THEN sourceResult."content"->'output'->'tasks' ELSE '[]'::jsonb END) AND (SELECT ARRAY(SELECT receiptTask.value->>'taskId' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(sourceResult."content"->'output'->'tasks') = 'array' THEN sourceResult."content"->'output'->'tasks' ELSE '[]'::jsonb END) AS receiptTask(value) ORDER BY 1)) = (SELECT ARRAY(SELECT target.id FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) AS target(id) ORDER BY target.id)) AND (wait."status" <> 'timed_out' OR wait."result"->'outcome'->>'deadlineAt' <= to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AND (SELECT COUNT(*) FROM "agent_items" AS duplicateResult WHERE duplicateResult."sessionId" = sourceCall."sessionId" AND duplicateResult."turnId" = sourceCall."turnId" AND duplicateResult."taskId" = sourceCall."taskId" AND duplicateResult."stepId" = sourceCall."stepId" AND duplicateResult."type" = 'tool_result' AND duplicateResult."content"->>'toolCallId' = sourceCall."content"->>'toolCallId') = 1`

export const CHILD_WAIT_RESUMABLE_SQL = `(SELECT COUNT(*) = 1
  FROM "agent_wait_conditions" AS wait
  JOIN "agent_turns" AS waitTurn ON waitTurn."id" = wait."turnId" AND waitTurn."sessionId" = wait."sessionId"
    AND waitTurn."userId" = wait."userId" AND waitTurn."userId" = $3 AND waitTurn."rootTaskId" = task."rootTaskId"
  JOIN "agent_steps" AS step ON step."id" = wait."stepId" AND step."sessionId" = wait."sessionId"
    AND step."turnId" = wait."turnId" AND step."taskId" = task."id"
  WHERE task."parentTaskId" IS NOT NULL AND task."status" = 'running' AND wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId" AND wait."turnId" = task."turnId"
    AND task."attemptCount" >= 0 AND task."maxAttempts" > 0 AND step."attempt" = task."attemptCount"
    AND ((wait."consumedAt" IS NULL AND step."status" = 'waiting_for_tool' AND step."ordinal" = (SELECT MAX(currentStep."ordinal") FROM "agent_steps" AS currentStep
        WHERE currentStep."taskId" = task."id" AND currentStep."sessionId" = task."sessionId"
          AND currentStep."turnId" = task."turnId" AND currentStep."attempt" = task."attemptCount"))
      OR (step."status" IN ('waiting_for_tool', 'completed')
        AND EXISTS (SELECT 1 FROM "agent_steps" AS continuation WHERE continuation."taskId" = task."id"
          AND continuation."sessionId" = task."sessionId" AND continuation."turnId" = task."turnId"
          AND continuation."attempt" = task."attemptCount"
          AND continuation."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later
            WHERE later."taskId" = task."id" AND later."sessionId" = task."sessionId"
              AND later."turnId" = task."turnId" AND later."attempt" = task."attemptCount" AND later."ordinal" > step."ordinal")
          AND continuation."ordinal" = (SELECT MAX(currentStep."ordinal") FROM "agent_steps" AS currentStep
            WHERE currentStep."taskId" = task."id" AND currentStep."sessionId" = task."sessionId"
              AND currentStep."turnId" = task."turnId" AND currentStep."attempt" = task."attemptCount"))))
    AND wait."status" IN ('ready', 'timed_out') AND wait."suspendedAt" IS NOT NULL
    AND wait."id" = (SELECT currentWait."id" FROM "agent_wait_conditions" AS currentWait
      JOIN "agent_steps" AS currentWaitStep ON currentWaitStep."id" = currentWait."stepId" AND currentWaitStep."sessionId" = currentWait."sessionId" AND currentWaitStep."turnId" = currentWait."turnId" AND currentWaitStep."taskId" = task."id" AND currentWaitStep."attempt" = task."attemptCount"
      WHERE currentWait."parentTaskId" = task."id" AND currentWait."sessionId" = task."sessionId" AND currentWait."turnId" = task."turnId" ORDER BY currentWaitStep."ordinal" DESC, currentWait."createdAt" DESC, currentWait."id" DESC LIMIT 1)
    AND wait."mode" IN ('any', 'all') AND jsonb_typeof(wait."targetTaskIds") = 'array' AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) > 0
    AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) <= 8 AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) = (SELECT COUNT(DISTINCT target."value")
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) AS target("value")
      WHERE jsonb_typeof(target."value") = 'string')
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END
    ) AS target("id") WHERE NOT EXISTS (SELECT 1 FROM "sub_agent_tasks" AS child
      WHERE child."id" = target."id" AND child."id" <> task."id" AND child."parentTaskId" = task."id"
        AND child."sessionId" = task."sessionId" AND child."turnId" = task."turnId"
        AND child."rootTaskId" = task."rootTaskId"))) = true`

export const CHILD_WAIT_CONSUMED_SQL = `(SELECT CASE WHEN COUNT(*) = 1 THEN MAX(continuation."id"::text) END FROM "agent_wait_conditions" AS wait
  JOIN "agent_turns" AS waitTurn ON waitTurn."id" = wait."turnId" AND waitTurn."sessionId" = wait."sessionId" AND waitTurn."userId" = wait."userId" AND waitTurn."userId" = $3 AND waitTurn."rootTaskId" = task."rootTaskId"
  JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."sessionId" = wait."sessionId" AND source."turnId" = wait."turnId" AND source."taskId" = wait."parentTaskId"
  JOIN "agent_steps" AS continuation ON continuation."sessionId" = source."sessionId"
    AND continuation."turnId" = source."turnId" AND continuation."taskId" = source."taskId" AND continuation."attempt" = source."attempt"
    AND continuation."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later WHERE later."sessionId" = source."sessionId"
      AND later."turnId" = source."turnId" AND later."taskId" = source."taskId" AND later."attempt" = source."attempt" AND later."ordinal" > source."ordinal")
  WHERE task."parentTaskId" IS NOT NULL AND task."status" = 'running' AND wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId" AND wait."turnId" = task."turnId" AND wait."consumedAt" IS NOT NULL
    AND wait."suspendedAt" IS NOT NULL AND wait."status" IN ('ready', 'timed_out') AND source."attempt" = task."attemptCount" AND source."status" IN ('waiting_for_tool', 'completed') AND continuation."status" = 'streaming'
    AND continuation."ordinal" = (SELECT MAX(currentStep."ordinal") FROM "agent_steps" AS currentStep
      WHERE currentStep."taskId" = task."id" AND currentStep."sessionId" = task."sessionId" AND currentStep."turnId" = task."turnId" AND currentStep."attempt" = task."attemptCount")
    AND wait."id" = (SELECT currentWait."id" FROM "agent_wait_conditions" AS currentWait
      JOIN "agent_steps" AS currentWaitStep ON currentWaitStep."id" = currentWait."stepId" AND currentWaitStep."sessionId" = currentWait."sessionId" AND currentWaitStep."turnId" = currentWait."turnId" AND currentWaitStep."taskId" = task."id" AND currentWaitStep."attempt" = task."attemptCount"
      WHERE currentWait."parentTaskId" = task."id" AND currentWait."sessionId" = task."sessionId" AND currentWait."turnId" = task."turnId" ORDER BY currentWaitStep."ordinal" DESC, currentWait."createdAt" DESC, currentWait."id" DESC LIMIT 1))`

export const CHILD_WAIT_CLAIM_RECOVERY_SQL = `started."type" = 'tool_call.started' AND $10::text IS NOT NULL AND EXISTS (
  SELECT 1 FROM "sub_agent_tasks" AS owner
  JOIN "agent_sessions" AS session ON session."id" = owner."sessionId" AND session."userId" = $8
  JOIN "agent_turns" AS turn ON turn."id" = owner."turnId" AND turn."sessionId" = owner."sessionId" AND turn."userId" = session."userId" AND turn."rootTaskId" = owner."rootTaskId"
  JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = owner."id" AND wait."sessionId" = owner."sessionId" AND wait."turnId" = owner."turnId" AND wait."userId" = session."userId"
  JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."sessionId" = wait."sessionId" AND source."turnId" = wait."turnId" AND source."taskId" = owner."id"
  JOIN "agent_steps" AS continuation ON continuation."id" = $10 AND continuation."sessionId" = source."sessionId" AND continuation."turnId" = source."turnId" AND continuation."taskId" = source."taskId" AND continuation."attempt" = $6
  JOIN "agent_items" AS sourceCall ON sourceCall."sessionId" = source."sessionId" AND sourceCall."turnId" = source."turnId" AND sourceCall."taskId" = source."taskId" AND sourceCall."stepId" = source."id" AND sourceCall."type" = 'tool_call'
    AND sourceCall."content"->>'toolName' = 'wait_subagents' AND sourceCall."content"->>'toolVersion' = '1'
  LEFT JOIN "agent_items" AS sourceResult ON sourceResult."sessionId" = sourceCall."sessionId" AND sourceResult."turnId" = sourceCall."turnId" AND sourceResult."taskId" = sourceCall."taskId" AND sourceResult."stepId" = sourceCall."stepId" AND sourceResult."type" = 'tool_result'
    AND sourceResult."content"->>'toolCallId' = sourceCall."content"->>'toolCallId'
  JOIN "agent_items" AS claimedCall ON claimedCall."id" = 'task:' || owner."id" || ':item:tool-call:' || started."correlationId" || ':attempt:' || owner."attemptCount"::text AND claimedCall."sessionId" = continuation."sessionId" AND claimedCall."turnId" = continuation."turnId"
    AND claimedCall."taskId" = continuation."taskId" AND claimedCall."stepId" = continuation."id" AND claimedCall."type" = 'tool_call'
  JOIN "agent_events" AS itemStarted ON itemStarted."sessionId" = claimedCall."sessionId" AND itemStarted."turnId" = claimedCall."turnId" AND itemStarted."taskId" = claimedCall."taskId" AND itemStarted."itemId" = claimedCall."id" AND itemStarted."type" = 'item.started'
    AND itemStarted."actor" = 'subagent' AND itemStarted."correlationId" = continuation."id"
    AND itemStarted."idempotencyKey" = 'task:' || owner."id" || ':event:item-started:' || claimedCall."id" AND itemStarted."payload" = jsonb_build_object('itemId', claimedCall."id", 'type', 'tool_call', 'phase', NULL)
  WHERE owner."id" = $2 AND owner."sessionId" = $1 AND owner."turnId" = $3 AND owner."rootTaskId" = $4
    AND owner."status" = 'running' AND owner."parentTaskId" IS NOT NULL AND owner."leaseOwner" = $5
    AND owner."attemptCount" = $6 AND owner."leaseExpiresAt" = $7 AND owner."interruptRequestedAt" IS NULL
    AND started."sessionId" = owner."sessionId" AND started."turnId" = owner."turnId" AND started."taskId" = owner."id"
    AND started."actor" = 'subagent' AND started."itemId" = claimedCall."id" AND started."correlationId" = claimedCall."content"->>'toolCallId'
    AND started."causationId" = itemStarted."id" AND itemStarted."sequence" < started."sequence"
    AND started."idempotencyKey" = 'task:' || owner."id" || ':event:child-wait-claim:' || owner."attemptCount"::text || ':' || continuation."id"
    AND started."payload" = jsonb_build_object('toolCallId', claimedCall."content"->>'toolCallId', 'toolName', 'wait_subagents', 'taskId', owner."id")
    AND claimedCall."content"->>'toolName' = 'wait_subagents' AND claimedCall."content"->>'toolVersion' = '1'
    AND claimedCall."content"->>'toolCallId' = started."correlationId" AND btrim(started."correlationId") <> ''
    AND ((claimedCall."status" = 'started' AND claimedCall."revision" = 0
        AND claimedCall."content" = jsonb_build_object('toolCallId', started."correlationId", 'toolName', 'wait_subagents', 'toolVersion', '1', 'input', claimedCall."content"->'input'))
      OR (claimedCall."status" = 'completed' AND claimedCall."revision" = 1
        AND claimedCall."content" = jsonb_build_object('toolCallId', started."correlationId", 'toolName', 'wait_subagents', 'toolVersion', '1',
          'input', claimedCall."content"->'input', 'status', 'completed', 'errorCode', NULL)))
    AND wait."consumedAt" IS NOT NULL AND wait."suspendedAt" IS NOT NULL AND wait."status" IN ('ready', 'timed_out')
    AND source."attempt" BETWEEN 1 AND $6 AND source."status" IN ('waiting_for_tool', 'completed')
    AND continuation."status" = 'streaming'
    AND continuation."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later WHERE later."sessionId" = source."sessionId" AND later."turnId" = source."turnId" AND later."taskId" = source."taskId" AND later."attempt" = $6 AND later."ordinal" > source."ordinal")
    AND continuation."ordinal" = (SELECT MAX(current."ordinal") FROM "agent_steps" AS current WHERE current."sessionId" = owner."sessionId" AND current."turnId" = owner."turnId" AND current."taskId" = owner."id" AND current."attempt" = $6)
    AND wait."id" = (SELECT currentWait."id" FROM "agent_wait_conditions" AS currentWait
      JOIN "agent_steps" AS currentWaitStep ON currentWaitStep."id" = currentWait."stepId" AND currentWaitStep."sessionId" = currentWait."sessionId" AND currentWaitStep."turnId" = currentWait."turnId" AND currentWaitStep."taskId" = owner."id" AND currentWaitStep."attempt" BETWEEN 1 AND $6
      WHERE currentWait."parentTaskId" = owner."id" AND currentWait."sessionId" = owner."sessionId" AND currentWait."turnId" = owner."turnId"
      ORDER BY currentWaitStep."attempt" DESC, currentWaitStep."ordinal" DESC, currentWait."createdAt" DESC, currentWait."id" DESC LIMIT 1)
    AND wait."mode" IN ('any', 'all') AND jsonb_typeof(wait."targetTaskIds") = 'array'
    AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) BETWEEN 1 AND 8
    AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) = (
      SELECT COUNT(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) AS target("value")
      WHERE jsonb_typeof(target."value") = 'string')
    AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) = (
      SELECT COUNT(DISTINCT target."value") FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) AS target("value"))
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) AS target("value")
      WHERE char_length(target."value" #>> '{}') NOT BETWEEN 1 AND 256 OR btrim(target."value" #>> '{}') <> (target."value" #>> '{}'))
    AND CASE WHEN jsonb_typeof(wait."result"->'request') = 'object' THEN (SELECT COUNT(*) FROM jsonb_object_keys(wait."result"->'request')) = 3 AND wait."result"->'request' ?& ARRAY['targetTaskIds', 'mode', 'timeoutMs'] ELSE FALSE END
    AND wait."result"->'request'->>'mode' = wait."mode" AND jsonb_typeof(wait."result"->'request'->'targetTaskIds') = 'array'
    AND (SELECT ARRAY(SELECT id FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(wait."result"->'request'->'targetTaskIds') = 'array' THEN wait."result"->'request'->'targetTaskIds' ELSE '[]'::jsonb END) AS target(id) ORDER BY id)) = (SELECT ARRAY(SELECT id FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) AS target(id) ORDER BY id))
    AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."result"->'request'->'targetTaskIds') = 'array' THEN wait."result"->'request'->'targetTaskIds' ELSE '[]'::jsonb END) = (SELECT COUNT(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wait."result"->'request'->'targetTaskIds') = 'array' THEN wait."result"->'request'->'targetTaskIds' ELSE '[]'::jsonb END) AS target(value) WHERE jsonb_typeof(target.value) = 'string' AND char_length(target.value #>> '{}') BETWEEN 1 AND 256 AND btrim(target.value #>> '{}') = (target.value #>> '{}'))
    AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."result"->'request'->'targetTaskIds') = 'array' THEN wait."result"->'request'->'targetTaskIds' ELSE '[]'::jsonb END) = (SELECT COUNT(DISTINCT id) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(wait."result"->'request'->'targetTaskIds') = 'array' THEN wait."result"->'request'->'targetTaskIds' ELSE '[]'::jsonb END) AS target(id))
    AND CASE WHEN jsonb_typeof(wait."result"->'request'->'timeoutMs') = 'number' THEN (wait."result"->'request'->>'timeoutMs')::numeric BETWEEN 1 AND 30000 AND (wait."result"->'request'->>'timeoutMs')::numeric = trunc((wait."result"->'request'->>'timeoutMs')::numeric) ELSE FALSE END
    AND CASE WHEN jsonb_typeof(wait."result"->'outcome') = 'object' THEN (SELECT COUNT(*) FROM jsonb_object_keys(wait."result"->'outcome')) = 6 AND wait."result"->'outcome' ?& ARRAY['waitId', 'status', 'taskIds', 'deadlineAt', 'matchedTaskIds', 'tasks'] ELSE FALSE END
    AND jsonb_typeof(wait."result"->'outcome'->'waitId') = 'string' AND wait."result"->'outcome'->>'waitId' = wait."id"
    AND jsonb_typeof(wait."result"->'outcome'->'status') = 'string' AND wait."result"->'outcome'->>'status' = wait."status"
    AND (${CLAIM_WAIT_DEADLINE_RECEIPT_SQL} OR ${CHILD_WAIT_SOURCE_STARTED_NO_RESULT_SQL} OR ${CHILD_WAIT_SOURCE_RECOVERED_RESULT_SQL})
    AND jsonb_typeof(wait."result"->'outcome'->'taskIds') = 'array'
    AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."result"->'outcome'->'taskIds') = 'array' THEN wait."result"->'outcome'->'taskIds' ELSE '[]'::jsonb END) = jsonb_array_length(wait."targetTaskIds")
    AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."result"->'outcome'->'taskIds') = 'array' THEN wait."result"->'outcome'->'taskIds' ELSE '[]'::jsonb END) = (SELECT COUNT(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wait."result"->'outcome'->'taskIds') = 'array' THEN wait."result"->'outcome'->'taskIds' ELSE '[]'::jsonb END) AS saved(value) WHERE jsonb_typeof(saved.value) = 'string' AND char_length(saved.value #>> '{}') BETWEEN 1 AND 256 AND btrim(saved.value #>> '{}') = (saved.value #>> '{}'))
    AND (SELECT ARRAY(SELECT id FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(wait."result"->'outcome'->'taskIds') = 'array' THEN wait."result"->'outcome'->'taskIds' ELSE '[]'::jsonb END) AS saved(id) ORDER BY id)) = (SELECT ARRAY(SELECT id FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) AS target(id) ORDER BY id))
    AND jsonb_typeof(wait."matchedTaskIds") = 'array' AND jsonb_typeof(wait."result"->'outcome'->'matchedTaskIds') = 'array'
    AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."result"->'outcome'->'matchedTaskIds') = 'array' THEN wait."result"->'outcome'->'matchedTaskIds' ELSE '[]'::jsonb END) = jsonb_array_length(wait."matchedTaskIds") AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."result"->'outcome'->'matchedTaskIds') = 'array' THEN wait."result"->'outcome'->'matchedTaskIds' ELSE '[]'::jsonb END) BETWEEN 0 AND 8
    AND jsonb_array_length(wait."matchedTaskIds") = (SELECT COUNT(*) FROM jsonb_array_elements(wait."matchedTaskIds") AS saved(value) WHERE jsonb_typeof(saved.value) = 'string' AND char_length(saved.value #>> '{}') BETWEEN 1 AND 256 AND btrim(saved.value #>> '{}') = (saved.value #>> '{}'))
    AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."result"->'outcome'->'matchedTaskIds') = 'array' THEN wait."result"->'outcome'->'matchedTaskIds' ELSE '[]'::jsonb END) = (SELECT COUNT(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wait."result"->'outcome'->'matchedTaskIds') = 'array' THEN wait."result"->'outcome'->'matchedTaskIds' ELSE '[]'::jsonb END) AS saved(value) WHERE jsonb_typeof(saved.value) = 'string' AND char_length(saved.value #>> '{}') BETWEEN 1 AND 256 AND btrim(saved.value #>> '{}') = (saved.value #>> '{}'))
    AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."result"->'outcome'->'matchedTaskIds') = 'array' THEN wait."result"->'outcome'->'matchedTaskIds' ELSE '[]'::jsonb END) = (SELECT COUNT(DISTINCT id) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(wait."result"->'outcome'->'matchedTaskIds') = 'array' THEN wait."result"->'outcome'->'matchedTaskIds' ELSE '[]'::jsonb END) AS saved(id))
    AND (SELECT ARRAY(SELECT id FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(wait."result"->'outcome'->'matchedTaskIds') = 'array' THEN wait."result"->'outcome'->'matchedTaskIds' ELSE '[]'::jsonb END) AS saved(id) ORDER BY id)) = (SELECT ARRAY(SELECT id FROM jsonb_array_elements_text(wait."matchedTaskIds") AS saved(id) ORDER BY id))
    AND jsonb_typeof(wait."result"->'outcome'->'tasks') = 'array'
    AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."result"->'outcome'->'tasks') = 'array' THEN wait."result"->'outcome'->'tasks' ELSE '[]'::jsonb END) = jsonb_array_length(wait."targetTaskIds")
    AND (SELECT COUNT(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wait."result"->'outcome'->'tasks') = 'array' THEN wait."result"->'outcome'->'tasks' ELSE '[]'::jsonb END) AS saved(value)
      WHERE CASE WHEN jsonb_typeof(saved.value) = 'object' THEN (SELECT COUNT(*) FROM jsonb_object_keys(saved.value)) = 5
        AND saved.value ?& ARRAY['taskId', 'status', 'role', 'result', 'failureReason']
        AND jsonb_typeof(saved.value->'taskId') = 'string' AND char_length(saved.value->>'taskId') BETWEEN 1 AND 256 AND btrim(saved.value->>'taskId') = saved.value->>'taskId'
        AND jsonb_typeof(saved.value->'status') = 'string' AND saved.value->>'status' IN ('queued', 'running', 'retrying', 'waiting', 'waiting_for_user', 'completed', 'failed', 'interrupted', 'cancelled', 'closed', 'passed', 'skipped')
        AND jsonb_typeof(saved.value->'role') = 'string' AND btrim(saved.value->>'role') <> ''
        AND jsonb_typeof(saved.value->'failureReason') IN ('null', 'string') ELSE FALSE END) = jsonb_array_length(CASE WHEN jsonb_typeof(wait."result"->'outcome'->'tasks') = 'array' THEN wait."result"->'outcome'->'tasks' ELSE '[]'::jsonb END)
    AND (SELECT COUNT(DISTINCT saved.value->>'taskId') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wait."result"->'outcome'->'tasks') = 'array' THEN wait."result"->'outcome'->'tasks' ELSE '[]'::jsonb END) AS saved(value)) = jsonb_array_length(CASE WHEN jsonb_typeof(wait."result"->'outcome'->'tasks') = 'array' THEN wait."result"->'outcome'->'tasks' ELSE '[]'::jsonb END)
    AND (SELECT ARRAY(SELECT saved.value->>'taskId' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wait."result"->'outcome'->'tasks') = 'array' THEN wait."result"->'outcome'->'tasks' ELSE '[]'::jsonb END) AS saved(value) ORDER BY 1)) = (SELECT ARRAY(SELECT id FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) AS target(id) ORDER BY id))
    AND (SELECT ARRAY(SELECT saved.value->>'taskId' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wait."result"->'outcome'->'tasks') = 'array' THEN wait."result"->'outcome'->'tasks' ELSE '[]'::jsonb END) AS saved(value) WHERE saved.value->>'status' IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed', 'passed', 'skipped') ORDER BY 1)) = (SELECT ARRAY(SELECT id FROM jsonb_array_elements_text(wait."matchedTaskIds") AS matched(id) ORDER BY id))
    AND (wait."status" <> 'ready' OR (wait."mode" = 'any' AND jsonb_array_length(wait."matchedTaskIds") > 0) OR (wait."mode" = 'all' AND jsonb_array_length(wait."matchedTaskIds") = jsonb_array_length(wait."targetTaskIds")))
    AND length(wait."idempotencyKey") BETWEEN 1 AND 256 AND btrim(wait."idempotencyKey") = wait."idempotencyKey"
    AND jsonb_typeof(claimedCall."content"->'input') = 'object'
    AND jsonb_typeof(claimedCall."content"->'input'->'idempotencyKey') = 'string'
    AND char_length(claimedCall."content"->'input'->>'idempotencyKey') BETWEEN 1 AND 256
    AND btrim(claimedCall."content"->'input'->>'idempotencyKey') = claimedCall."content"->'input'->>'idempotencyKey'
    AND (CASE WHEN jsonb_typeof(claimedCall."content"->'input') = 'object' THEN ((claimedCall."content"->'input') - 'taskIds'::text) - 'idempotencyKey'::text ELSE '{}'::jsonb END)
      = jsonb_build_object('mode', wait."mode", 'timeoutMs', wait."result"->'request'->'timeoutMs')
    AND (SELECT ARRAY(SELECT target."id" FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(claimedCall."content"->'input'->'taskIds') = 'array'
        THEN claimedCall."content"->'input'->'taskIds' ELSE '[]'::jsonb END) AS target("id") ORDER BY target."id"))
      = (SELECT ARRAY(SELECT target."id" FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array'
        THEN wait."targetTaskIds" ELSE '[]'::jsonb END) AS target("id") ORDER BY target."id"))
    AND jsonb_typeof(claimedCall."content"->'input'->'taskIds') = 'array'
    AND jsonb_array_length(CASE WHEN jsonb_typeof(claimedCall."content"->'input'->'taskIds') = 'array' THEN claimedCall."content"->'input'->'taskIds' ELSE '[]'::jsonb END)
      = (SELECT COUNT(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(claimedCall."content"->'input'->'taskIds') = 'array' THEN claimedCall."content"->'input'->'taskIds' ELSE '[]'::jsonb END) AS target("value")
        WHERE jsonb_typeof(target."value") = 'string' AND char_length(target."value" #>> '{}') BETWEEN 1 AND 256
          AND btrim(target."value" #>> '{}') = (target."value" #>> '{}'))
    AND jsonb_array_length(CASE WHEN jsonb_typeof(claimedCall."content"->'input'->'taskIds') = 'array' THEN claimedCall."content"->'input'->'taskIds' ELSE '[]'::jsonb END)
      = (SELECT COUNT(DISTINCT target."value") FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(claimedCall."content"->'input'->'taskIds') = 'array'
        THEN claimedCall."content"->'input'->'taskIds' ELSE '[]'::jsonb END) AS target("value"))
    AND jsonb_typeof(sourceCall."content"->'input') = 'object'
    AND jsonb_typeof(sourceCall."content"->'input'->'idempotencyKey') = 'string'
    AND sourceCall."content"->'input'->>'idempotencyKey' = wait."idempotencyKey"
    AND (CASE WHEN jsonb_typeof(sourceCall."content"->'input') = 'object' THEN ((sourceCall."content"->'input') - 'taskIds'::text) - 'idempotencyKey'::text ELSE '{}'::jsonb END)
      = (CASE WHEN jsonb_typeof(claimedCall."content"->'input') = 'object' THEN ((claimedCall."content"->'input') - 'taskIds'::text) - 'idempotencyKey'::text ELSE '{}'::jsonb END)
    AND (SELECT ARRAY(SELECT target."id" FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(sourceCall."content"->'input'->'taskIds') = 'array'
        THEN sourceCall."content"->'input'->'taskIds' ELSE '[]'::jsonb END) AS target("id") ORDER BY target."id"))
      = (SELECT ARRAY(SELECT target."id" FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(claimedCall."content"->'input'->'taskIds') = 'array'
        THEN claimedCall."content"->'input'->'taskIds' ELSE '[]'::jsonb END) AS target("id") ORDER BY target."id"))
    AND jsonb_typeof(sourceCall."content"->'input'->'taskIds') = 'array'
    AND jsonb_array_length(CASE WHEN jsonb_typeof(sourceCall."content"->'input'->'taskIds') = 'array' THEN sourceCall."content"->'input'->'taskIds' ELSE '[]'::jsonb END)
      = (SELECT COUNT(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(sourceCall."content"->'input'->'taskIds') = 'array' THEN sourceCall."content"->'input'->'taskIds' ELSE '[]'::jsonb END) AS target("value")
        WHERE jsonb_typeof(target."value") = 'string' AND char_length(target."value" #>> '{}') BETWEEN 1 AND 256
          AND btrim(target."value" #>> '{}') = (target."value" #>> '{}'))
    AND jsonb_array_length(CASE WHEN jsonb_typeof(sourceCall."content"->'input'->'taskIds') = 'array' THEN sourceCall."content"->'input'->'taskIds' ELSE '[]'::jsonb END)
      = (SELECT COUNT(DISTINCT target."value") FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(sourceCall."content"->'input'->'taskIds') = 'array'
        THEN sourceCall."content"->'input'->'taskIds' ELSE '[]'::jsonb END) AS target("value"))
    AND (SELECT COUNT(*) FROM "agent_items" AS sourceCallCandidate WHERE sourceCallCandidate."sessionId" = source."sessionId"
      AND sourceCallCandidate."turnId" = source."turnId" AND sourceCallCandidate."taskId" = source."taskId"
      AND sourceCallCandidate."stepId" = source."id" AND sourceCallCandidate."type" = 'tool_call'
      AND sourceCallCandidate."content"->>'toolName' = 'wait_subagents') = 1
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) AS target("id")
      WHERE NOT EXISTS (SELECT 1 FROM "sub_agent_tasks" AS child WHERE child."id" = target."id" AND child."id" <> owner."id"
        AND child."parentTaskId" = owner."id" AND child."sessionId" = owner."sessionId" AND child."turnId" = owner."turnId" AND child."rootTaskId" = owner."rootTaskId"))
    AND ${CHILD_WAIT_CALL_LIFECYCLE_SQL}
    AND NOT EXISTS (SELECT 1 FROM "agent_events" AS extra WHERE extra."sessionId" = claimedCall."sessionId" AND extra."turnId" = claimedCall."turnId"
      AND extra."taskId" = claimedCall."taskId" AND (extra."itemId" = claimedCall."id" OR extra."correlationId" = claimedCall."id"
        OR extra."correlationId" = started."correlationId" OR extra."causationId" = itemStarted."id" OR extra."causationId" = started."id"
        OR extra."idempotencyKey" = 'task:' || owner."id" || ':event:tool-call-completed:' || started."correlationId" || ':' || claimedCall."id" || ':1' OR extra."idempotencyKey" = 'task:' || owner."id" || ':event:tool-finished:' || started."correlationId")
      AND extra."id" <> itemStarted."id" AND extra."id" <> started."id"
      AND NOT (claimedCall."status" = 'completed' AND extra."type" = 'item.completed' AND extra."itemId" = claimedCall."id" AND extra."actor" = 'subagent'
        AND extra."correlationId" = claimedCall."id" AND extra."causationId" = started."id"
        AND extra."idempotencyKey" = 'task:' || owner."id" || ':event:tool-call-completed:' || started."correlationId" || ':' || claimedCall."id" || ':1'
        AND extra."payload" = jsonb_build_object('itemId', claimedCall."id", 'status', 'completed', 'content', claimedCall."content")))
    AND NOT EXISTS (SELECT 1 FROM "agent_items" AS result WHERE result."sessionId" = claimedCall."sessionId" AND result."turnId" = claimedCall."turnId"
      AND result."taskId" = claimedCall."taskId" AND (result."id" = 'task:' || owner."id" || ':item:tool-result:' || started."correlationId" || ':attempt:' || owner."attemptCount"::text
        OR (result."stepId" = continuation."id" AND result."type" = 'tool_result' AND result."content"->>'toolCallId' = started."correlationId")))
    AND NOT EXISTS (SELECT 1 FROM "agent_events" AS resultEvent WHERE resultEvent."sessionId" = claimedCall."sessionId"
      AND resultEvent."turnId" = claimedCall."turnId" AND resultEvent."taskId" = claimedCall."taskId" AND (resultEvent."itemId" = 'task:' || owner."id" || ':item:tool-result:' || started."correlationId" || ':attempt:' || owner."attemptCount"::text
        OR resultEvent."correlationId" = 'task:' || owner."id" || ':item:tool-result:' || started."correlationId" || ':attempt:' || owner."attemptCount"::text OR resultEvent."idempotencyKey" = 'task:' || owner."id" || ':event:item-started:task:' || owner."id" || ':item:tool-result:' || started."correlationId" || ':attempt:' || owner."attemptCount"::text
        OR resultEvent."idempotencyKey" = 'task:' || owner."id" || ':event:tool-result-completed:' || started."correlationId" || ':task:' || owner."id" || ':item:tool-result:' || started."correlationId" || ':attempt:' || owner."attemptCount"::text || ':1'))
)`

export async function hasBlockingExternalCall(client: pg.PoolClient, task: Record<string, unknown>, ignoredEventId?: string, continuationId?: string): Promise<boolean> {
  const result = await client.query<{ id: string; claimWaitId: string | null; waitDeadlineAt: unknown; outcomeDeadlineAt: unknown; sourceWaitKey: string | null; continuationWaitKey: string | null }>(`WITH latest_wait AS MATERIALIZED (
      SELECT wait."id", wait."stepId", waitStep."attempt", wait."deadlineAt", wait."result" FROM "agent_wait_conditions" AS wait
      JOIN "agent_steps" AS waitStep ON waitStep."id" = wait."stepId" AND waitStep."sessionId" = wait."sessionId" AND waitStep."turnId" = wait."turnId" AND waitStep."taskId" = wait."parentTaskId"
      WHERE wait."parentTaskId" = $2 AND wait."sessionId" = $1 AND wait."turnId" = $3 AND waitStep."attempt" BETWEEN 1 AND $6
      ORDER BY waitStep."attempt" DESC, waitStep."ordinal" DESC, wait."createdAt" DESC, wait."id" DESC LIMIT 1
    )
    SELECT started."id", claim."waitId" AS "claimWaitId", claim."waitDeadlineAt", claim."outcomeDeadlineAt", claim."sourceWaitKey", claim."continuationWaitKey"
    FROM "agent_events" AS started
    LEFT JOIN LATERAL (SELECT latest_wait."id" AS "waitId", latest_wait."deadlineAt" AS "waitDeadlineAt",
        latest_wait."result"->'outcome'->>'deadlineAt' AS "outcomeDeadlineAt", ${CHILD_WAIT_CLAIM_KEY_COLUMNS_SQL} FROM latest_wait WHERE ${CHILD_WAIT_CLAIM_RECOVERY_SQL}) AS claim ON TRUE
    WHERE started."sessionId" = $1 AND started."taskId" = $2 AND started."type" IN ('tool_call.started', 'model.started')
      AND NOT EXISTS (SELECT 1 FROM "agent_events" AS settled WHERE settled."sessionId" = started."sessionId" AND settled."taskId" = started."taskId"
        AND settled."correlationId" = started."correlationId" AND ((started."type" = 'tool_call.started' AND settled."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted')
          AND ${CHILD_WAIT_CALL_TERMINAL_SETTLEMENT_SQL}) OR (started."type" = 'model.started' AND settled."type" IN ('model.completed', 'model.failed'))))
      AND NOT (started."type" = 'model.started' AND $10::text IS NOT NULL AND started."actor" = 'subagent' AND started."itemId" IS NULL AND started."turnId" = $3 AND started."correlationId" = $10 AND started."idempotencyKey" = 'task:' || $2 || ':event:model-started:' || $10
        AND started."payload" = jsonb_build_object('taskId', $2, 'provider', started."payload"->>'provider', 'model', started."payload"->>'model') AND jsonb_typeof(started."payload"->'provider') = 'string' AND jsonb_typeof(started."payload"->'model') = 'string')
      AND NOT (started."type" = 'tool_call.started' AND EXISTS (
        SELECT 1 FROM "sub_agent_tasks" AS owner JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = owner."id" JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."sessionId" = wait."sessionId" AND source."turnId" = wait."turnId" AND source."taskId" = owner."id"
        JOIN "agent_items" AS call ON call."id" = started."itemId" AND call."sessionId" = source."sessionId" AND call."turnId" = source."turnId" AND call."taskId" = source."taskId" AND call."stepId" = source."id"
        WHERE owner."id" = $2 AND owner."sessionId" = $1 AND owner."turnId" = $3 AND owner."rootTaskId" = $4 AND owner."status" = 'running'
          AND owner."leaseOwner" = $5 AND owner."attemptCount" = $6 AND owner."leaseExpiresAt" = $7 AND source."attempt" = $6 AND wait."sessionId" = $1 AND wait."turnId" = $3 AND wait."userId" = $8
          AND ((wait."status" = 'waiting' AND wait."suspendedAt" IS NULL AND wait."consumedAt" IS NULL
              AND source."status" IN ('streaming', 'waiting_for_tool') AND source."ordinal" = (SELECT MAX(current."ordinal") FROM "agent_steps" AS current WHERE current."taskId" = owner."id" AND current."sessionId" = $1 AND current."turnId" = $3 AND current."attempt" = $6))
            OR (wait."status" IN ('ready', 'timed_out') AND wait."suspendedAt" IS NOT NULL
              AND source."status" IN ('waiting_for_tool', 'completed') AND EXISTS (SELECT 1 FROM "agent_steps" AS next WHERE next."sessionId" = source."sessionId" AND next."turnId" = source."turnId" AND next."taskId" = source."taskId" AND next."attempt" = source."attempt"
                AND next."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later WHERE later."sessionId" = source."sessionId"
                  AND later."turnId" = source."turnId" AND later."taskId" = source."taskId" AND later."attempt" = source."attempt" AND later."ordinal" > source."ordinal")
                AND (wait."consumedAt" IS NOT NULL OR next."status" = 'streaming')
                AND next."ordinal" = (SELECT MAX(current."ordinal") FROM "agent_steps" AS current WHERE current."taskId" = owner."id" AND current."sessionId" = $1 AND current."turnId" = $3 AND current."attempt" = $6)))
            OR (wait."status" IN ('ready', 'timed_out') AND wait."suspendedAt" IS NOT NULL AND wait."consumedAt" IS NULL AND source."status" = 'waiting_for_tool' AND source."ordinal" = (SELECT MAX(current."ordinal") FROM "agent_steps" AS current WHERE current."taskId" = owner."id" AND current."sessionId" = $1 AND current."turnId" = $3 AND current."attempt" = $6)))
          AND wait."id" = (SELECT latest."id" FROM "agent_wait_conditions" AS latest WHERE latest."parentTaskId" = owner."id" AND latest."stepId" = source."id" ORDER BY latest."createdAt" DESC, latest."id" DESC LIMIT 1)
          AND call."type" = 'tool_call' AND call."content"->>'toolName' = 'wait_subagents' AND call."content"->>'toolVersion' = '1' AND call."status" IN ('started', 'streaming', 'completed') AND call."content"->>'toolCallId' = started."correlationId" AND started."itemId" = call."id" AND started."turnId" = $3
          AND (CASE WHEN jsonb_typeof(call."content"->'input') = 'object' THEN (call."content"->'input') - 'taskIds'::text ELSE '{}'::jsonb END) = jsonb_build_object('idempotencyKey', wait."idempotencyKey", 'mode', wait."mode", 'timeoutMs', wait."result"->'request'->'timeoutMs')
          AND (SELECT jsonb_agg(target."id" ORDER BY target."id") FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(call."content"->'input'->'taskIds') = 'array' THEN call."content"->'input'->'taskIds' ELSE '[]'::jsonb END) AS target("id")) = wait."targetTaskIds"
          AND wait."result"->'request' = jsonb_build_object('targetTaskIds', wait."targetTaskIds", 'mode', wait."mode", 'timeoutMs', wait."result"->'request'->'timeoutMs')
          AND wait."result"->'outcome'->>'waitId' = wait."id" AND wait."result"->'outcome'->>'status' = wait."status"
          AND wait."result"->'outcome'->'taskIds' = wait."targetTaskIds" AND wait."result"->'outcome'->'matchedTaskIds' = wait."matchedTaskIds"
          AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) BETWEEN 1 AND 8
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) AS target("id")
            WHERE NOT EXISTS (SELECT 1 FROM "sub_agent_tasks" AS child WHERE child."id" = target."id" AND child."parentTaskId" = owner."id" AND child."rootTaskId" = $4 AND child."sessionId" = $1 AND child."turnId" = $3))))
      AND ($9::text IS NULL OR started."id" <> $9) LIMIT 2`, [task.sessionId, task.id, task.turnId, task.rootTaskId, task.leaseOwner, task.attemptCount, task.leaseExpiresAt, task.userId, ignoredEventId ?? null, continuationId ?? null])
  if (!result.rows.length) return false
  if (result.rows.length !== 1 || typeof result.rows[0]?.claimWaitId !== "string") return true
  const deadlineText = result.rows[0].outcomeDeadlineAt, waitDeadline = dateValue(result.rows[0].waitDeadlineAt), claimDeadline = typeof deadlineText === "string" ? dateValue(deadlineText) : null
  return !childWaitContinuationKeyMatchesSafeProjection(result.rows[0]?.sourceWaitKey, result.rows[0]?.continuationWaitKey)
    || !waitDeadline || !claimDeadline || !Number.isFinite(waitDeadline.getTime()) || !Number.isFinite(claimDeadline.getTime())
    || claimDeadline.toISOString() !== deadlineText || waitDeadline.getTime() !== claimDeadline.getTime()
}
