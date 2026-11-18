import { createHmac } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type pg from "pg"
import { hashAgentReceiptValue } from "@jobcopilot/shared"
import { hashApprovalNonce, hashApprovalScope } from "@jobcopilot/agent-protocol"
import {
  readMaterialDriftRecoveryIntent,
  verifyMaterialDriftRecoveryLineage,
} from "../subagents/canonical-turn-scheduled-pipeline-context.js"
import type { ReclaimedTurn } from "./recovery-scanner-common.js"
import { RUNNABLE_SESSION } from "../session-gate.js"

type GateRecoveryRow = {
  turnId: string; sessionId: string; userId: string; rootTaskId: string; rootAttemptCount: number; turnLeaseOwnerId: string; turnLeaseVersion: number; executionId: string; executionAttemptCount: number
  turnSource: string; turnExecutionMode: string | null; turnStatus: string; turnInput: unknown
  approvalId: string | null; approvalUserId: string | null; approvalSessionId: string | null; approvalTurnId: string | null; approvalJobId: string | null; approvalAction: string | null; approvalStatus: string | null; approvalToolCallId: string | null; approvalTitle: string | null; approvalBody: string | null; approvalImpact: unknown; approvalPayloadJobId: string | null
  resourceHash: string | null; materialHash: string | null; answersHash: string | null; scopeHash: string | null; nonceHash: string | null; approvalRevision: number | null; approvalExpiresAt: Date | null; approvalExpiresAtUtc: string | null; decidedAt: Date | null; consumedAt: Date | null
  waitItemId: string | null; waitSessionId: string | null; waitTurnId: string | null; waitType: string | null; waitStatus: string | null; waitRevision: number | null; waitStartedAt: Date | null; waitContent: unknown; waitCompletedAt: Date | null
}

const DIGEST = /^[a-f0-9]{64}$/

/** Reclaims the existing scheduled Gate receipt or an independently verified manual recovery Gate. */
export async function reclaimExpiredGateRecoveryTurns(client: Pick<pg.PoolClient, "query">, now: Date, limit: number): Promise<ReclaimedTurn[]> {
  if (limit < 1) return []
  const result = await client.query<GateRecoveryRow>(
    `WITH stale AS (
       SELECT turn."id" AS "turnId", turn."sessionId", turn."userId", turn."rootTaskId", turn."leaseOwnerId" AS "turnLeaseOwnerId", turn."leaseVersion" AS "turnLeaseVersion",
              turn."source" AS "turnSource", turn."executionMode" AS "turnExecutionMode", turn."status" AS "turnStatus", turn."input" AS "turnInput",
              root."attemptCount" AS "rootAttemptCount", execution."id" AS "executionId", execution."attemptCount" AS "executionAttemptCount"
       FROM "agent_sessions" AS session
       JOIN "agent_turns" AS turn ON turn."sessionId" = session."id" AND turn."userId" = session."userId"
       JOIN "agent_executions" AS execution ON execution."sessionId" = session."id" AND execution."userId" = session."userId"
       JOIN "sub_agent_tasks" AS root ON root."id" = turn."rootTaskId" AND root."sessionId" = turn."sessionId"
       JOIN LATERAL (SELECT execution."state"->'scheduledTaskGraphClaim' AS claim, execution."state"->'scheduledTaskGraphContinuation' AS continuation) AS markers ON TRUE
       WHERE ${RUNNABLE_SESSION}
         AND turn."status" = 'waiting_for_approval' AND turn."leaseExpiresAt" <= $1
         AND length(btrim(turn."leaseOwnerId")) BETWEEN 1 AND 256 AND btrim(turn."leaseOwnerId") = turn."leaseOwnerId" AND turn."leaseVersion" > 0 AND turn."source" = 'automation'
         AND turn."executionMode" = 'canonical_task_graph'
         AND (turn."input"->>'automationRunMode' = 'scheduled' OR (turn."input"->>'automationRunMode' = 'manual' AND turn."input" ? 'materialDriftRecovery'))
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
    const row = rows[0]!
    if (await isManualRecoveryCandidate(row) && !await verifyManualRecovery(client, row)) continue
    const current: Array<[GateRecoveryRow, NonNullable<ReturnType<typeof gateRecoveryIdentity>>]> = []
    let unknownReceipt = false
    for (const candidate of rows) {
      const identity = gateRecoveryIdentity(candidate)
      if (identity === null) unknownReceipt = true; else if (identity.current) current.push([candidate, identity])
    }
    if (unknownReceipt || !current.length) continue
    let valid = true, projected = false
    for (const [candidate, identity] of current) {
      const receipt = await exactGateRecoveryReceipt(candidate, identity, now)
      valid = valid && receipt.valid; projected = projected || receipt.projected
    }
    if (!valid || !projected) continue
    const updated = await client.query<{ id: string; sessionId: string; leaseVersion: number }>(
      `UPDATE "agent_turns" AS turn
       SET "status" = 'queued', "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL, "leaseStartedAt" = NULL,
           "leaseVersion" = "leaseVersion" + 1, "revision" = "revision" + 1, "completedAt" = NULL, "updatedAt" = $4
       WHERE turn."id" = $1 AND turn."status" = 'waiting_for_approval'
         AND turn."leaseOwnerId" = $2 AND turn."leaseVersion" = $3 AND turn."leaseExpiresAt" <= $4
       RETURNING turn."id", turn."sessionId", turn."leaseVersion"`,
      [turnId, row.turnLeaseOwnerId, row.turnLeaseVersion, now],
    )
    const recovered = updated.rows[0]
    if (recovered) reclaimed.push({ turnId: recovered.id, sessionId: recovered.sessionId, previousLeaseVersion: recovered.leaseVersion - 1 })
  }
  return reclaimed
}

async function isManualRecoveryCandidate(row: GateRecoveryRow): Promise<boolean> {
  const input = asRecord(row.turnInput)
  return row.turnSource === "automation" && row.turnExecutionMode === "canonical_task_graph" && row.turnStatus === "waiting_for_approval"
    && input?.automationRunMode === "manual" && Object.hasOwn(input, "materialDriftRecovery")
}
async function verifyManualRecovery(client: Pick<pg.PoolClient, "query">, row: GateRecoveryRow): Promise<boolean> {
  const turn = { id: row.turnId, sessionId: row.sessionId, userId: row.userId, source: row.turnSource,
    executionMode: row.turnExecutionMode, status: row.turnStatus, input: row.turnInput }
  const read = readMaterialDriftRecoveryIntent(turn)
  return read.status === "valid" && verifyMaterialDriftRecoveryLineage(client, turn, read.intent)
}
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function gateRecoveryIdentity(row: GateRecoveryRow) {
  const secret = process.env.AGENT_WORKER_SECRET?.trim()
  if (!secret || !row.approvalJobId || !row.resourceHash || !row.materialHash || !row.answersHash) return null
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
  if (!row.approvalId || !row.approvalUserId || !row.approvalSessionId || !row.approvalTurnId || !row.approvalJobId || !row.approvalToolCallId
    || row.approvalAction !== "review_application" || row.approvalPayloadJobId !== row.approvalJobId
    || typeof row.approvalTitle !== "string" || typeof row.approvalBody !== "string" || hashes.some(hash => typeof hash !== "string" || !DIGEST.test(hash))
    || !(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime()) || !Number.isFinite(now.getTime()) || expiresAt <= now
    || !Number.isSafeInteger(row.approvalRevision) || row.approvalRevision! < 0) return { valid: false, projected: false }
  const answersHash = await hashAgentReceiptValue("answers", null)
  if (row.approvalId !== identity.approvalId || row.approvalToolCallId !== identity.toolCallId
    || row.approvalUserId !== row.userId || row.approvalSessionId !== row.sessionId || row.approvalTurnId !== row.turnId
    || row.answersHash !== answersHash || row.nonceHash !== await hashApprovalNonce(identity.nonce)) return { valid: false, projected: false }
  const scopeHash = await hashApprovalScope({ userId: row.approvalUserId, sessionId: row.approvalSessionId, turnId: row.approvalTurnId,
    jobId: row.approvalJobId, toolCallId: row.approvalToolCallId, action: "review_application", resourceHash: row.resourceHash!, materialHash: row.materialHash!,
    answersHash: row.answersHash, revision: row.approvalRevision!, nonceHash: row.nonceHash!, expiresAt: expiresAt.toISOString() })
  const item = asRecord(row.waitContent)
  const pending = row.approvalStatus === "pending"
  if (!pending && row.approvalStatus !== "approved") return { valid: false, projected: false }
  const receiptValid = row.scopeHash === scopeHash && (pending ? row.decidedAt === null && row.consumedAt === null
    : row.approvalStatus === "approved" && row.decidedAt instanceof Date && row.consumedAt === null)
  const projected = row.waitItemId === `agent-wait:approval:${row.approvalId}` && row.waitSessionId === row.sessionId && row.waitTurnId === row.turnId
    && row.waitType === "approval_request" && row.waitStartedAt instanceof Date && item?.waitKind === "approval"
    && item.approvalId === row.approvalId && item.toolCallId === row.approvalToolCallId && item.action === row.approvalAction
    && item.title === row.approvalTitle && item.body === row.approvalBody && isDeepStrictEqual(item.impact, row.approvalImpact)
    && item.scopeHash === row.scopeHash && item.receiptRevision === row.approvalRevision && item.expiresAt === row.approvalExpiresAtUtc
    && (pending ? row.waitStatus === "started" && row.waitRevision === 0 && row.waitCompletedAt === null && item.decision === null && item.responseAvailable !== true
      : row.waitStatus === "completed" && row.waitRevision === 1 && row.waitCompletedAt instanceof Date && item.decision === "approved" && item.responseAvailable === true && item.respondedAt === row.decidedAt?.toISOString())
  if (row.waitItemId === null && pending) return { valid: receiptValid, projected: false }
  return { valid: receiptValid && projected, projected }
}
