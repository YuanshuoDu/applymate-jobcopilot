import { createHash } from "node:crypto"
import type { Pool, PoolClient } from "pg"
import { isApprovalHash, objectiveApplicationApprovalSetItemId, parseObjectiveApplicationReviewIntent, type ObjectiveApplicationReviewIntent } from "@jobcopilot/agent-protocol"
import { canonicalJson } from "@jobcopilot/shared"
import { acquireSourceMaterialFence } from "../db/source-material-fence.js"
import { hashArtifactContent } from "./subagents/artifact-adapters.js"
import { readCompletedObjectiveTailorSourceEvidence } from "./subagents/objective-tailor-completed-source.js"
import { readObjectiveApplicationResumeWitness } from "./approval/objective-application-resume-witness.js"
import { createPgObjectiveApplicationApprovalSetStore, type ObjectiveApplicationApprovalSetIssueInput } from "./approval/objective-application-approval-set-store.js"
import { protocolScope, type ApprovalScopeInput } from "./approval/types.js"
import { lockOrCreateReviewedApplicationTask } from "./reviewed-application-review-task.js"
import { isSessionPauseRequestedError, assertSessionWorkAdmission } from "./session-gate.js"
import type { TurnLease } from "./turns/lease.js"
import {
  objectiveApplicationReviewApprovalId, objectiveApplicationReviewIntentHash, objectiveApplicationReviewSetId,
  objectiveApplicationReviewToolCallId, readObjectiveApplicationReviewSetState, type ObjectiveApplicationReviewSetMember,
} from "./objective-application-review-set-state.js"

type Row = Record<string, unknown>
type Client = Pick<PoolClient, "query">
const TTL_MS = 15 * 60_000
const TITLE = "Review application materials"
const BODY = "Approve these reviewed materials for a later form fill. This approval does not authorize submission."
const PROOF_SCHEMA = "objective-application-review-member-proof.v1"
type Intent = ObjectiveApplicationReviewIntent
export type ObjectiveApplicationReviewIssueResult = Readonly<{ status: "issued" | "waiting" | "resolved"; setId: string; itemId: string; intentHash: string;
  members: readonly ObjectiveApplicationReviewSetMember[] }>
  | Readonly<{ status: "denied" }>

/** Issues one atomic review_application receipt per selected ready slot, or returns its durable replay. */
export async function issueOrReplayObjectiveApplicationReview(input: {
  pool: Pool; lease: TurnLease; rootTaskId: string; selection: unknown; now?: Date
}): Promise<ObjectiveApplicationReviewIssueResult> {
  const now = input.now ?? new Date(), selection = parseObjectiveApplicationReviewIntent(input.selection)
  if (!selection || !validLease(input.lease, input.rootTaskId, now)) return { status: "denied" }
  const { lease } = input, setId = objectiveApplicationReviewSetId(lease.sessionId, lease.turnId)
  const intentHash = objectiveApplicationReviewIntentHash(selection), client = await input.pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1,$2,true)", ["app.user_id", lease.userId])
    await acquireSourceMaterialFence(client, [lease.userId])
    if (!await lockSession(client, lease)) return await deny(client)
    await assertSessionWorkAdmission(client, { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId })
    const turn = await lockTurn(client, lease, input.rootTaskId, selection, now)
    if (!turn || !await lockRoot(client, lease, input.rootTaskId)) return await deny(client)
    const itemId = objectiveApplicationApprovalSetItemId(setId)
    const existing = await client.query<Row>(`SELECT "id", "sessionId", "turnId", "type" FROM "agent_items" WHERE "id"=$1 FOR UPDATE`, [itemId])
    if (existing.rows.length > 1) return await deny(client)
    if (existing.rows.length === 1 && (existing.rows[0]?.sessionId !== lease.sessionId || existing.rows[0]?.turnId !== lease.turnId
      || existing.rows[0]?.type !== "approval_request")) return await deny(client)
    const prior = existing.rows.length === 1 ? await readObjectiveApplicationReviewSetState(client, { userId: lease.userId,
      sessionId: lease.sessionId, turnId: lease.turnId, selection, now }) : undefined
    if (existing.rows.length === 1 && !prior) return await deny(client)
    if (prior) {
      await client.query("COMMIT")
      return { status: prior.status === "pending" ? "waiting" : "resolved", setId, itemId: prior.itemId, intentHash, members: prior.members }
    }
    const slotIds = selection.slotOrdinals.map(ordinal => `tailor-${ordinal}`)
    const evidence = await readCompletedObjectiveTailorSourceEvidence(client, { userId: lease.userId, sessionId: lease.sessionId,
      reviewTurnId: lease.turnId, sourceTurnId: selection.sourceTurnId, rootTaskId: selection.rootTaskId,
      graphItemId: selection.graphItemId, graphRevision: selection.graphRevision, selectedSlotIds: slotIds })
    if (!evidence || evidence.outcomes.length !== slotIds.length) return await deny(client)
    const expiresAt = new Date(now.getTime() + TTL_MS)
    const members: ObjectiveApplicationApprovalSetIssueInput["members"][number][] = []
    for (let index = 0; index < evidence.outcomes.length; index += 1) {
      const outcome = evidence.outcomes[index]!, ordinal = selection.slotOrdinals[index]!
      if (outcome.slotId !== slotIds[index] || outcome.status !== "ready") return await deny(client)
      const resumeWitness = await readObjectiveApplicationResumeWitness(client, { userId: lease.userId, jobId: outcome.jobId })
      if (!resumeWitness) return await deny(client)
      const applicationTaskId = await lockOrCreateReviewedApplicationTask(client, { userId: lease.userId, sessionId: lease.sessionId,
        jobId: outcome.jobId, resumeId: resumeWitness.resumeId, now })
      if (!applicationTaskId) return await deny(client)
      const proof = memberProof(evidence, outcome, ordinal, resumeWitness)
      if (!proof) return await deny(client)
      const hashes = approvalHashes(lease, applicationTaskId, outcome.jobId, ordinal, proof)
      if (!hashes) return await deny(client)
      const approvalId = objectiveApplicationReviewApprovalId(setId, ordinal)
      const scope: ApprovalScopeInput = { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId,
        jobId: outcome.jobId, toolCallId: objectiveApplicationReviewToolCallId(setId, ordinal), action: "review_application",
        ...hashes, revision: turn.revision, expiresAt }
      members.push({ slotOrdinal: ordinal, receipt: { approvalId, taskId: applicationTaskId, scope, title: TITLE, body: BODY,
        impact: { externalSubmission: false, jobId: outcome.jobId }, payload: proof } })
    }
    const store = createPgObjectiveApplicationApprovalSetStore(input.pool, { userId: lease.userId })
    const issued = await store.issueInTransaction(client, { setId, sourceTurnId: selection.sourceTurnId, intentHash, expiresAt, members, now })
    const current = await readObjectiveApplicationReviewSetState(client, { userId: lease.userId, sessionId: lease.sessionId,
      turnId: lease.turnId, selection, now })
    if (!current || current.status !== "pending" || current.setId !== issued.approvalSet.setId) return await deny(client)
    await client.query("COMMIT")
    return { status: issued.disposition === "created" ? "issued" : "waiting", setId, itemId: issued.itemId, intentHash, members: current.members }
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    if (isSessionPauseRequestedError(error)) throw error
    return { status: "denied" }
  } finally { client.release() }
}

async function lockSession(client: Client, lease: TurnLease): Promise<boolean> {
  const result = await client.query(`SELECT "id" FROM "agent_sessions" WHERE "id"=$1 AND "userId"=$2 AND "status" NOT IN ('aborted','archived') FOR UPDATE`,
    [lease.sessionId, lease.userId])
  return result.rows.length === 1
}
async function lockTurn(client: Client, lease: TurnLease, rootTaskId: string, selection: Intent, now: Date): Promise<{ revision: number } | null> {
  const result = await client.query<Row>(`SELECT "id", "rootTaskId", "input", "revision" FROM "agent_turns" WHERE "id"=$1 AND "sessionId"=$2 AND "userId"=$3
    AND "source"='user' AND "executionMode"='canonical_task_graph' AND "status"='in_progress' AND "rootTaskId"=$4
    AND "leaseOwnerId"=$5 AND "leaseVersion"=$6 AND date_trunc('milliseconds',"leaseExpiresAt")=date_trunc('milliseconds',$7::timestamptz)
      AND "leaseExpiresAt">clock_timestamp() FOR UPDATE`, [lease.turnId, lease.sessionId, lease.userId, rootTaskId, lease.ownerId, lease.leaseVersion, lease.leaseExpiresAt])
  const row = asRecord(result.rows[0]), input = asRecord(row?.input), envelope = asRecord(input?.intent)
  const persisted = envelope?.kind === "objective_application_review" && envelope.version === 1
    ? parseObjectiveApplicationReviewIntent(envelope.selection) : null
  return result.rows.length === 1 && row?.rootTaskId === rootTaskId && Number.isSafeInteger(row.revision) && Number(row.revision) >= 0
    && persisted && sameIntent(persisted, selection) ? { revision: Number(row.revision) } : null
}
async function lockRoot(client: Client, lease: TurnLease, rootTaskId: string): Promise<boolean> {
  const result = await client.query<Row>(`SELECT root."id", root."status", root."role", root."taskType", root."depth", root."attemptCount", root."leaseOwner",
      root."leaseExpiresAt", root."interruptRequestedAt", root."failureReason", root."completedAt", root."closedAt", root."nextAttemptAt"
    FROM "sub_agent_tasks" AS root JOIN "agent_sessions" AS session ON session."id"=root."sessionId" AND session."userId"=$2
    JOIN "agent_turns" AS turn ON turn."id"=root."turnId" AND turn."sessionId"=session."id" AND turn."userId"=session."userId"
    WHERE root."id"=$1 AND root."sessionId"=$3 AND root."turnId"=$4 AND turn."rootTaskId"=$1 AND root."rootTaskId"=$1
      AND root."parentTaskId" IS NULL AND root."role"='orchestrator' AND root."taskType"='root' AND root."depth"=0 AND root."status"='running'
      AND root."leaseOwner"=$5 AND root."attemptCount"=1 AND date_trunc('milliseconds',root."leaseExpiresAt")=date_trunc('milliseconds',$6::timestamptz)
      AND root."leaseExpiresAt">clock_timestamp() AND root."interruptRequestedAt" IS NULL AND root."failureReason" IS NULL
      AND root."completedAt" IS NULL AND root."closedAt" IS NULL AND root."nextAttemptAt" IS NULL FOR UPDATE OF root`,
  [rootTaskId, lease.userId, lease.sessionId, lease.turnId, lease.ownerId, lease.leaseExpiresAt])
  return result.rows.length === 1
}
function memberProof(evidence: NonNullable<Awaited<ReturnType<typeof readCompletedObjectiveTailorSourceEvidence>>>, outcome: typeof evidence.outcomes[number],
  ordinal: number, resumeWitness: Awaited<ReturnType<typeof readObjectiveApplicationResumeWitness>>) {
  const ref = outcome.artifactRef, receipt = outcome.reviewReceipt
  if (!resumeWitness || !ref || !receipt || receipt.status !== "passed" || receipt.taskId !== outcome.reviewerTaskId
    || receipt.artifactId !== ref.artifactId || receipt.version !== ref.version || receipt.contentHash !== ref.contentHash
    || receipt.sourceDigest !== ref.sourceDigest || receipt.currentSourceDigest !== ref.sourceDigest
    || typeof receipt.reviewHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(receipt.reviewHash)
    || typeof receipt.toolCallId !== "string" || !receipt.toolCallId.trim()) return null
  const source = { jobId: outcome.jobId, sourceTurnId: evidence.sourceTurnId, rootTaskId: evidence.sourceRootTaskId,
    graphItemId: evidence.graphItemId, graphRevision: evidence.graphRevision, finalItemId: evidence.finalItemId, slotOrdinal: ordinal,
    writerTaskId: outcome.writerTaskId, reviewerTaskId: outcome.reviewerTaskId, reviewerToolCallId: receipt.toolCallId,
    reviewHash: receipt.reviewHash, artifactId: ref.artifactId, version: ref.version, contentHash: ref.contentHash, sourceDigest: ref.sourceDigest }
  const proof = { schema: PROOF_SCHEMA, source, resumeWitness }
  return { ...proof, materialProofHash: createHash("sha256").update(canonicalJson(proof)).digest("hex") }
}
function approvalHashes(lease: TurnLease, applicationTaskId: string, jobId: string, ordinal: number, proof: ReturnType<typeof memberProof>) {
  if (!proof) return null
  const resourceHash = bareHash(hashArtifactContent({ kind: "review_application", userId: lease.userId, sessionId: lease.sessionId, jobId, applicationTaskId, slotOrdinal: ordinal }))
  const answersHash = bareHash(hashArtifactContent({ kind: "review_application", formAnswers: null }))
  return isApprovalHash(resourceHash) && isApprovalHash(answersHash) && isApprovalHash(proof.materialProofHash)
    ? { resourceHash, materialHash: proof.materialProofHash, answersHash } : null
}
function bareHash(value: string): string { return value.startsWith("sha256:") ? value.slice(7) : value }
function sameIntent(left: Intent, right: Intent): boolean { return canonicalJson(left) === canonicalJson(right) }
function asRecord(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try { return Object.getPrototypeOf(value) === Object.prototype ? value as Row : null } catch { return null }
}
function validLease(lease: TurnLease, rootTaskId: string, now: Date): boolean {
  return [lease.userId, lease.sessionId, lease.turnId, lease.ownerId, rootTaskId].every(safeId)
    && Number.isSafeInteger(lease.leaseVersion) && lease.leaseVersion > 0 && validDate(lease.leaseStartedAt) <= now
    && validDate(lease.leaseExpiresAt) > now
}
function validDate(value: unknown): Date { return value instanceof Date && Number.isFinite(value.getTime()) ? value : new Date(Number.NaN) }
function safeId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
async function deny(client: PoolClient): Promise<{ status: "denied" }> { await client.query("ROLLBACK"); return { status: "denied" } }
