import type { Pool, PoolClient } from "pg"
import { isApprovalHash } from "@jobcopilot/agent-protocol"
import { hashReviewedApplicationMaterialProof, type ReviewedApplicationMaterialProof } from "@jobcopilot/shared"
import { acquireSourceMaterialFence } from "../db/source-material-fence.js"
import { hashArtifactContent } from "./subagents/artifact-adapters.js"
import { readSelectedJobReviewedArtifactWithClient, type SelectedJobReviewedArtifact } from "./selected-job-reviewed-artifact-read.js"
import { createPgApprovalStore } from "./approval/pg-store.js"
import type { ApprovalScopeInput } from "./approval/types.js"
import { loadSelectedJobArtifactContext } from "./subagents/selected-job-artifact-context.js"
import { assertSessionWorkAdmission, isSessionPauseRequestedError } from "./session-gate.js"
import {
  hasReviewedApplicationReviewBinding, loadReviewedApplicationReviewApproval, lockOrCreateReviewedApplicationTask,
  lockRejectedReviewTask, readRejectedReviewedApplicationReview, readReviewedApplicationReviewReplay, writeReviewedApplicationReviewBinding,
  type ReviewApprovalHashes, type ReviewedApplicationReviewBinding,
} from "./reviewed-application-review-task.js"
import type { TurnLease } from "./turns/lease.js"

const INTENT_KIND = "reviewed_application_review"
const TITLE = "Review selected application"
const BODY = "Approve these reviewed materials for a later form fill. This approval does not authorize submission."
const TTL_MS = 15 * 60_000
type Row = Record<string, unknown>
type Intent = Readonly<{ kind: typeof INTENT_KIND; version: 1; sourceTurnId: string; jobId: string }>
type Queryable = Pick<PoolClient, "query">
export type ReviewedApplicationReviewResult = Readonly<{ status: "issued" | "waiting" | "approved" | "rejected"; approvalId: string; waitItemId: string }>
  | Readonly<{ status: "denied" }>

/** Issue or replay one canonical review_application Wait for an exact, current selected-job proof. */
export async function issueOrReplayReviewedApplicationReview(input: {
  pool: Pool; lease: TurnLease; rootTaskId: string; intent: unknown; now?: Date
}): Promise<ReviewedApplicationReviewResult> {
  const now = input.now ?? new Date(), request = parseIntent(input.intent)
  if (!request || !validLease(input.lease, input.rootTaskId, now)) return { status: "denied" }
  const { lease } = input, approvalId = stableApprovalId(lease.turnId), toolCallId = `review_application:${lease.turnId}`
  const client = await input.pool.connect()
  let open = false
  try {
    await client.query("BEGIN"); open = true
    await client.query("SELECT set_config($1,$2,true)", ["app.user_id", lease.userId])
    await acquireSourceMaterialFence(client, [lease.userId])
    if (!await lockSession(client, lease)) return await finish(client, "ROLLBACK", { status: "denied" })
    await assertSessionWorkAdmission(client, { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId })
    if (!await lockTurn(client, lease, input.rootTaskId, request)) return await finish(client, "ROLLBACK", { status: "denied" })
    const turn = await readLockedTurn(client, lease)
    if (!turn || !sameIntent(turn.intent, request) || turn.revision < 0) return await finish(client, "ROLLBACK", { status: "denied" })
    if (!await lockLiveRoot(client, lease, input.rootTaskId)) return await finish(client, "ROLLBACK", { status: "denied" })
    const priorRows = (await client.query(`SELECT "taskId", "status" FROM "agent_approvals"
      WHERE "id"=$1 AND "userId"=$2 AND "sessionId"=$3 AND "turnId"=$4 LIMIT 2`,
    [approvalId, lease.userId, lease.sessionId, lease.turnId])).rows
    if (priorRows.length > 1) return await finish(client, "ROLLBACK", { status: "denied" })
    const prior = record(priorRows[0])
    if (prior?.status === "rejected") {
      if (!text(prior.taskId, 256) || !await lockRejectedReviewTask(client, {
        userId: lease.userId, sessionId: lease.sessionId, jobId: request.jobId, taskId: prior.taskId,
      })) return await finish(client, "ROLLBACK", { status: "denied" })
      const stored = await loadReviewedApplicationReviewApproval(client, approvalId, lease)
      if (stored.length !== 1) return await finish(client, "ROLLBACK", { status: "denied" })
      const replay = await readRejectedReviewedApplicationReview(client, {
        value: stored[0], lease, intent: request, applicationTaskId: prior.taskId, approvalId, toolCallId,
        title: TITLE, body: BODY,
      })
      return await finish(client, replay ? "COMMIT" : "ROLLBACK", replay ?? { status: "denied" })
    }
    const context = await loadSelectedJobArtifactContext(client, lease.userId, request.jobId)
    if (context.preparation.jobId !== request.jobId || !text(context.baseResumeId, 256)) return await finish(client, "ROLLBACK", { status: "denied" })
    const applicationTaskId = await lockOrCreateReviewedApplicationTask(client, {
      userId: lease.userId, sessionId: lease.sessionId, jobId: request.jobId, resumeId: context.baseResumeId, now,
    })
    if (!applicationTaskId) return await finish(client, "ROLLBACK", { status: "denied" })
    const proof = await readSelectedJobReviewedArtifactWithClient(client, {
      userId: lease.userId, sessionId: lease.sessionId, jobId: request.jobId, sourceTurnId: request.sourceTurnId,
    })
    if (!proof || proof.jobId !== request.jobId || proof.sourceTurnId !== request.sourceTurnId
      || proof.sourceDigest !== context.preparation.sourceDigest) return await finish(client, "ROLLBACK", { status: "denied" })
    const hashes = await approvalHashes(lease, applicationTaskId, proof)
    if (!hashes) return await finish(client, "ROLLBACK", { status: "denied" })
    const scope = scopeInput(lease, request, toolCallId, hashes, turn.revision, new Date(now.getTime() + TTL_MS))
    const stored = await loadReviewedApplicationReviewApproval(client, approvalId, lease)
    if (stored.length > 1) return await finish(client, "ROLLBACK", { status: "denied" })
    if (stored.length === 1) {
      const replay = await readReviewedApplicationReviewReplay(client, { value: stored[0], lease, intent: request,
        proof: proofProjection(proof), applicationTaskId, approvalId, toolCallId, hashes, title: TITLE, body: BODY, now })
      return await finish(client, replay ? "COMMIT" : "ROLLBACK", replay ?? { status: "denied" })
    }
    if (await hasReviewedApplicationReviewBinding(client, applicationTaskId, lease.turnId)) return await finish(client, "ROLLBACK", { status: "denied" })
    const store = createPgApprovalStore(input.pool, { userId: lease.userId })
    const issued = await store.issueInTransaction(client, {
      approvalId, taskId: applicationTaskId, scope, title: TITLE, body: BODY, payload: { applicationTaskId, jobId: request.jobId },
      impact: { externalSubmission: false, jobId: request.jobId },
    })
    const receipt = issued.approval
    if (!issuedReceiptMatches(receipt, scope, applicationTaskId, approvalId)) throw new Error("review_receipt_invalid")
    const binding = bindingFor(lease, request, proof, applicationTaskId, approvalId, toolCallId, hashes, turn.revision, scope.expiresAt)
    await writeReviewedApplicationReviewBinding(client, binding, now)
    await client.query("COMMIT"); open = false
    return { status: "issued", approvalId, waitItemId: `agent-wait:approval:${approvalId}` }
  } catch (error) {
    if (open) await client.query("ROLLBACK").catch(() => undefined)
    if (isSessionPauseRequestedError(error)) throw error
    return { status: "denied" }
  } finally { client.release() }
}

type LockedTurn = { rootTaskId: string; intent: Intent; revision: number }
async function lockSession(client: Queryable, lease: TurnLease): Promise<boolean> {
  const result = await client.query(`SELECT "id" FROM "agent_sessions" WHERE "id"=$1 AND "userId"=$2
    AND "status" NOT IN ('aborted','archived') FOR UPDATE`, [lease.sessionId, lease.userId])
  return result.rows.length === 1
}
async function lockTurn(client: Queryable, lease: TurnLease, rootTaskId: string, intent: Intent): Promise<boolean> {
  const result = await client.query(`SELECT "id" FROM "agent_turns" WHERE "id"=$1 AND "sessionId"=$2 AND "userId"=$3
    AND "source"='user' AND "executionMode"='canonical_task_graph' AND "status"='in_progress'
    AND "rootTaskId"=$4 AND "leaseOwnerId"=$5 AND "leaseVersion"=$6
    AND date_trunc('milliseconds',"leaseExpiresAt")=date_trunc('milliseconds',$7::timestamptz)
    AND "leaseExpiresAt">clock_timestamp() FOR UPDATE`,
  [lease.turnId, lease.sessionId, lease.userId, rootTaskId, lease.ownerId, lease.leaseVersion, lease.leaseExpiresAt])
  if (result.rows.length !== 1) return false
  const turn = await readLockedTurn(client, lease)
  return Boolean(turn && turn.rootTaskId === rootTaskId && sameIntent(turn.intent, intent))
}
async function readLockedTurn(client: Queryable, lease: TurnLease): Promise<LockedTurn | null> {
  const result = await client.query(`SELECT "rootTaskId", "input", "revision" FROM "agent_turns"
    WHERE "id"=$1 AND "sessionId"=$2 AND "userId"=$3`, [lease.turnId, lease.sessionId, lease.userId])
  if (result.rows.length !== 1) return null
  const row = record(result.rows[0]), outer = record(row?.input), intent = parseIntent(outer?.intent)
  return row && outer && !Object.hasOwn(outer, "selectedJobPreparation") && text(row.rootTaskId, 256)
    && Number.isSafeInteger(row.revision) && Number(row.revision) >= 0 && intent
    ? { rootTaskId: row.rootTaskId, intent, revision: Number(row.revision) } : null
}
async function lockLiveRoot(client: Queryable, lease: TurnLease, rootTaskId: string): Promise<boolean> {
  const result = await client.query(`SELECT root."id", root."status", root."role", root."taskType", root."depth", root."attemptCount", root."leaseOwner",
      root."leaseExpiresAt", root."interruptRequestedAt", root."failureReason", root."completedAt", root."closedAt", root."nextAttemptAt"
    FROM "sub_agent_tasks" AS root
    JOIN "agent_sessions" AS session ON session."id"=root."sessionId" AND session."userId"=$2
    JOIN "agent_turns" AS turn ON turn."id"=root."turnId" AND turn."sessionId"=session."id" AND turn."userId"=session."userId"
    WHERE root."id"=$1 AND root."sessionId"=$3 AND root."turnId"=$4 AND turn."rootTaskId"=$1
      AND root."rootTaskId"=$1 AND root."parentTaskId" IS NULL AND root."role"='orchestrator' AND root."taskType"='root' AND root."depth"=0
      AND root."status"='running' AND root."leaseOwner"=$5 AND root."attemptCount"=1
      AND date_trunc('milliseconds',root."leaseExpiresAt")=date_trunc('milliseconds',$6::timestamptz)
      AND root."leaseExpiresAt">clock_timestamp() AND root."interruptRequestedAt" IS NULL AND root."failureReason" IS NULL
      AND root."completedAt" IS NULL AND root."closedAt" IS NULL AND root."nextAttemptAt" IS NULL FOR UPDATE OF root`,
  [rootTaskId, lease.userId, lease.sessionId, lease.turnId, lease.ownerId, lease.leaseExpiresAt])
  const row = record(result.rows[0])
  return result.rows.length === 1 && row?.id === rootTaskId && row.status === "running" && row.role === "orchestrator"
    && row.taskType === "root" && row.depth === 0 && row.attemptCount === 1 && row.leaseOwner === lease.ownerId
    && sameMillis(row.leaseExpiresAt, lease.leaseExpiresAt) && row.interruptRequestedAt === null && row.failureReason === null
    && row.completedAt === null && row.closedAt === null && row.nextAttemptAt === null
}

async function approvalHashes(lease: TurnLease, applicationTaskId: string, proof: SelectedJobReviewedArtifact): Promise<ReviewApprovalHashes | null> {
  const projected = proofProjection(proof), materialHash = await hashReviewedApplicationMaterialProof(projected)
  const resourceHash = bareHash(hashArtifactContent({ kind: "review_application", userId: lease.userId,
    sessionId: lease.sessionId, jobId: proof.jobId, applicationTaskId }))
  const answersHash = bareHash(hashArtifactContent({ kind: "review_application", formAnswers: null }))
  return materialHash && isApprovalHash(materialHash) && isApprovalHash(resourceHash) && isApprovalHash(answersHash)
    ? { resourceHash, materialHash, answersHash } : null
}
function scopeInput(lease: TurnLease, intent: Intent, toolCallId: string, hashes: ReviewApprovalHashes, revision: number, expiresAt: Date): ApprovalScopeInput {
  return { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, jobId: intent.jobId, toolCallId,
    action: "review_application", ...hashes, revision, expiresAt }
}
function bindingFor(lease: TurnLease, intent: Intent, proof: SelectedJobReviewedArtifact, applicationTaskId: string,
  approvalId: string, toolCallId: string, hashes: ReviewApprovalHashes, revision: number, expiresAt: Date): ReviewedApplicationReviewBinding {
  return {
    schemaVersion: "agent-harness.v2.reviewed-application-review-binding.v1", approvalId, reviewTurnId: lease.turnId,
    applicationTaskId, userId: lease.userId, sessionId: lease.sessionId, jobId: intent.jobId, proof: proofProjection(proof),
    receiptScope: { action: "review_application", toolCallId, ...hashes, revision, expiresAt: expiresAt.toISOString() },
  }
}
function proofProjection(value: SelectedJobReviewedArtifact): ReviewedApplicationMaterialProof {
  return { jobId: value.jobId, sourceTurnId: value.sourceTurnId, rootTaskId: value.rootTaskId, graphRevision: value.graphRevision,
    writerTaskId: value.writerTaskId, reviewerTaskId: value.reviewerTaskId, reviewerToolCallId: value.reviewerToolCallId,
    reviewHash: value.reviewHash, artifactId: value.artifactId, version: value.version, contentHash: value.contentHash, sourceDigest: value.sourceDigest }
}
function issuedReceiptMatches(receipt: { id: string; type: string; status: string; payload: unknown; scopeHash: string; scope: Record<string, unknown> },
  scope: ApprovalScopeInput, taskId: string, id: string): boolean {
  const payload = record(receipt.payload), saved = receipt.scope
  return receipt.id === id && receipt.type === "review_application" && receipt.status === "pending" && isApprovalHash(receipt.scopeHash)
    && payload !== null && exactKeys(payload, "applicationTaskId,jobId") && payload.applicationTaskId === taskId && payload.jobId === scope.jobId
    && saved.userId === scope.userId && saved.sessionId === scope.sessionId && saved.turnId === scope.turnId && saved.jobId === scope.jobId
    && saved.toolCallId === scope.toolCallId && saved.action === scope.action && saved.resourceHash === scope.resourceHash
    && saved.materialHash === scope.materialHash && saved.answersHash === scope.answersHash && saved.revision === scope.revision
    && saved.expiresAt === scope.expiresAt.toISOString()
}

function parseIntent(value: unknown): Intent | null {
  const row = record(value)
  return row && exactKeys(row, "jobId,kind,sourceTurnId,version") && row.kind === INTENT_KIND && row.version === 1
    && text(row.jobId, 256) && text(row.sourceTurnId, 256)
    ? { kind: INTENT_KIND, version: 1, sourceTurnId: row.sourceTurnId, jobId: row.jobId } : null
}
function sameIntent(left: Intent, right: Intent): boolean {
  return left.kind === right.kind && left.version === right.version && left.sourceTurnId === right.sourceTurnId && left.jobId === right.jobId
}
function validLease(lease: TurnLease, rootTaskId: string, now: Date): boolean {
  return [lease.userId, lease.sessionId, lease.turnId, lease.ownerId, rootTaskId].every(value => text(value, 256))
    && Number.isSafeInteger(lease.leaseVersion) && lease.leaseVersion > 0 && date(lease.leaseStartedAt) !== null
    && lease.leaseStartedAt <= now && date(lease.leaseExpiresAt) !== null && lease.leaseExpiresAt > now
}
function stableApprovalId(turnId: string): string { return `reviewed-application-review:${turnId}` }
function bareHash(value: string): string { return value.startsWith("sha256:") ? value.slice(7) : value }
function sameMillis(value: unknown, expected: Date): boolean {
  const parsed = date(value)
  return parsed !== null && parsed.getTime() === expected.getTime()
}
function date(value: unknown): Date | null {
  const parsed = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null
}
function record(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return (prototype === Object.prototype || prototype === null)
    && Object.getOwnPropertySymbols(parsed).length === 0 ? parsed as Row : null } catch { return null }
}
function exactKeys(value: Row, keys: string): boolean { return Object.keys(value).sort().join(",") === keys }
function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }
function text(value: unknown, limit: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= limit }
async function finish<T>(client: PoolClient, command: "COMMIT" | "ROLLBACK", result: T): Promise<T> {
  await client.query(command)
  return result
}
