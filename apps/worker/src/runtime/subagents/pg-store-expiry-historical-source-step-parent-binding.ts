/** Binds the first projected step event to the canonical scoped event that caused its start. */
export function historicalSourceStepEventChainBinding(path: string): string {
  const events = `(CASE WHEN jsonb_typeof(${path}->'events') = 'array' THEN ${path}->'events' ELSE '[]'::jsonb END)`
  return `(SELECT COUNT(*) FROM (
    SELECT expected.value, expected.ordinality, actual."type" AS "actualType", actual."payload" AS "actualPayload",
      actual."sequence" AS "actualSequence", LAG(expected.value->>'id') OVER (ORDER BY expected.ordinality) AS "previousId",
      LAG(CASE WHEN expected.value->>'sequence' ~ '^[1-9][0-9]{0,18}$' THEN (expected.value->>'sequence')::numeric END)
        OVER (ORDER BY expected.ordinality) AS "previousSequence"
    FROM jsonb_array_elements(${events}) WITH ORDINALITY AS expected(value, ordinality)
    JOIN "agent_events" AS actual ON actual."id" = expected.value->>'id'
      AND actual."sessionId" = boundSource."sessionId" AND actual."turnId" = boundSource."turnId" AND actual."taskId" = boundSource."taskId"
      AND actual."type" = expected.value->>'type' AND actual."sequence"::text = expected.value->>'sequence'
      AND actual."causationId" IS NOT DISTINCT FROM expected.value->>'causationId'
  ) AS chain
  WHERE CASE WHEN chain.ordinality = 1 THEN
    chain."actualType" = 'step.started' AND chain.value->>'actor' = 'subagent' AND chain.value->'itemId' = 'null'::jsonb
    AND chain.value->>'correlationId' = boundSource."id"
    AND chain.value->>'idempotencyKey' = 'task:' || boundSource."taskId" || ':event:step-started:' || boundSource."id"
    AND chain."actualPayload" = jsonb_build_object('stepId', boundSource."id", 'ordinal', boundSource."ordinal", 'taskId', boundSource."taskId")
    AND EXISTS (SELECT 1 FROM "agent_events" AS parent WHERE parent."id" = chain.value->>'causationId'
      AND parent."sessionId" = boundSource."sessionId" AND parent."turnId" = boundSource."turnId" AND parent."taskId" = boundSource."taskId"
      AND parent."sequence" < chain."actualSequence" AND parent."actor" = 'subagent' AND parent."itemId" IS NULL
      AND ((parent."type" = 'task.started' AND parent."correlationId" = boundSource."turnId" AND parent."causationId" IS NULL
        AND parent."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:turn-started'
        AND parent."payload" = jsonb_build_object('goal', parent."payload"->>'goal', 'taskId', boundSource."taskId", 'rootTaskId', owner."rootTaskId"))
        OR EXISTS (SELECT 1 FROM "agent_steps" AS priorStep WHERE priorStep."id" = parent."correlationId"
          AND priorStep."sessionId" = boundSource."sessionId" AND priorStep."turnId" = boundSource."turnId" AND priorStep."taskId" = boundSource."taskId"
          AND priorStep."attempt" = boundSource."attempt" AND priorStep."ordinal" = (SELECT MAX(candidate."ordinal") FROM "agent_steps" AS candidate
            WHERE candidate."sessionId" = boundSource."sessionId" AND candidate."turnId" = boundSource."turnId" AND candidate."taskId" = boundSource."taskId"
              AND candidate."attempt" = boundSource."attempt" AND candidate."ordinal" < boundSource."ordinal")
          AND parent."type" = 'step.completed' AND parent."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:' ||
            CASE parent."payload"->>'status' WHEN 'failed' THEN 'step-failed:' WHEN 'interrupted' THEN 'step-interrupted:' ELSE 'step-completed:' END || priorStep."id"
          AND parent."payload" ?& ARRAY['stepId','status','taskId']
          AND parent."payload" - ARRAY['stepId','status','taskId','toolCallCount','errorCode','waitId'] = '{}'::jsonb
          AND parent."payload"->>'stepId' = priorStep."id" AND parent."payload"->>'taskId' = boundSource."taskId"
          AND CASE parent."payload"->>'status' WHEN 'completed' THEN priorStep."status" = 'completed'
            WHEN 'waiting_for_dependency' THEN priorStep."status" = 'waiting_for_tool'
            WHEN 'waiting_for_approval' THEN priorStep."status" = 'waiting_for_approval'
            WHEN 'waiting_for_user' THEN priorStep."status" = 'waiting_for_user'
            WHEN 'failed' THEN priorStep."status" = 'failed' WHEN 'interrupted' THEN priorStep."status" = 'interrupted' ELSE FALSE END
          AND (NOT (parent."payload" ? 'toolCallCount') OR (jsonb_typeof(parent."payload"->'toolCallCount') = 'number'
            AND parent."payload"->>'toolCallCount' ~ '^(0|[1-9][0-9]*)$'))
          AND (NOT (parent."payload" ? 'errorCode') OR jsonb_typeof(parent."payload"->'errorCode') = 'string')
          AND (NOT (parent."payload" ? 'waitId') OR jsonb_typeof(parent."payload"->'waitId') = 'string'))))
  ELSE chain.value->>'causationId' = chain."previousId" AND CASE WHEN chain.value->>'sequence' ~ '^[1-9][0-9]{0,18}$'
    THEN (chain.value->>'sequence')::numeric > chain."previousSequence" ELSE FALSE END END
  ) = jsonb_array_length(${events})`
}
