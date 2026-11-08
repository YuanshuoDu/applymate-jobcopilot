import { historicalWaitClaimDigestSql, historicalWaitSourceCallSql, historicalWaitSourceItemSql,
  MAX_HISTORICAL_WAIT_CLAIM_CANDIDATES } from "./pg-store-expiry-historical-wait-claim-collision.js"
import { CHILD_WAIT_STEP_TOOL_CHAIN_EXCEPTION_SQL } from "./pg-store-expiry-step-completion-proof.js"

const array = (value: string) => `CASE WHEN jsonb_typeof(${value}) = 'array' THEN ${value} ELSE '[]'::jsonb END`
const refs = array("proof.value->'claimCollisionPeerIds'")
const bundle = array('proofBundle."claimCollisionProofs"')
function projectedWaitCallCompletionPayload(call: string): string {
  const targets = `CASE WHEN jsonb_typeof(${call}."content"->'input'->'taskIds') = 'array' THEN ${call}."content"->'input'->'taskIds' ELSE '[]'::jsonb END`
  return `jsonb_build_object('itemId', ${call}."id", 'status', 'completed', 'content', jsonb_build_object(
    'toolName', 'wait_subagents', 'toolVersion', '1', 'status', 'completed', 'errorCode', NULL,
    'toolCallId', proof.value->>'projectedCallId', 'input', jsonb_build_object('idempotencyKey', '[REDACTED]',
      'taskIds', CASE WHEN jsonb_array_length(${targets}) BETWEEN 1 AND 8 THEN
        (SELECT jsonb_agg(to_jsonb('[REDACTED]'::text) ORDER BY target.ordinal)
          FROM generate_series(1, jsonb_array_length(${targets})) AS target(ordinal)) ELSE NULL END,
      'mode', ${call}."content"->'input'->'mode', 'timeoutMs', ${call}."content"->'input'->'timeoutMs')))`
}

const peerSetBinding = `AND (SELECT COUNT(*) FROM jsonb_array_elements(${refs}) AS ref(value)
    WHERE jsonb_typeof(ref.value) = 'string' AND char_length(ref.value #>> '{}') BETWEEN 1 AND 256
      AND btrim(ref.value #>> '{}') = ref.value #>> '{}') = jsonb_array_length(${refs})
  AND (SELECT COUNT(DISTINCT ref.value #>> '{}') FROM jsonb_array_elements(${refs}) AS ref(value)) = jsonb_array_length(${refs})
  AND (SELECT COUNT(*) FROM jsonb_array_elements(${bundle}) AS currentProof(value)
    WHERE currentProof.value->'sourceWait'->>'claimKeyDigest' = proof.value->'sourceWait'->>'claimKeyDigest') = jsonb_array_length(${refs}) + 1
  AND (SELECT COUNT(DISTINCT currentProof.value->>'callItemId') FROM jsonb_array_elements(${bundle}) AS currentProof(value)
    WHERE currentProof.value->'sourceWait'->>'claimKeyDigest' = proof.value->'sourceWait'->>'claimKeyDigest') = jsonb_array_length(${refs}) + 1
  AND (SELECT COUNT(*) FROM jsonb_array_elements(${bundle}) AS currentProof(value)
    WHERE currentProof.value = proof.value) = 1
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${bundle}) AS extraProof(value)
    WHERE extraProof.value->'sourceWait'->>'claimKeyDigest' = proof.value->'sourceWait'->>'claimKeyDigest'
      AND extraProof.value->>'callItemId' <> callItem."id"
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${refs}) AS ref(value)
        WHERE ref.value #>> '{}' = extraProof.value->>'callItemId'))`

function candidateCensusCount(): string {
  const candidateDigest = historicalWaitClaimDigestSql("claimCandidate")
  return `(SELECT COUNT(*) = jsonb_array_length(${refs}) + 1 AND COUNT(*) <= ${MAX_HISTORICAL_WAIT_CLAIM_CANDIDATES}
    FROM (SELECT claimCandidate."id" FROM "agent_items" AS claimCandidate
    JOIN "agent_steps" AS candidateStep ON candidateStep."id" = claimCandidate."stepId"
      AND candidateStep."sessionId" = claimCandidate."sessionId" AND candidateStep."turnId" = claimCandidate."turnId"
      AND candidateStep."taskId" = claimCandidate."taskId"
    WHERE claimCandidate."sessionId" = owner."sessionId" AND claimCandidate."turnId" = owner."turnId"
      AND claimCandidate."taskId" = owner."id" AND candidateStep."attempt" = owner."attemptCount"
      AND claimCandidate."type" = 'tool_call' AND claimCandidate."content"->>'toolName' = 'wait_subagents'
      AND (${candidateDigest} IS NULL OR ${candidateDigest} = proof.value->'sourceWait'->>'claimKeyDigest')
      AND ${historicalWaitSourceCallSql("claimCandidate")} ORDER BY claimCandidate."id" LIMIT ${MAX_HISTORICAL_WAIT_CLAIM_CANDIDATES + 1}) AS census)`
}

/** Counts every current-attempt claim result for this exact wait, regardless of key digest. */
export function historicalWaitExactClaimCountSql(): string {
  return `(SELECT COUNT(*) = 1 AND COUNT(DISTINCT sameWaitClaim."id") = 1
    AND MIN(sameWaitClaim."id") = callItem."id"
    FROM "agent_items" AS sameWaitClaim
    JOIN "agent_steps" AS sameWaitStep ON sameWaitStep."id" = sameWaitClaim."stepId"
      AND sameWaitStep."sessionId" = sameWaitClaim."sessionId" AND sameWaitStep."turnId" = sameWaitClaim."turnId"
      AND sameWaitStep."taskId" = sameWaitClaim."taskId"
    JOIN "agent_items" AS sameWaitResult ON sameWaitResult."sessionId" = sameWaitClaim."sessionId"
      AND sameWaitResult."turnId" = sameWaitClaim."turnId" AND sameWaitResult."taskId" = sameWaitClaim."taskId"
      AND sameWaitResult."stepId" = sameWaitStep."id" AND sameWaitResult."type" = 'tool_result'
      AND sameWaitResult."content"->>'toolCallId' = sameWaitClaim."content"->>'toolCallId'
    WHERE sameWaitClaim."sessionId" = owner."sessionId" AND sameWaitClaim."turnId" = owner."turnId"
      AND sameWaitClaim."taskId" = owner."id" AND sameWaitStep."attempt" = owner."attemptCount"
      AND sameWaitClaim."id" <> boundSourceCall."id" AND sameWaitClaim."type" = 'tool_call'
      AND sameWaitClaim."content"->>'toolName' = 'wait_subagents'
      AND sameWaitResult."content"->'output'->>'waitId' = boundWait."id")`
}

function claimResultBinding(wait: string): string {
  return `EXISTS (SELECT 1 FROM "agent_items" AS claimResult
    JOIN "agent_items" AS sourceResult ON sourceResult."id" = proof.value->'sourceWait'->>'sourceResultItemId'
      AND sourceResult."sessionId" = owner."sessionId" AND sourceResult."turnId" = owner."turnId"
      AND sourceResult."taskId" = owner."id" AND sourceResult."type" = 'tool_result'
      AND sourceResult."status" = 'completed' AND sourceResult."revision" = 1 AND sourceResult."phase" IS NULL
    JOIN "agent_events" AS callCompleted ON callCompleted."sessionId" = owner."sessionId"
      AND callCompleted."turnId" = owner."turnId" AND callCompleted."taskId" = owner."id"
      AND callCompleted."itemId" = callItem."id" AND callCompleted."type" = 'item.completed'
      AND callCompleted."actor" = 'subagent' AND callCompleted."correlationId" = callItem."id"
      AND callCompleted."causationId" = started."id" AND callCompleted."idempotencyKey" = 'task:' || owner."id"
        || ':event:tool-call-completed:' || (callItem."content"->>'toolCallId') || ':' || callItem."id" || ':1'
      AND callCompleted."sequence" > started."sequence"
      AND callCompleted."payload" = ${projectedWaitCallCompletionPayload("callItem")}
    JOIN "agent_events" AS claimTerminal ON claimTerminal."sessionId" = owner."sessionId"
      AND claimTerminal."turnId" = owner."turnId" AND claimTerminal."taskId" = owner."id"
      AND claimTerminal."itemId" = callItem."id" AND claimTerminal."type" = 'tool_call.completed'
      AND claimTerminal."actor" = 'subagent' AND claimTerminal."correlationId" = callItem."content"->>'toolCallId'
      AND claimTerminal."causationId" = callCompleted."id" AND callCompleted."sequence" < claimTerminal."sequence"
      AND claimTerminal."idempotencyKey" = 'task:' || owner."id" || ':event:tool-finished:' || (callItem."content"->>'toolCallId')
      AND claimTerminal."payload" = jsonb_build_object('toolCallId', callItem."content"->>'toolCallId',
        'toolName', 'wait_subagents', 'status', 'completed', 'errorCode', NULL, 'taskId', owner."id")
    JOIN "agent_events" AS resultStarted ON resultStarted."id" = proof.value->>'resultStartedEventId'
      AND resultStarted."sessionId" = owner."sessionId" AND resultStarted."turnId" = owner."turnId"
      AND resultStarted."taskId" = owner."id" AND resultStarted."type" = 'item.started'
      AND resultStarted."actor" = 'subagent' AND resultStarted."itemId" = claimResult."id"
      AND resultStarted."correlationId" = callStep."id" AND resultStarted."causationId" = claimTerminal."id"
      AND resultStarted."idempotencyKey" = 'task:' || owner."id" || ':event:item-started:' || claimResult."id"
      AND resultStarted."payload" = jsonb_build_object('itemId', claimResult."id", 'type', 'tool_result', 'phase', NULL)
    JOIN "agent_events" AS resultCompleted ON resultCompleted."id" = proof.value->>'resultCompletedEventId'
      AND resultCompleted."sessionId" = owner."sessionId" AND resultCompleted."turnId" = owner."turnId"
      AND resultCompleted."taskId" = owner."id" AND resultCompleted."type" = 'item.completed'
      AND resultCompleted."actor" = 'subagent' AND resultCompleted."itemId" = claimResult."id"
      AND resultCompleted."correlationId" = claimResult."id" AND resultCompleted."causationId" = resultStarted."id"
      AND resultCompleted."idempotencyKey" = 'task:' || owner."id" || ':event:tool-result-completed:'
        || (callItem."content"->>'toolCallId') || ':' || claimResult."id" || ':1'
      AND resultCompleted."payload" = jsonb_build_object('itemId', claimResult."id", 'status', 'completed', 'content', claimResult."content")
    WHERE claimResult."id" = proof.value->>'resultItemId' AND claimResult."sessionId" = owner."sessionId"
      AND claimResult."turnId" = owner."turnId" AND claimResult."taskId" = owner."id"
      AND claimResult."stepId" = callStep."id" AND claimResult."type" = 'tool_result'
      AND claimResult."status" = 'completed' AND claimResult."revision" = 1 AND claimResult."phase" IS NULL
      AND claimResult."id" = 'task:' || owner."id" || ':item:tool-result:' || (callItem."content"->>'toolCallId')
        || ':attempt:' || callStep."attempt"::text
      AND (SELECT COUNT(*) FROM "agent_items" AS duplicateResult WHERE duplicateResult."sessionId" = owner."sessionId"
        AND duplicateResult."turnId" = owner."turnId" AND duplicateResult."taskId" = owner."id"
        AND duplicateResult."stepId" = callStep."id" AND duplicateResult."type" = 'tool_result'
        AND duplicateResult."content"->>'toolCallId' = callItem."content"->>'toolCallId') = 1
      AND CASE WHEN jsonb_typeof(claimResult."content") = 'object' THEN
        (SELECT COUNT(*) FROM jsonb_object_keys(claimResult."content")) = 3
          AND claimResult."content" ?& ARRAY['toolCallId', 'output', 'errorCode'] ELSE FALSE END
      AND claimResult."content"->>'toolCallId' = callItem."content"->>'toolCallId'
      AND claimResult."content"->'errorCode' = 'null'::jsonb
      AND CASE WHEN jsonb_typeof(claimResult."content"->'output') = 'object' THEN
        (SELECT COUNT(*) FROM jsonb_object_keys(claimResult."content"->'output')) = 6
          AND claimResult."content"->'output' ?& ARRAY['waitId', 'status', 'taskIds', 'deadlineAt', 'matchedTaskIds', 'tasks'] ELSE FALSE END
      AND claimResult."content"->'output' = sourceResult."content"->'output'
      AND claimResult."content"->'output'->>'waitId' = ${wait}."id"
      AND claimResult."content"->'output'->>'status' = ${wait}."status"
      AND claimResult."content"->'output'->>'deadlineAt' = proof.value->'sourceWait'->>'deadlineAt'
      AND (SELECT COUNT(*) FROM "agent_events" AS duplicateClaimTerminal WHERE duplicateClaimTerminal."sessionId" = owner."sessionId"
        AND duplicateClaimTerminal."turnId" = owner."turnId" AND duplicateClaimTerminal."taskId" = owner."id"
        AND duplicateClaimTerminal."idempotencyKey" = 'task:' || owner."id" || ':event:tool-finished:'
          || (callItem."content"->>'toolCallId')) = 1
      AND (SELECT COUNT(*) FROM "agent_events" AS duplicateResultStart WHERE duplicateResultStart."sessionId" = owner."sessionId"
        AND duplicateResultStart."turnId" = owner."turnId" AND duplicateResultStart."taskId" = owner."id"
        AND duplicateResultStart."idempotencyKey" = 'task:' || owner."id" || ':event:item-started:' || claimResult."id") = 1
      AND (SELECT COUNT(*) FROM "agent_events" AS duplicateResultDone WHERE duplicateResultDone."sessionId" = owner."sessionId"
        AND duplicateResultDone."turnId" = owner."turnId" AND duplicateResultDone."taskId" = owner."id"
        AND duplicateResultDone."idempotencyKey" = 'task:' || owner."id" || ':event:tool-result-completed:'
          || (callItem."content"->>'toolCallId') || ':' || claimResult."id" || ':1') = 1
      AND proof.value->>'stepCompletedEventId' = proof.value->'stepToolChain'->>'stepCompletedEventId'
      AND EXISTS (SELECT 1 FROM "agent_events" AS resultExtra WHERE resultExtra."id" = proof.value->'stepToolChain'->>'nextEventId'
        AND resultExtra."sessionId" = owner."sessionId" AND resultExtra."turnId" = owner."turnId"
        AND resultExtra."taskId" = owner."id" AND ${CHILD_WAIT_STEP_TOOL_CHAIN_EXCEPTION_SQL}))`
}

function claimCandidateProof(coreSql: string, candidateId: string, collisionPeer: boolean): string {
  const refJoin = collisionPeer ? `JOIN jsonb_array_elements(${refs}) AS ref(value)
    ON ref.value #>> '{}' = peer.value->>'callItemId'` : ""
  const digestBinding = collisionPeer
    ? `peer.value->'sourceWait'->>'claimKeyDigest' = proofCurrent.value->'sourceWait'->>'claimKeyDigest'
      AND ${historicalWaitClaimDigestSql("callItem")} = proofCurrent.value->'sourceWait'->>'claimKeyDigest'`
    : `peer.value->'sourceWait'->'claimKeyDigest' <> 'null'::jsonb
      AND ${historicalWaitClaimDigestSql("callItem")} = peer.value->'sourceWait'->>'claimKeyDigest'`
  return `(SELECT COUNT(*) = 1 FROM jsonb_array_elements(${bundle}) AS peer(value)
    ${refJoin}
    JOIN "agent_wait_conditions" AS peerWait ON peerWait."id" = peer.value->'sourceWait'->>'waitId'
      AND peerWait."parentTaskId" = owner."id" AND peerWait."sessionId" = owner."sessionId"
      AND peerWait."turnId" = owner."turnId" AND peerWait."userId" = session."userId"
    JOIN "agent_steps" AS callStep ON callStep."id" = peer.value->>'stepId'
      AND callStep."sessionId" = peerWait."sessionId" AND callStep."turnId" = peerWait."turnId" AND callStep."taskId" = owner."id"
    JOIN "agent_items" AS callItem ON callItem."id" = peer.value->>'callItemId'
      AND callItem."sessionId" = callStep."sessionId" AND callItem."turnId" = callStep."turnId"
      AND callItem."taskId" = callStep."taskId" AND callItem."stepId" = callStep."id" AND callItem."type" = 'tool_call'
    JOIN "agent_events" AS itemStarted ON itemStarted."sessionId" = owner."sessionId" AND itemStarted."turnId" = owner."turnId"
      AND itemStarted."taskId" = owner."id" AND itemStarted."itemId" = callItem."id" AND itemStarted."type" = 'item.started'
      AND itemStarted."actor" = 'subagent' AND itemStarted."correlationId" = callStep."id"
      AND itemStarted."idempotencyKey" = 'task:' || owner."id" || ':event:item-started:' || callItem."id"
      AND itemStarted."payload" = jsonb_build_object('itemId', callItem."id", 'type', 'tool_call', 'phase', NULL)
    JOIN "agent_events" AS started ON started."id" = peer.value->>'startEventId'
      AND started."sessionId" = owner."sessionId" AND started."turnId" = owner."turnId" AND started."taskId" = owner."id"
      AND started."itemId" = callItem."id" AND started."type" = 'tool_call.started' AND started."actor" = 'subagent'
      AND started."correlationId" = callItem."content"->>'toolCallId' AND started."causationId" = itemStarted."id"
      AND started."sequence" > itemStarted."sequence"
      AND started."idempotencyKey" = 'task:' || owner."id" || ':event:child-wait-claim:' || callStep."attempt"::text || ':' || callStep."id"
      AND started."payload" = jsonb_build_object('toolCallId', callItem."content"->>'toolCallId',
        'toolName', 'wait_subagents', 'taskId', owner."id")
    CROSS JOIN LATERAL (SELECT peer.value AS value) AS proof
    WHERE peer.value->>'callItemId' = ${candidateId} AND peer.value->>'rawCallId' = callItem."content"->>'toolCallId'
      AND peer.value->>'stepId' = callStep."id" AND peer.value->>'attempt' = callStep."attempt"::text
      AND peerWait."id" <> boundWait."id" AND ${digestBinding}
      AND (SELECT COUNT(*) FROM jsonb_array_elements(${bundle}) AS duplicate(value)
        WHERE duplicate.value->>'callItemId' = peer.value->>'callItemId') = 1
      AND ${coreSql} AND ${claimResultBinding("peerWait")})`
}

function attemptWaitCallsBoundedProof(coreSql: string): string {
  return `(SELECT COUNT(*) <= ${MAX_HISTORICAL_WAIT_CLAIM_CANDIDATES}
      AND COUNT(*) FILTER (WHERE boundedCall."id" <> callItem."id"
        AND NOT ${claimCandidateProof(coreSql, 'boundedCall."id"', false)}) = 0
    FROM (SELECT candidate."id" FROM "agent_items" AS candidate
      JOIN "agent_steps" AS candidateStep ON candidateStep."id" = candidate."stepId"
        AND candidateStep."sessionId" = candidate."sessionId" AND candidateStep."turnId" = candidate."turnId"
        AND candidateStep."taskId" = candidate."taskId"
      WHERE candidate."sessionId" = owner."sessionId" AND candidate."turnId" = owner."turnId"
        AND candidate."taskId" = owner."id" AND candidateStep."attempt" = owner."attemptCount"
        AND candidate."type" = 'tool_call' AND candidate."content"->>'toolName' = 'wait_subagents'
        AND NOT ${historicalWaitSourceItemSql("candidate")}
      ORDER BY candidate."id" LIMIT ${MAX_HISTORICAL_WAIT_CLAIM_CANDIDATES + 1}) AS boundedCall)`
}

function peerProof(coreSql: string): string {
  return claimCandidateProof(coreSql, 'claimCandidate."id"', true)
}

/** Adds bounded same-digest candidate proof to the core; peer proofs reuse core SQL only, never this wrapper. */
export function historicalWaitClaimCollisionBindingSql(coreSql: string): string {
  return `CASE WHEN proof.value->'sourceWait'->'claimKeyDigest' = 'null'::jsonb THEN TRUE
    WHEN jsonb_typeof(proof.value->'claimCollisionPeerIds') IS DISTINCT FROM 'array'
      OR jsonb_typeof(proofBundle."claimCollisionProofs") IS DISTINCT FROM 'array'
      OR jsonb_array_length(${refs}) > ${MAX_HISTORICAL_WAIT_CLAIM_CANDIDATES - 1}
      OR jsonb_array_length(${bundle}) > ${MAX_HISTORICAL_WAIT_CLAIM_CANDIDATES} THEN FALSE
    ELSE ${claimResultBinding("boundWait")}
      ${peerSetBinding}
      AND ${candidateCensusCount()}
      AND ${historicalWaitExactClaimCountSql()}
      AND ${attemptWaitCallsBoundedProof(coreSql)}
      AND NOT EXISTS (SELECT 1 FROM "agent_items" AS claimCandidate
        JOIN "agent_steps" AS candidateStep ON candidateStep."id" = claimCandidate."stepId"
          AND candidateStep."sessionId" = claimCandidate."sessionId" AND candidateStep."turnId" = claimCandidate."turnId"
          AND candidateStep."taskId" = claimCandidate."taskId"
        CROSS JOIN LATERAL (SELECT proof.value AS value) AS proofCurrent
        WHERE claimCandidate."sessionId" = owner."sessionId" AND claimCandidate."turnId" = owner."turnId"
          AND claimCandidate."taskId" = owner."id" AND candidateStep."attempt" = owner."attemptCount"
          AND claimCandidate."type" = 'tool_call' AND claimCandidate."content"->>'toolName' = 'wait_subagents'
          AND (${historicalWaitClaimDigestSql("claimCandidate")} IS NULL
            OR ${historicalWaitClaimDigestSql("claimCandidate")} = proof.value->'sourceWait'->>'claimKeyDigest')
          AND claimCandidate."id" <> callItem."id" AND ${historicalWaitSourceCallSql("claimCandidate")}
          AND CASE WHEN ${historicalWaitClaimDigestSql("claimCandidate")} IS NULL THEN TRUE ELSE NOT ${peerProof(coreSql)} END )
  END`
}
