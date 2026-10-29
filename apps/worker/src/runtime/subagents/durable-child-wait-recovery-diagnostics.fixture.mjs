export async function readRecoveryStateSnapshot(pool, ids) {
  try {
    const result = await pool.query(`SELECT clock_timestamp() AS "databaseClock", session."status" AS "sessionStatus",
        turn."status" AS "turnStatus", root."status" AS "rootStatus", root."interruptRequestedAt" AS "rootInterruptRequestedAt",
        task."status" AS "taskStatus", task."attemptCount", task."maxAttempts", task."leaseOwner" IS NOT NULL AS "leaseOwnerPresent", task."leaseExpiresAt",
        task."nextAttemptAt", task."interruptRequestedAt", task."status" = 'running' AND task."leaseExpiresAt" <= clock_timestamp() AS "expiredRunning",
        task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= clock_timestamp() AS "retryDue",
        wait."id" IS NOT NULL AS "waitPresent", wait."status" AS "waitStatus", wait."deadlineAt", wait."suspendedAt", wait."resolvedAt", wait."consumedAt",
        jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) AS "waitTargetCount",
        wait."deadlineAt" IS NOT NULL AND wait."deadlineAt" <= clock_timestamp() AS "waitDeadlineDue",
        step."id" IS NOT NULL AS "stepPresent", step."status" AS "stepStatus", step."attempt" AS "stepAttempt", step."ordinal" AS "stepOrdinal",
        step."ordinal" = (SELECT MAX(latest."ordinal") FROM "agent_steps" AS latest WHERE latest."taskId" = task."id"
          AND latest."sessionId" = task."sessionId" AND latest."turnId" = task."turnId" AND latest."attempt" = task."attemptCount") AS "stepIsLatest",
        call."id" IS NOT NULL AS "callPresent", call."status" AS "callStatus", call."content"->>'toolName' AS "callName",
        call."content"->>'toolVersion' AS "callVersion",
        (SELECT COUNT(*)::int = 1 FROM "agent_events" AS started WHERE started."sessionId" = task."sessionId" AND started."taskId" = task."id"
          AND started."itemId" = call."id" AND started."turnId" = task."turnId" AND started."type" = 'tool_call.started'
          AND started."correlationId" = call."content"->>'toolCallId' AND call."status" IN ('started', 'streaming', 'completed')
          AND NOT EXISTS (SELECT 1 FROM "agent_events" AS settled WHERE settled."sessionId" = started."sessionId" AND settled."taskId" = started."taskId"
            AND settled."correlationId" = started."correlationId" AND settled."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted'))) AS "unsettledWaitCallMatches",
        COALESCE((call."content"->>'toolVersion' = '1' AND (call."content"->'input') - 'taskIds'::text = jsonb_build_object(
          'idempotencyKey', wait."idempotencyKey", 'mode', wait."mode", 'timeoutMs', wait."result"->'request'->'timeoutMs')
          AND (SELECT jsonb_agg(target."id" ORDER BY target."id") FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(call."content"->'input'->'taskIds') = 'array' THEN call."content"->'input'->'taskIds' ELSE '[]'::jsonb END
          ) AS target("id")) = wait."targetTaskIds"), FALSE) AS "waitCallRequestMatches",
        COALESCE(wait."result"->'request' = jsonb_build_object('targetTaskIds', wait."targetTaskIds", 'mode', wait."mode",
          'timeoutMs', wait."result"->'request'->'timeoutMs'), FALSE) AS "waitRequestMatches",
        COALESCE(wait."result"->'outcome'->>'waitId' = wait."id" AND wait."result"->'outcome'->>'status' = wait."status"
          AND wait."result"->'outcome'->'taskIds' = wait."targetTaskIds"
          AND wait."result"->'outcome'->'matchedTaskIds' = wait."matchedTaskIds", FALSE) AS "waitOutcomeMatches",
        wait."result" IS NOT NULL AS "waitResultPresent", jsonb_typeof(wait."result") AS "waitResultType",
        octet_length(wait."result"::text) AS "waitResultByteLength",
        COALESCE(wait."result"->>'truncated' = 'true', FALSE) AS "waitResultTruncated",
        jsonb_typeof(wait."result"->'request') AS "waitRequestType",
        (SELECT COUNT(*)::int FROM jsonb_object_keys(CASE WHEN jsonb_typeof(wait."result"->'request') = 'object'
          THEN wait."result"->'request' ELSE '{}'::jsonb END)) AS "waitRequestKeyCount",
        CASE WHEN jsonb_typeof(wait."result"->'request') = 'object' THEN (wait."result"->'request') ? 'targetTaskIds' ELSE FALSE END AS "waitRequestHasTargetTaskIds",
        CASE WHEN jsonb_typeof(wait."result"->'request') = 'object' THEN (wait."result"->'request') ? 'mode' ELSE FALSE END AS "waitRequestHasMode",
        CASE WHEN jsonb_typeof(wait."result"->'request') = 'object' THEN (wait."result"->'request') ? 'timeoutMs' ELSE FALSE END AS "waitRequestHasTimeoutMs",
        jsonb_typeof(wait."result"->'request'->'targetTaskIds') AS "waitRequestTargetTaskIdsType",
        CASE WHEN jsonb_typeof(wait."result"->'request'->'targetTaskIds') = 'array'
          THEN jsonb_array_length(wait."result"->'request'->'targetTaskIds') ELSE NULL END AS "waitRequestTargetTaskIdsCount",
        jsonb_typeof(wait."result"->'request'->'mode') AS "waitRequestModeType",
        jsonb_typeof(wait."result"->'request'->'timeoutMs') AS "waitRequestTimeoutMsType",
        COALESCE(wait."result"->'request'->'targetTaskIds' = wait."targetTaskIds", FALSE) AS "waitRequestTargetTaskIdsMatch",
        COALESCE(wait."result"->'request'->>'mode' = wait."mode", FALSE) AS "waitRequestModeMatch",
        COALESCE(wait."result"->'request'->'timeoutMs' = call."content"->'input'->'timeoutMs', FALSE) AS "waitRequestTimeoutMsMatchCall",
        jsonb_typeof(wait."result"->'outcome') AS "waitOutcomeType",
        (SELECT COUNT(*)::int FROM jsonb_object_keys(CASE WHEN jsonb_typeof(wait."result"->'outcome') = 'object'
          THEN wait."result"->'outcome' ELSE '{}'::jsonb END)) AS "waitOutcomeKeyCount",
        CASE WHEN jsonb_typeof(wait."result"->'outcome') = 'object' THEN (wait."result"->'outcome') ? 'waitId' ELSE FALSE END AS "waitOutcomeHasWaitId",
        CASE WHEN jsonb_typeof(wait."result"->'outcome') = 'object' THEN (wait."result"->'outcome') ? 'status' ELSE FALSE END AS "waitOutcomeHasStatus",
        CASE WHEN jsonb_typeof(wait."result"->'outcome') = 'object' THEN (wait."result"->'outcome') ? 'taskIds' ELSE FALSE END AS "waitOutcomeHasTaskIds",
        CASE WHEN jsonb_typeof(wait."result"->'outcome') = 'object' THEN (wait."result"->'outcome') ? 'matchedTaskIds' ELSE FALSE END AS "waitOutcomeHasMatchedTaskIds",
        jsonb_typeof(wait."result"->'outcome'->'waitId') AS "waitOutcomeWaitIdType",
        jsonb_typeof(wait."result"->'outcome'->'status') AS "waitOutcomeStatusType",
        jsonb_typeof(wait."result"->'outcome'->'taskIds') AS "waitOutcomeTaskIdsType",
        CASE WHEN jsonb_typeof(wait."result"->'outcome'->'taskIds') = 'array'
          THEN jsonb_array_length(wait."result"->'outcome'->'taskIds') ELSE NULL END AS "waitOutcomeTaskIdsCount",
        jsonb_typeof(wait."result"->'outcome'->'matchedTaskIds') AS "waitOutcomeMatchedTaskIdsType",
        CASE WHEN jsonb_typeof(wait."result"->'outcome'->'matchedTaskIds') = 'array'
          THEN jsonb_array_length(wait."result"->'outcome'->'matchedTaskIds') ELSE NULL END AS "waitOutcomeMatchedTaskIdsCount",
        COALESCE(wait."result"->'outcome'->>'waitId' = wait."id", FALSE) AS "waitOutcomeWaitIdMatch",
        COALESCE(wait."result"->'outcome'->>'status' = wait."status", FALSE) AS "waitOutcomeStatusMatch",
        COALESCE(wait."result"->'outcome'->'taskIds' = wait."targetTaskIds", FALSE) AS "waitOutcomeTaskIdsMatch",
        COALESCE(wait."result"->'outcome'->'matchedTaskIds' = wait."matchedTaskIds", FALSE) AS "waitOutcomeMatchedTaskIdsMatch",
        COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) BETWEEN 1 AND 8
          AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END)
            = (SELECT COUNT(DISTINCT target."id") FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) AS target("id") WHERE jsonb_typeof(target."id") = 'string')
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) AS target("id")
            WHERE NOT EXISTS (SELECT 1 FROM "sub_agent_tasks" AS child WHERE child."id" = target."id" AND child."id" <> task."id" AND child."parentTaskId" = task."id"
              AND child."rootTaskId" = task."rootTaskId" AND child."sessionId" = task."sessionId" AND child."turnId" = task."turnId")), FALSE) AS "waitTargetsMatchScope",
        (SELECT COUNT(*)::int FROM "agent_events" AS started WHERE started."sessionId" = task."sessionId" AND started."taskId" = task."id"
          AND started."itemId" = call."id" AND started."type" = 'tool_call.started') AS "startedEventCount",
        (SELECT COUNT(*)::int FROM "agent_events" AS settled WHERE settled."sessionId" = task."sessionId" AND settled."taskId" = task."id"
          AND settled."correlationId" = call."content"->>'toolCallId' AND settled."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted')) AS "settledEventCount",
        dispatch."attemptCount" AS "dispatchAttemptCount", dispatch."publishedAt" IS NOT NULL AS "dispatchPublished"
      FROM "agent_sessions" AS session
      LEFT JOIN "agent_turns" AS turn ON turn."id" = $2 AND turn."sessionId" = session."id"
      LEFT JOIN "sub_agent_tasks" AS task ON task."id" = $4 AND task."sessionId" = session."id"
        AND task."turnId" = turn."id" AND task."rootTaskId" = $3
      LEFT JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId"
      LEFT JOIN LATERAL (SELECT currentWait.* FROM "agent_wait_conditions" AS currentWait
        WHERE currentWait."parentTaskId" = task."id" AND currentWait."sessionId" = task."sessionId" AND currentWait."turnId" = task."turnId"
        ORDER BY currentWait."createdAt" DESC, currentWait."id" DESC LIMIT 1) AS wait ON TRUE
      LEFT JOIN "agent_steps" AS step ON step."id" = wait."stepId" AND step."sessionId" = task."sessionId"
        AND step."turnId" = task."turnId" AND step."taskId" = task."id"
      LEFT JOIN LATERAL (SELECT currentCall.* FROM "agent_items" AS currentCall
        WHERE currentCall."sessionId" = task."sessionId" AND currentCall."turnId" = task."turnId" AND currentCall."taskId" = task."id"
          AND currentCall."stepId" = step."id" AND currentCall."type" = 'tool_call' AND currentCall."content"->>'toolName' = 'wait_subagents'
        ORDER BY currentCall."id" DESC LIMIT 1) AS call ON TRUE
      LEFT JOIN LATERAL (SELECT currentDispatch."attemptCount", currentDispatch."publishedAt" FROM "agent_outbox" AS currentDispatch
        WHERE currentDispatch."topic" = 'agent.subagent.dispatch' AND currentDispatch."aggregateId" = session."id"
          AND currentDispatch."idempotencyKey" = 'subagent-dispatch:' || task."id" LIMIT 1) AS dispatch ON TRUE
      WHERE session."id" = $1`, [ids.sessionId, ids.turnId, ids.rootTaskId, ids.waiterTaskId])
    return result.rows[0] ?? { diagnostic: "fixture_state_missing" }
  } catch (error) {
    const code = typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null
    return { diagnostic: "query_failed", code }
  }
}
