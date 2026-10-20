import { createHmac, randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type pg from "pg"
import { hashAgentReceiptValue } from "@jobcopilot/shared"
import { hashApprovalNonce, hashApprovalScope } from "@jobcopilot/agent-protocol"
import type { LeasePool, TurnJobPayload } from "./lease.js"
import { OPEN_SESSION, RUNNABLE_SESSION } from "../session-gate.js"
import {
  payloadJson,
  TURN_DISPATCH_LINEAGE_ERROR,
  TURN_DISPATCH_MAX_BATCH,
  TURN_DISPATCH_TOPIC,
  turnDispatchKey,
  withTransaction,
  type ReclaimedTurn,
} from "./recovery-scanner-common.js"
/** Reclaims stale in-progress rows and exact scheduled Gate waits. */
export async function reclaimExpiredTurns(pool: LeasePool, now: Date, limit: number): Promise<ReclaimedTurn[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Recovery limit must be positive")
  return withTransaction(pool, async (client) => {
    const result = await client.query<{ id: string; sessionId: string; leaseVersion: number }>(
      `WITH stale AS (
         SELECT turn."id"
         FROM "agent_turns" AS turn
         JOIN "agent_sessions" AS session
           ON session."id" = turn."sessionId"
          AND ${RUNNABLE_SESSION}
         WHERE turn."status" = 'in_progress'
           AND (turn."leaseExpiresAt" IS NULL OR turn."leaseExpiresAt" <= $1)
           AND (turn."source" <> 'automation' OR turn."executionMode" = 'canonical_task_graph')
         ORDER BY turn."updatedAt" ASC, turn."id" ASC
         LIMIT $2 FOR UPDATE OF turn, session SKIP LOCKED
       )
       UPDATE "agent_turns" AS turn
       SET "status" = 'queued', "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL,
           "leaseStartedAt" = NULL, "leaseVersion" = "leaseVersion" + 1,
           "revision" = "revision" + 1, "completedAt" = NULL, "updatedAt" = $1
       FROM stale
       WHERE turn."id" = stale."id"
         AND (turn."source" <> 'automation' OR turn."executionMode" = 'canonical_task_graph')
         AND EXISTS (
           SELECT 1 FROM "agent_sessions" AS session
           WHERE session."id" = turn."sessionId"
             AND ${RUNNABLE_SESSION}
         )
       RETURNING turn."id", turn."sessionId", turn."leaseVersion"`,
      [now, limit],
    )
    const reclaimed = result.rows.map((row) => ({ turnId: row.id, sessionId: row.sessionId, previousLeaseVersion: row.leaseVersion - 1 }))
    return [...reclaimed, ...await reclaimExpiredScheduledGateTurns(client, now, limit - reclaimed.length)]
  })
}
type GateRecoveryRow = {
  turnId: string; sessionId: string; userId: string; rootTaskId: string; rootAttemptCount: number; turnLeaseOwnerId: string; turnLeaseVersion: number; executionId: string; executionAttemptCount: number
  approvalId: string | null; approvalUserId: string | null; approvalSessionId: string | null; approvalTurnId: string | null; approvalJobId: string | null; approvalAction: string | null; approvalStatus: string | null; approvalToolCallId: string | null; approvalTitle: string | null; approvalBody: string | null; approvalImpact: unknown; approvalPayloadJobId: string | null
  resourceHash: string | null; materialHash: string | null; answersHash: string | null; scopeHash: string | null; nonceHash: string | null; approvalRevision: number | null; approvalExpiresAt: Date | null; approvalExpiresAtUtc: string | null; decidedAt: Date | null; consumedAt: Date | null
  waitItemId: string | null; waitSessionId: string | null; waitTurnId: string | null; waitType: string | null; waitStatus: string | null; waitRevision: number | null; waitStartedAt: Date | null; waitContent: unknown; waitCompletedAt: Date | null
}
async function reclaimExpiredScheduledGateTurns(client: Pick<pg.PoolClient, "query">, now: Date, limit: number): Promise<ReclaimedTurn[]> {
  if (limit < 1) return []
  const result = await client.query<GateRecoveryRow>(
    `WITH stale AS (
       SELECT turn."id" AS "turnId", turn."sessionId", turn."userId", turn."rootTaskId", turn."leaseOwnerId" AS "turnLeaseOwnerId", turn."leaseVersion" AS "turnLeaseVersion",
              root."attemptCount" AS "rootAttemptCount", execution."id" AS "executionId", execution."attemptCount" AS "executionAttemptCount"
       FROM "agent_sessions" AS session
       JOIN "agent_turns" AS turn ON turn."sessionId" = session."id" AND turn."userId" = session."userId"
       JOIN "agent_executions" AS execution ON execution."sessionId" = session."id" AND execution."userId" = session."userId"
       JOIN "sub_agent_tasks" AS root ON root."id" = turn."rootTaskId" AND root."sessionId" = turn."sessionId"
       JOIN LATERAL (SELECT execution."state"->'scheduledTaskGraphClaim' AS claim, execution."state"->'scheduledTaskGraphContinuation' AS continuation) AS markers ON TRUE
       WHERE ${RUNNABLE_SESSION}
         AND turn."status" = 'waiting_for_approval' AND turn."leaseExpiresAt" <= $1
         AND length(btrim(turn."leaseOwnerId")) BETWEEN 1 AND 256 AND btrim(turn."leaseOwnerId") = turn."leaseOwnerId" AND turn."leaseVersion" > 0 AND turn."source" = 'automation'
         AND turn."executionMode" = 'canonical_task_graph' AND turn."input"->>'automationRunMode' = 'scheduled'
          AND root."turnId" = turn."id" AND root."rootTaskId" = root."id" AND root."parentTaskId" IS NULL AND root."role" = 'orchestrator' AND root."taskType" = 'root' AND root."status" = 'running'
          AND root."attemptCount" > 0 AND root."interruptRequestedAt" IS NULL AND root."closedAt" IS NULL
          AND execution."status" = 'running' AND execution."checkpoint" = 'gate' AND execution."state"->>'nextStage' = 'gate'
          AND NOT (execution."state" ? 'scheduledTaskGraphWait')
          AND CASE WHEN jsonb_typeof(markers.claim) = 'object' THEN (SELECT count(*) FROM jsonb_object_keys(markers.claim)) = 6 ELSE FALSE END AND markers.claim->>'schemaVersion' = 'agent-harness.v2.scheduled-pipeline-claim.v1'
         AND jsonb_typeof(markers.claim->'key') = 'string' AND length(markers.claim->>'key') BETWEEN 1 AND 256 AND btrim(markers.claim->>'key') = markers.claim->>'key'
         AND markers.claim->>'key' = markers.continuation->>'key' AND jsonb_typeof(markers.claim->'claimToken') = 'string'
         AND length(markers.claim->>'claimToken') BETWEEN 1 AND 256 AND btrim(markers.claim->>'claimToken') = markers.claim->>'claimToken'
          AND jsonb_typeof(markers.claim->'claimedAt') = 'string' AND markers.claim->>'claimedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
          AND jsonb_typeof(markers.claim->'leaseExpiresAt') = 'string' AND markers.claim->>'leaseExpiresAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
          AND CASE WHEN jsonb_typeof(markers.claim->'owner') = 'object' THEN (SELECT count(*) FROM jsonb_object_keys(markers.claim->'owner')) = 9 ELSE FALSE END AND CASE WHEN jsonb_typeof(markers.continuation) = 'object' THEN (SELECT count(*) FROM jsonb_object_keys(markers.continuation)) = 6 ELSE FALSE END
          AND markers.continuation->>'schemaVersion' = 'agent-harness.v2.scheduled-pipeline-continuation.v1'
         AND jsonb_typeof(markers.continuation->'key') = 'string' AND length(markers.continuation->>'key') BETWEEN 1 AND 256 AND btrim(markers.continuation->>'key') = markers.continuation->>'key'
         AND CASE WHEN jsonb_typeof(markers.continuation->'owner') = 'object' THEN (SELECT count(*) FROM jsonb_object_keys(markers.continuation->'owner')) = 9 ELSE FALSE END
         AND markers.claim->'owner' = markers.continuation->'owner'
         AND markers.claim->'owner'->'userId' = to_jsonb(turn."userId") AND markers.claim->'owner'->'sessionId' = to_jsonb(turn."sessionId")
         AND markers.claim->'owner'->'turnId' = to_jsonb(turn."id") AND markers.claim->'owner'->'rootTaskId' = to_jsonb(root."id")
         AND markers.claim->'owner'->'turnLeaseOwnerId' = to_jsonb(turn."leaseOwnerId")
         AND markers.claim->'owner'->'turnLeaseVersion' = to_jsonb(turn."leaseVersion")
         AND markers.claim->'owner'->'rootAttemptCount' = to_jsonb(root."attemptCount")
         AND markers.claim->'owner'->'executionId' = to_jsonb(execution."id") AND markers.claim->'owner'->'executionAttemptCount' = to_jsonb(execution."attemptCount")
          AND markers.continuation->>'snapshotDigest' ~ '^sha256:[a-f0-9]{64}$' AND CASE WHEN jsonb_typeof(markers.continuation->'graphRevision') = 'number' AND markers.continuation->>'graphRevision' ~ '^[1-9][0-9]*$' THEN (markers.continuation->>'graphRevision')::numeric <= 9007199254740991 ELSE FALSE END
         AND markers.continuation->>'evidenceDigest' ~ '^[a-f0-9]{64}$'
       ORDER BY turn."updatedAt" ASC, turn."id" ASC
       LIMIT $2 FOR UPDATE OF session, turn, execution, root SKIP LOCKED
     )
      SELECT stale.*, approval."id" AS "approvalId", approval."userId" AS "approvalUserId", approval."sessionId" AS "approvalSessionId", approval."turnId" AS "approvalTurnId",
            approval."jobId" AS "approvalJobId", approval."type" AS "approvalAction", approval."status" AS "approvalStatus", approval."toolCallId" AS "approvalToolCallId",
            approval."title" AS "approvalTitle", approval."body" AS "approvalBody", approval."impact" AS "approvalImpact", approval."payload"->>'jobId' AS "approvalPayloadJobId",
            approval."resourceHash", approval."materialHash", approval."answersHash", approval."scopeHash", approval."nonceHash", approval."revision" AS "approvalRevision",
             approval."expiresAt" AS "approvalExpiresAt", to_char(approval."expiresAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "approvalExpiresAtUtc",
             approval."decidedAt", approval."consumedAt", item."id" AS "waitItemId", item."sessionId" AS "waitSessionId",
            item."turnId" AS "waitTurnId", item."type" AS "waitType", item."status" AS "waitStatus", item."revision" AS "waitRevision",
            item."startedAt" AS "waitStartedAt", item."content" AS "waitContent", item."completedAt" AS "waitCompletedAt"
     FROM stale
      LEFT JOIN "agent_approvals" AS approval ON approval."turnId" = stale."turnId"
     LEFT JOIN "agent_items" AS item ON item."id" = 'agent-wait:approval:' || approval."id"`,
    [now, limit],
  )
  const byTurn = new Map<string, GateRecoveryRow[]>()
  for (const row of result.rows) byTurn.set(row.turnId, [...(byTurn.get(row.turnId) ?? []), row])
  const reclaimed: ReclaimedTurn[] = []
  for (const [turnId, rows] of byTurn) {
    const current: Array<[GateRecoveryRow, NonNullable<ReturnType<typeof gateRecoveryIdentity>>]> = []
    let unknownReceipt = false
    for (const row of rows) {
      const identity = gateRecoveryIdentity(row)
      if (identity === null) unknownReceipt = true; else if (identity.current) current.push([row, identity])
    }
    if (unknownReceipt || !current.length) continue
    let valid = true, projected = false
    for (const [row, identity] of current) {
      const result = await exactGateRecoveryReceipt(row, identity, now)
      valid = valid && result.valid; projected = projected || result.projected
    }
    if (!valid || !projected) continue
    const row = current[0]![0]
    const updated = await client.query<{ id: string; sessionId: string; leaseVersion: number }>(
      `UPDATE "agent_turns" AS turn
       SET "status" = 'queued', "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL, "leaseStartedAt" = NULL,
           "leaseVersion" = "leaseVersion" + 1, "revision" = "revision" + 1, "completedAt" = NULL, "updatedAt" = $4
       WHERE turn."id" = $1 AND turn."status" = 'waiting_for_approval'
         AND turn."leaseOwnerId" = $2 AND turn."leaseVersion" = $3 AND turn."leaseExpiresAt" <= $4
       RETURNING turn."id", turn."sessionId", turn."leaseVersion"`,
      [turnId, row.turnLeaseOwnerId, row.turnLeaseVersion, now],
    )
    const recovered = updated.rows[0]; if (recovered) reclaimed.push({ turnId: recovered.id, sessionId: recovered.sessionId, previousLeaseVersion: recovered.leaseVersion - 1 })
  }
  return reclaimed
}
function gateRecoveryIdentity(row: GateRecoveryRow) {
  const secret = process.env.AGENT_WORKER_SECRET?.trim()
  if (!secret || !row.approvalJobId
    || !row.resourceHash || !row.materialHash || !row.answersHash) return null
  const identity = JSON.stringify([1, row.userId, row.sessionId, row.turnId, row.executionId, row.executionAttemptCount,
    [row.rootTaskId, row.rootAttemptCount, row.executionId, row.executionAttemptCount], row.approvalJobId, "review_application", row.resourceHash, row.materialHash, row.answersHash])
  const derive = (label: string) => createHmac("sha256", secret).update(`applymate.gate-review-replay.v1:${label}\0${identity}`).digest("hex")
  const approvalId = `gate_review_${derive("approval-id")}`, toolCallId = `application-review:${derive("tool-call-id")}`
  const current = row.approvalId === approvalId || row.approvalToolCallId === toolCallId
  if (!current && (!row.approvalId || !row.approvalToolCallId)) return null
  return { approvalId, toolCallId, nonce: derive("receipt-nonce"), current }
}
async function exactGateRecoveryReceipt(row: GateRecoveryRow, identity: NonNullable<ReturnType<typeof gateRecoveryIdentity>>, now: Date): Promise<{ valid: boolean; projected: boolean }> {
  const expiresAt = row.approvalExpiresAt, hashes = [row.resourceHash, row.materialHash, row.answersHash, row.scopeHash, row.nonceHash]
  if (!row.approvalId || !row.approvalUserId || !row.approvalSessionId || !row.approvalTurnId || !row.approvalJobId
    || !row.approvalToolCallId || row.approvalAction !== "review_application" || row.approvalPayloadJobId !== row.approvalJobId
    || typeof row.approvalTitle !== "string" || typeof row.approvalBody !== "string"
    || hashes.some(hash => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
    || !(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime()) || !Number.isFinite(now.getTime()) || expiresAt <= now || !Number.isSafeInteger(row.approvalRevision) || row.approvalRevision! < 0) return { valid: false, projected: false }
  const answersHash = await hashAgentReceiptValue("answers", null)
  if (row.approvalId !== identity.approvalId || row.approvalToolCallId !== identity.toolCallId
    || row.approvalUserId !== row.userId || row.approvalSessionId !== row.sessionId || row.approvalTurnId !== row.turnId
    || row.answersHash !== answersHash || row.nonceHash !== await hashApprovalNonce(identity.nonce)) return { valid: false, projected: false }
  const scopeHash = await hashApprovalScope({ userId: row.approvalUserId, sessionId: row.approvalSessionId, turnId: row.approvalTurnId,
    jobId: row.approvalJobId, toolCallId: row.approvalToolCallId, action: "review_application", resourceHash: row.resourceHash!, materialHash: row.materialHash!,
    answersHash: row.answersHash, revision: row.approvalRevision!, nonceHash: row.nonceHash!, expiresAt: expiresAt.toISOString() })
  const item = row.waitContent && typeof row.waitContent === "object" && !Array.isArray(row.waitContent)
    ? row.waitContent as Record<string, unknown> : null
  const pending = row.approvalStatus === "pending"; if (!pending && row.approvalStatus !== "approved") return { valid: false, projected: false }
  const receiptValid = row.scopeHash === scopeHash && (pending ? row.decidedAt === null && row.consumedAt === null
    : row.approvalStatus === "approved" && row.decidedAt instanceof Date && row.consumedAt === null)
  const projected = row.waitItemId === `agent-wait:approval:${row.approvalId}`
    && row.waitSessionId === row.sessionId && row.waitTurnId === row.turnId && row.waitType === "approval_request"
    && row.waitStartedAt instanceof Date && item?.waitKind === "approval"
    && item.approvalId === row.approvalId && item.toolCallId === row.approvalToolCallId && item.action === row.approvalAction
    && item.title === row.approvalTitle && item.body === row.approvalBody && isDeepStrictEqual(item.impact, row.approvalImpact)
    && item.scopeHash === row.scopeHash && item.receiptRevision === row.approvalRevision && item.expiresAt === row.approvalExpiresAtUtc
    && (pending ? row.waitStatus === "started" && row.waitRevision === 0 && row.waitCompletedAt === null
      && item.decision === null && item.responseAvailable !== true
      : row.waitStatus === "completed" && row.waitRevision === 1 && row.waitCompletedAt instanceof Date
        && item.decision === "approved" && item.responseAvailable === true && item.respondedAt === row.decidedAt?.toISOString())
  if (row.waitItemId === null && pending) return { valid: receiptValid, projected: false }
  return { valid: receiptValid && projected, projected: projected }
}
export async function persistTurnDispatch(pool: LeasePool, payload: TurnJobPayload, resetPublished = false): Promise<void> {
  await withTransaction(pool, (client) => persistTurnDispatchInTransaction(client, payload, resetPublished))
}
/** Writes one canonical dispatch intent inside an already-open transaction. */
export async function persistTurnDispatchInTransaction(
  client: Pick<pg.PoolClient, "query">,
  payload: TurnJobPayload,
  resetPublished = false,
  requireRunnableSession = resetPublished,
): Promise<void> {
  // Dispatch and claim serialize in agent_sessions -> agent_turns order.
  if (requireRunnableSession) {
    const session = await client.query<{ id: string }>(
      `SELECT session."id" FROM "agent_sessions" AS session
       WHERE session."id" = $1
         AND ${RUNNABLE_SESSION}
       FOR UPDATE`,
      [payload.sessionId],
    )
    if (!session.rows[0]) return
  } else {
    await client.query(
      `SELECT session."id" FROM "agent_sessions" AS session
       WHERE session."id" = $1
       FOR UPDATE`,
      [payload.sessionId],
    )
  }
  const lineage = await client.query<{ id: string }>(
    `SELECT turn."id"
     FROM "agent_turns" AS turn
     JOIN "agent_sessions" AS session
       ON session."id" = turn."sessionId"
      AND session."userId" = turn."userId"
     WHERE turn."id" = $1 AND turn."sessionId" = $2
     FOR UPDATE OF turn, session`,
    [payload.turnId, payload.sessionId],
  )
  if (!lineage.rows[0]) throw new Error(TURN_DISPATCH_LINEAGE_ERROR)
  const idempotencyKey = turnDispatchKey(payload.turnId)
  const conflictClause = resetPublished
    ? `ON CONFLICT ("idempotencyKey") DO UPDATE SET "payload" = EXCLUDED."payload", "publishedAt" = NULL, "lastError" = NULL, "attemptCount" = "agent_outbox"."attemptCount" + 1
       WHERE "agent_outbox"."topic" = EXCLUDED."topic"
         AND "agent_outbox"."aggregateId" = EXCLUDED."aggregateId"`
    : `ON CONFLICT ("idempotencyKey") DO NOTHING`
  const written = await client.query(
    `INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ${conflictClause}`,
    [randomUUID(), TURN_DISPATCH_TOPIC, payload.sessionId, idempotencyKey, payloadJson(payload)],
  )
  if (resetPublished && written.rowCount !== 1) {
    const conflict = await client.query<{ aggregateId: string; topic: string }>(
      `SELECT "aggregateId", "topic" FROM "agent_outbox"
       WHERE "idempotencyKey" = $1 FOR UPDATE`,
      [idempotencyKey],
    )
    if (conflict.rows[0]?.topic !== TURN_DISPATCH_TOPIC || conflict.rows[0]?.aggregateId !== payload.sessionId) throw new Error(TURN_DISPATCH_LINEAGE_ERROR)
  }
}
/** Adds a wakeup-owned dispatch generation without opening a second transaction. */
export async function persistWakeupTurnDispatchInTransaction(
  client: Pick<pg.PoolClient, "query">,
  turnId: string,
  sessionId: string,
  eventId: string,
): Promise<boolean> {
  try {
    await persistTurnDispatchInTransaction(client, { turnId, sessionId, ownerId: `wakeup:${eventId}` }, true, false)
    return true
  } catch (error) {
    if (error instanceof Error && error.message === TURN_DISPATCH_LINEAGE_ERROR) return false
    throw error
  }
}
/** Rewrites pre-P4-39 dispatch rows to their canonical session aggregate. */
export async function repairLegacyTurnDispatchAggregates(pool: LeasePool, limit = TURN_DISPATCH_MAX_BATCH): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Turn dispatch repair limit must be positive")
  return withTransaction(pool, async (client) => {
    const result = await client.query(
      `WITH candidates AS (
         SELECT dispatch."id" AS "dispatchId", turn."id" AS "turnId", session."id" AS "sessionId"
         FROM "agent_sessions" AS session
         JOIN "agent_turns" AS turn
           ON turn."sessionId" = session."id"
          AND turn."userId" = session."userId"
         JOIN "agent_outbox" AS dispatch
           ON dispatch."aggregateId" = turn."id"
          AND dispatch."aggregateId" <> session."id"
          AND dispatch."topic" = $1
          AND dispatch."idempotencyKey" = 'turn-dispatch:' || turn."id"
          AND dispatch."payload"->>'turnId' = turn."id"
          AND dispatch."payload"->>'sessionId' = session."id"
         WHERE ${OPEN_SESSION}
         ORDER BY dispatch."createdAt" ASC, dispatch."id" ASC
         LIMIT $2 FOR UPDATE OF session, turn, dispatch SKIP LOCKED
       )
       UPDATE "agent_outbox" AS dispatch
       SET "aggregateId" = candidates."sessionId"
       FROM candidates
       WHERE dispatch."id" = candidates."dispatchId"
         AND dispatch."topic" = $1
         AND dispatch."aggregateId" = candidates."turnId"
         AND dispatch."aggregateId" <> candidates."sessionId"
         AND dispatch."idempotencyKey" = 'turn-dispatch:' || candidates."turnId"
         AND dispatch."payload"->>'turnId' = candidates."turnId"
         AND dispatch."payload"->>'sessionId' = candidates."sessionId"
       RETURNING dispatch."id"`,
      [TURN_DISPATCH_TOPIC, limit],
    )
    return result.rowCount ?? result.rows.length
  })
}
