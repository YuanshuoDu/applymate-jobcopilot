import type { TerminalCallProjection } from "./pg-store-expiry-historical-wait-binding.js"
import type pg from "pg"
import { dateValue } from "./pg-store-persistence.js"

export const MAX_HISTORICAL_WAIT_CLAIM_CANDIDATES = 16
export function historicalWaitProjectionsSql(envelope: string): string {
  return `CASE WHEN jsonb_typeof(${envelope}) = 'array' THEN ${envelope}
    WHEN jsonb_typeof((${envelope})->'projections') = 'array' THEN (${envelope})->'projections' ELSE '[]'::jsonb END`
}
export function historicalWaitClaimProofsSql(envelope: string): string {
  return `CASE WHEN jsonb_typeof((${envelope})->'claimCollisionProofs') = 'array'
    THEN (${envelope})->'claimCollisionProofs' ELSE '[]'::jsonb END`
}

export type HistoricalWaitClaimCollisionCandidate = Readonly<{
  callItemId: unknown
  stepId: unknown
  attempt: unknown
  claimKeyDigest: unknown
  resultItemCount: unknown
  resultItemId: unknown
  resultWaitId: unknown
}>

export const historicalWaitClaimDigestSql = (call: string) => `CASE WHEN jsonb_typeof(${call}."content"->'input') = 'object'
  AND jsonb_typeof(${call}."content"->'input'->'idempotencyKey') = 'string'
  AND char_length(${call}."content"->'input'->>'idempotencyKey') BETWEEN 1 AND 256
  AND btrim(${call}."content"->'input'->>'idempotencyKey') = ${call}."content"->'input'->>'idempotencyKey'
  THEN encode(sha256(convert_to(${call}."content"->'input'->>'idempotencyKey', 'UTF8')), 'hex') END`
export const historicalWaitSourceCallSql = (call: string) => `NOT EXISTS (SELECT 1 FROM "agent_wait_conditions" AS sourceWait
  JOIN "agent_steps" AS sourceStep ON sourceStep."id" = sourceWait."stepId" AND sourceStep."sessionId" = sourceWait."sessionId"
    AND sourceStep."turnId" = sourceWait."turnId" AND sourceStep."taskId" = sourceWait."parentTaskId"
  WHERE sourceWait."parentTaskId" = owner."id" AND sourceWait."sessionId" = owner."sessionId"
    AND sourceWait."turnId" = owner."turnId" AND sourceWait."stepId" = ${call}."stepId"
    AND sourceStep."attempt" = owner."attemptCount" AND jsonb_typeof(${call}."content"->'input') = 'object'
    AND ${call}."content"->'input' = jsonb_build_object('idempotencyKey', sourceWait."idempotencyKey",
      'taskIds', sourceWait."targetTaskIds", 'mode', sourceWait."mode", 'timeoutMs', sourceWait."result"->'request'->'timeoutMs')
    AND (SELECT COUNT(*) FROM "agent_wait_conditions" AS sameStepWait WHERE sameStepWait."parentTaskId" = owner."id"
      AND sameStepWait."sessionId" = owner."sessionId" AND sameStepWait."turnId" = owner."turnId" AND sameStepWait."stepId" = sourceStep."id") = 1
    AND (SELECT COUNT(*) FROM "agent_items" AS sameStepCall WHERE sameStepCall."sessionId" = sourceStep."sessionId"
      AND sameStepCall."turnId" = sourceStep."turnId" AND sameStepCall."taskId" = sourceStep."taskId"
      AND sameStepCall."stepId" = sourceStep."id" AND sameStepCall."type" = 'tool_call'
      AND sameStepCall."content"->>'toolName' = 'wait_subagents') = 1)`

/** Census returns only bounded row identities, a key digest, and the exact result wait id. */
/** Identifies only the canonical source item whose input matches its same-step wait receipt. */
export const historicalWaitSourceItemSql = (call: string) => `EXISTS (SELECT 1 FROM "agent_wait_conditions" AS sourceWait
  JOIN "agent_steps" AS sourceStep ON sourceStep."id" = sourceWait."stepId" AND sourceStep."sessionId" = sourceWait."sessionId"
    AND sourceStep."turnId" = sourceWait."turnId" AND sourceStep."taskId" = owner."id"
  WHERE sourceWait."parentTaskId" = owner."id" AND sourceWait."sessionId" = owner."sessionId"
    AND sourceWait."turnId" = owner."turnId" AND sourceWait."userId" = session."userId"
    AND sourceWait."stepId" = ${call}."stepId" AND sourceStep."attempt" = owner."attemptCount"
    AND ${call}."id" = 'task:' || owner."id" || ':item:tool-call:' || (${call}."content"->>'toolCallId')
      || ':attempt:' || sourceStep."attempt"::text
    AND ${call}."content"->'input' = jsonb_build_object('idempotencyKey', sourceWait."idempotencyKey",
      'taskIds', sourceWait."targetTaskIds", 'mode', sourceWait."mode", 'timeoutMs', sourceWait."result"->'request'->'timeoutMs')
    AND (SELECT COUNT(*) FROM "agent_wait_conditions" AS sameStepWait WHERE sameStepWait."parentTaskId" = owner."id"
      AND sameStepWait."sessionId" = owner."sessionId" AND sameStepWait."turnId" = owner."turnId"
      AND sameStepWait."stepId" = sourceStep."id") = 1
    AND (SELECT COUNT(*) FROM "agent_items" AS sameStepCall WHERE sameStepCall."sessionId" = sourceStep."sessionId"
      AND sameStepCall."turnId" = sourceStep."turnId" AND sameStepCall."taskId" = sourceStep."taskId"
      AND sameStepCall."stepId" = sourceStep."id" AND sameStepCall."type" = 'tool_call'
      AND sameStepCall."content"->>'toolName' = 'wait_subagents') = 1)`

export const HISTORICAL_WAIT_CLAIM_CANDIDATES_SQL = `SELECT candidate."id" AS "callItemId", candidate."stepId", step."attempt",
  ${historicalWaitClaimDigestSql("candidate")} AS "claimKeyDigest", (SELECT COUNT(*)::int FROM "agent_items" AS result
    WHERE result."sessionId" = candidate."sessionId" AND result."turnId" = candidate."turnId" AND result."taskId" = candidate."taskId"
      AND result."stepId" = candidate."stepId" AND result."type" = 'tool_result'
      AND result."content"->>'toolCallId' = candidate."content"->>'toolCallId') AS "resultItemCount",
  result."id" AS "resultItemId", CASE WHEN jsonb_typeof(result."content"->'output') = 'object'
    THEN result."content"->'output'->>'waitId' END AS "resultWaitId"
  FROM "sub_agent_tasks" AS owner
  JOIN "agent_sessions" AS session ON session."id" = owner."sessionId" AND session."userId" = $5
  JOIN "agent_turns" AS turn ON turn."id" = owner."turnId" AND turn."sessionId" = owner."sessionId"
    AND turn."userId" = session."userId" AND turn."rootTaskId" = owner."rootTaskId"
  JOIN "agent_steps" AS step ON step."sessionId" = owner."sessionId" AND step."turnId" = owner."turnId"
    AND step."taskId" = owner."id" AND step."attempt" = owner."attemptCount"
  JOIN "agent_items" AS candidate ON candidate."sessionId" = step."sessionId" AND candidate."turnId" = step."turnId"
    AND candidate."taskId" = step."taskId" AND candidate."stepId" = step."id"
  LEFT JOIN "agent_items" AS result ON result."sessionId" = candidate."sessionId" AND result."turnId" = candidate."turnId"
    AND result."taskId" = candidate."taskId" AND result."stepId" = candidate."stepId" AND result."type" = 'tool_result'
    AND result."content"->>'toolCallId' = candidate."content"->>'toolCallId'
  WHERE owner."id" = $1 AND owner."sessionId" = $2 AND owner."turnId" = $3 AND owner."rootTaskId" = $4
    AND owner."status" = 'running' AND owner."parentTaskId" IS NOT NULL AND owner."leaseOwner" = $6
    AND owner."attemptCount" = $7 AND owner."leaseExpiresAt" = $8 AND owner."interruptRequestedAt" IS NULL
    AND candidate."type" = 'tool_call' AND candidate."content"->>'toolName' = 'wait_subagents'
    AND (${historicalWaitClaimDigestSql("candidate")} IS NULL OR ${historicalWaitClaimDigestSql("candidate")} = ANY($9::text[]))
    AND ${historicalWaitSourceCallSql("candidate")} ORDER BY candidate."id" LIMIT ${MAX_HISTORICAL_WAIT_CLAIM_CANDIDATES + 1}`

function digest(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) }
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.trim() === value }
function isClaim(projection: TerminalCallProjection): boolean { return projection.sourceWait.claimKeyDigest !== null }
function sources(projections: readonly TerminalCallProjection[]): TerminalCallProjection[] {
  return projections.filter(projection => projection.sourceWait.claimKeyDigest === null)
}

export async function bindHistoricalWaitClaimCandidates(client: Pick<pg.PoolClient, "query">,
  task: Record<string, unknown>, projections: readonly TerminalCallProjection[], onReject?: () => void): Promise<TerminalCallProjection[]> {
  const claims = projections.filter(isClaim)
  if (!claims.length) return [...projections]
  const leaseExpiresAt = dateValue(task.leaseExpiresAt)
  if (typeof task.id !== "string" || typeof task.sessionId !== "string" || typeof task.turnId !== "string"
    || typeof task.rootTaskId !== "string" || typeof task.userId !== "string" || typeof task.leaseOwner !== "string"
    || typeof task.attemptCount !== "number" || !Number.isSafeInteger(task.attemptCount) || !leaseExpiresAt) {
    onReject?.(); return sources(projections)
  }
  const candidates = await client.query<HistoricalWaitClaimCollisionCandidate>(HISTORICAL_WAIT_CLAIM_CANDIDATES_SQL,
    [task.id, task.sessionId, task.turnId, task.rootTaskId, task.userId, task.leaseOwner, task.attemptCount, leaseExpiresAt,
      [...new Set(claims.map(claim => claim.sourceWait.claimKeyDigest).filter(digest))]])
  const accepted = filterHistoricalWaitClaimCollisions(candidates.rows, projections)
  if (accepted.filter(isClaim).length !== claims.length) onReject?.()
  return accepted
}

/** Retain claims only when every persisted continuation candidate has one exact wait/result proof. */
export function filterHistoricalWaitClaimCollisions(
  candidates: readonly HistoricalWaitClaimCollisionCandidate[],
  projections: readonly TerminalCallProjection[],
): TerminalCallProjection[] {
  const claims = projections.filter(isClaim)
  if (!claims.length) return [...projections]
  if (!candidates.length || candidates.length > MAX_HISTORICAL_WAIT_CLAIM_CANDIDATES || candidates.length !== claims.length) return sources(projections)

  const claimsByItem = new Map<string, TerminalCallProjection[]>()
  for (const claim of claims) {
    const byItem = claimsByItem.get(claim.callItemId) ?? []
    byItem.push(claim)
    claimsByItem.set(claim.callItemId, byItem)
  }
  const seenCalls = new Set<string>(), waitDigestCounts = new Map<string, number>()
  for (const candidate of candidates) {
    if (!nonempty(candidate.callItemId) || !nonempty(candidate.stepId) || !Number.isSafeInteger(candidate.attempt)
      || !digest(candidate.claimKeyDigest) || candidate.resultItemCount !== 1 || !nonempty(candidate.resultItemId)
      || !nonempty(candidate.resultWaitId) || seenCalls.has(candidate.callItemId)) return sources(projections)
    seenCalls.add(candidate.callItemId)
    const matches = claimsByItem.get(candidate.callItemId)
    if (matches?.length !== 1) return sources(projections)
    const claim = matches[0]!
    if (claim.stepId !== candidate.stepId || claim.attempt !== candidate.attempt
      || claim.sourceWait.claimKeyDigest !== candidate.claimKeyDigest || claim.resultItemId !== candidate.resultItemId
      || claim.sourceWait.waitId !== candidate.resultWaitId || !nonempty(claim.resultStartedEventId)
      || !nonempty(claim.resultCompletedEventId) || !nonempty(claim.stepCompletedEventId) || !claim.stepToolChain) return sources(projections)
    const waitDigest = `${candidate.claimKeyDigest}\u0000${candidate.resultWaitId}`
    waitDigestCounts.set(waitDigest, (waitDigestCounts.get(waitDigest) ?? 0) + 1)
  }
  if (claims.some(claim => !seenCalls.has(claim.callItemId))) return sources(projections)
  if ([...waitDigestCounts.values()].some(count => count !== 1)) return sources(projections)
  return [...projections]
}

/** Serialize each full peer proof once; projections carry only bounded peer item-id references. */
export function historicalWaitClaimProofBundle(projections: readonly TerminalCallProjection[]): Record<string, unknown> {
  const claims = projections.filter(isClaim)
  if (claims.length > MAX_HISTORICAL_WAIT_CLAIM_CANDIDATES) return { projections: sources(projections), claimCollisionProofs: [] }
  const proofRows = projections.map(projection => projection.sourceWait.claimKeyDigest === null ? projection : ({
    ...projection,
    claimCollisionPeerIds: claims.filter(peer => peer.callItemId !== projection.callItemId
      && peer.sourceWait.claimKeyDigest === projection.sourceWait.claimKeyDigest
      && peer.sourceWait.waitId !== projection.sourceWait.waitId).map(peer => peer.callItemId),
  }))
  const claimCollisionProofs = proofRows.filter(isClaim)
  return { projections: proofRows, claimCollisionProofs }
}

export function historicalWaitClaimProjectionEnvelope(projection: TerminalCallProjection,
  projections: readonly TerminalCallProjection[]): Record<string, unknown> {
  const bundle = historicalWaitClaimProofBundle(projections)
  const proofRows = Array.isArray(bundle.projections) ? bundle.projections as Record<string, unknown>[] : []
  const peerRefs = proofRows.find(row => row.callItemId === projection.callItemId)?.claimCollisionPeerIds
  return { projection: { ...projection, claimCollisionPeerIds: Array.isArray(peerRefs) ? peerRefs : [] },
    claimCollisionProofs: bundle.claimCollisionProofs }
}
