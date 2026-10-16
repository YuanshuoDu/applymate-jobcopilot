import { randomUUID } from "node:crypto"
import type { Pool, PoolClient } from "pg"
import { createApprovalNonce, hashApprovalScope } from "@jobcopilot/agent-protocol"
import { hashAgentReceiptValue, redactSensitiveText } from "@jobcopilot/shared"
import type { FormReviewNeeds } from "../harness/form-review.js"
import { isFormAnswerKeyV2 } from "../form-answer-key.js"
import { createPgApprovalStore } from "../runtime/approval/pg-store.js"
import { protocolScope, type ApprovalScopeInput, type IssueApprovalReceiptInput } from "../runtime/approval/types.js"
import type { SubagentLease } from "../runtime/subagents/types.js"
import { hashArtifactContent } from "../runtime/subagents/artifact-adapters.js"
import { ensureSubmissionArtifactWithClient } from "./submission-artifact.js"

type TurnRow = { id: string; status: string; revision: number }
type ApplicationRow = { id: string; userId: string; sessionId: string | null; jobId: string; fillTurnId: string | null; fillTurnSessionId: string | null
  fillTurnUserId: string | null; status: string; checkpoint: string | null; resumeId: string | null; coverLetterId: string | null; confirmedAnswers: unknown }
type ExistingApprovalRow = { id: string; userId: string; sessionId: string; turnId: string | null; jobId: string | null; type: string; taskId: string | null; status: string
  toolCallId: string | null; payload: unknown; resourceHash: string | null; materialHash: string | null; answersHash: string | null; scopeHash: string | null; nonceHash: string | null; revision: number; expiresAt: Date | string | null }
type ExistingArtifactRow = { id: string; userId: string; jobId: string; artifactType: string; lifecycle: string; baseId: string | null; baseHash: string | null
  content: unknown; hash: string; constraintHash: string; provenanceRefs: unknown; evidenceRefs: unknown; previousHash: string | null; version: number }
type FillStatus = { status: "completed" | "waiting" | "stale" | "conflict" | "failed" | "cancelled" }
type WaitCheckpoint = "fill_outcome_uncertain" | "form_answer_required"
type WaitDetail = "captcha_required" | "authentication_required" | "mfa_required" | "unknown_sensitive_field" | "required_field" | "stale_review" | "review_required" | "fill_outcome_uncertain" | "unattended_apply_unavailable" | "cancelled" | "browser_fill_failed"
type Client = Pick<PoolClient, "query">

const COMPLETION_TITLE = "Final submission authorization"
const COMPLETION_BODY = "The form was filled without submission. Review the current job, material alignment, required answers, and sensitive declarations before authorizing an external submission."
const SAFE_WAIT_DETAILS = new Set<WaitDetail>(["captcha_required", "authentication_required", "mfa_required", "unknown_sensitive_field", "required_field", "stale_review", "review_required", "fill_outcome_uncertain", "unattended_apply_unavailable", "cancelled", "browser_fill_failed"])

function validLease(lease: SubagentLease, now: Date, cancellation = false): boolean {
  return Boolean(lease.id.trim() && lease.userId.trim() && lease.sessionId.trim() && lease.turnId?.trim() && lease.ownerId.trim()
    && lease.role === "application_filler" && lease.taskType === "application_fill_for_review" && lease.status === "running"
    && lease.leaseOwner === lease.ownerId && Number.isSafeInteger(lease.attemptCount) && lease.attemptCount > 0
    && (cancellation || (lease.interruptRequestedAt === null && !lease.signal.aborted)) && now instanceof Date && Number.isFinite(now.getTime()))
}

async function lockFillScope(client: Client, lease: SubagentLease, now: Date, cancellation = false): Promise<{ turn: TurnRow; task: ApplicationRow } | null> {
  if (!validLease(lease, now, cancellation)) return null
  const sessionStates = cancellation ? "'running', 'waiting_for_user', 'paused', 'aborted'" : "'running', 'waiting_for_user'"
  const session = await client.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 AND "status" IN (${sessionStates}) FOR UPDATE`, [lease.sessionId, lease.userId])
  if (!session.rows[0]) return null
  const turnResult = await client.query<TurnRow>(`SELECT "id", "status", "revision" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR UPDATE`, [lease.turnId, lease.sessionId, lease.userId])
  const turn = turnResult.rows[0]
  if (!turn || !(cancellation ? ["in_progress", "waiting_for_user", "waiting_for_approval", "waiting_for_dependency", "interrupted"] : ["in_progress", "waiting_for_user", "waiting_for_approval"]).includes(turn.status)) return null
  const interruptCheck = cancellation ? "IS NOT NULL" : "IS NULL"
  const subtask = await client.query(`SELECT "subtask"."id" FROM "sub_agent_tasks" AS "subtask"
      INNER JOIN "agent_sessions" AS "session" ON "session"."id" = "subtask"."sessionId" AND "session"."userId" = $7
      INNER JOIN "agent_turns" AS "scopedTurn" ON "scopedTurn"."id" = "subtask"."turnId" AND "scopedTurn"."sessionId" = "subtask"."sessionId" AND "scopedTurn"."userId" = $7
      WHERE "subtask"."id" = $1 AND "subtask"."sessionId" = $2 AND "subtask"."turnId" = $3 AND "subtask"."role" = 'application_filler'
      AND "subtask"."taskType" = 'application_fill_for_review' AND "subtask"."status" = 'running' AND "subtask"."leaseOwner" = $4
      AND "subtask"."attemptCount" = $5 AND "subtask"."leaseExpiresAt" > GREATEST($6::timestamptz, clock_timestamp()) AND "subtask"."interruptRequestedAt" ${interruptCheck} FOR UPDATE OF "subtask"`,
  [lease.id, lease.sessionId, lease.turnId, lease.ownerId, lease.attemptCount, now, lease.userId])
  if (!subtask.rows[0]) return null
  const taskResult = await client.query<ApplicationRow>(`SELECT "id", "userId", "sessionId", "jobId", "fillTurnId", "fillTurnSessionId", "fillTurnUserId", "status", "checkpoint", "resumeId", "coverLetterId", "confirmedAnswers"
      FROM "application_tasks" WHERE "fillTurnId" = $1 AND "fillTurnSessionId" = $2 AND "fillTurnUserId" = $3 AND "userId" = $3 AND "sessionId" = $2 FOR UPDATE`,
  [lease.turnId, lease.sessionId, lease.userId])
  const task = taskResult.rows[0]
  return task && task.userId === lease.userId && task.sessionId === lease.sessionId && task.fillTurnId === lease.turnId
    && task.fillTurnSessionId === lease.sessionId && task.fillTurnUserId === lease.userId ? { turn, task } : null
}

const CANCELLED_FILL_BODY = "Application fill cancelled before submission."
/** Acknowledges only a durable interrupt for this exact live child lease. */
export async function acknowledgeApplicationFillCancellation(pool: Pool, input: { readonly lease: SubagentLease; readonly now?: Date }): Promise<FillStatus> {
  const { lease } = input, now = input.now ?? new Date()
  if (!validLease(lease, now, true) || !lease.turnId) return { status: "stale" }
  return inTransaction(pool, lease.userId, async client => {
    const locked = await lockFillScope(client, lease, now, true)
    if (!locked) return { status: "stale" }
    const task = locked.task
    if (task.status === "cancelled" && task.checkpoint === "turn_stopped_before_submit") return { status: "cancelled" }
    if (task.status !== "filling" || !["taskgraph_fill_queued", "browser_active"].includes(task.checkpoint ?? "")) return { status: "conflict" }
    const updated = await client.query(`UPDATE "application_tasks" SET "status" = 'cancelled', "checkpoint" = 'turn_stopped_before_submit', "completedAt" = $5, "updatedAt" = $5 WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3 AND "fillTurnId" = $4 AND "fillTurnSessionId" = $3 AND "fillTurnUserId" = $2 AND "status" = 'filling' AND "checkpoint" IN ('taskgraph_fill_queued', 'browser_active') AND EXISTS (SELECT 1 FROM "sub_agent_tasks" WHERE "id" = $6 AND "sessionId" = $3 AND "turnId" = $4 AND "role" = 'application_filler' AND "taskType" = 'application_fill_for_review' AND "status" = 'running' AND "leaseOwner" = $7 AND "attemptCount" = $8 AND "leaseExpiresAt" > clock_timestamp() AND "interruptRequestedAt" IS NOT NULL) RETURNING "id"`, [task.id, lease.userId, lease.sessionId, lease.turnId, now, lease.id, lease.ownerId, lease.attemptCount])
    if (updated.rowCount !== 1) return { status: "conflict" }
    await client.query(`INSERT INTO "application_task_events" ("id", "taskId", "type", "actor", "body", "data", "createdAt") VALUES ($1, $2, 'fill_cancelled', 'worker', $3, $4::jsonb, $5)`, [randomUUID(), task.id, CANCELLED_FILL_BODY, JSON.stringify({ turnId: lease.turnId }), now])
    return { status: "cancelled" }
  })
}

async function inTransaction<T>(pool: Pool, userId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN"); await client.query("SELECT set_config($1, $2, true)", ["app.user_id", userId])
    const result = await work(client); await client.query("COMMIT"); committed = true; return result
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

function submissionPayload(task: ApplicationRow) {
  return { applicationTaskId: task.id, jobId: task.jobId, resumeId: task.resumeId, coverLetterId: task.coverLetterId }
}

function exactSubmissionPayload(value: unknown, expected: ReturnType<typeof submissionPayload>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const payload = value as Record<string, unknown>
  return Object.getPrototypeOf(value) === Object.prototype && Object.keys(payload).sort().join(",") === "applicationTaskId,coverLetterId,jobId,resumeId"
    && payload.applicationTaskId === expected.applicationTaskId && payload.jobId === expected.jobId && payload.resumeId === expected.resumeId && payload.coverLetterId === expected.coverLetterId
}

function date(value: Date | string | null): Date | undefined { if (!value) return undefined; const parsed = value instanceof Date ? value : new Date(value); return Number.isFinite(parsed.getTime()) ? parsed : undefined }

async function existingCompletion(client: Client, lease: SubagentLease, task: ApplicationRow, turn: TurnRow, approvedOnly = false): Promise<boolean> {
  const payload = submissionPayload(task), turnId = lease.turnId
  if (!turnId) return false
  const answersHash = await hashAgentReceiptValue("answers", task.confirmedAnswers ?? null)
  const materialHash = await hashAgentReceiptValue("material", payload)
  const artifactContent = { schemaVersion: "agent-harness.application-submission.v1", ...payload, answersHash }
  let artifactHash: string
  try { artifactHash = hashArtifactContent(artifactContent) } catch { return false }
  const artifactId = `application:${task.id}`, taskRef = `application-task:${task.id}`
  const artifacts = await client.query<ExistingArtifactRow>(`SELECT "id", "userId", "jobId", "artifactType", "lifecycle", "baseId", "baseHash", "content", "hash", "constraintHash", "provenanceRefs", "evidenceRefs", "previousHash", "version" FROM "agent_artifact" WHERE "id" = $1 AND "userId" = $2`, [artifactId, lease.userId])
  const artifact = artifacts.rows[0]
  let contentHash: string | undefined
  try { if (artifact) contentHash = hashArtifactContent(artifact.content) } catch { return false }
  const refsMatch = (value: unknown) => Array.isArray(value) && value.length === 1 && value[0] === taskRef
  if (!artifact || artifact.id !== artifactId || artifact.userId !== lease.userId || artifact.jobId !== task.jobId
    || artifact.artifactType !== "application" || artifact.lifecycle !== "base" || artifact.baseId !== artifactId
    || artifact.baseHash !== artifactHash || artifact.hash !== artifactHash || artifact.constraintHash !== hashArtifactContent({ applicationTaskId: task.id, jobId: task.jobId })
    || !refsMatch(artifact.provenanceRefs) || !refsMatch(artifact.evidenceRefs) || artifact.previousHash !== null || artifact.version !== 1
    || contentHash !== artifactHash) return false
  const found = await client.query<ExistingApprovalRow>(`SELECT "id", "userId", "sessionId", "turnId", "jobId", "type", "taskId", "status", "toolCallId", "payload", "resourceHash", "materialHash", "answersHash", "scopeHash", "nonceHash", "revision", "expiresAt" FROM "agent_approvals" WHERE "id" = $1 AND "userId" = $2 AND "status" IN ('pending', 'approved')`, [`application-fill:${task.id}:${turnId}`, lease.userId])
  const approval = found.rows[0], expiresAt = approval && date(approval.expiresAt)
  if (found.rows.length !== 1 || !approval || !expiresAt || !approval.nonceHash || !approval.scopeHash
    || !["pending", "approved"].includes(approval.status) || (approvedOnly && approval.status !== "approved")
    || approval.userId !== lease.userId || approval.sessionId !== lease.sessionId || approval.turnId !== turnId
    || approval.jobId !== task.jobId || approval.taskId !== lease.id || approval.type !== "submit_application"
    || approval.toolCallId !== `application-submit:${task.id}` || approval.resourceHash !== artifactHash
    || approval.materialHash !== materialHash || approval.answersHash !== answersHash || !exactSubmissionPayload(approval.payload, payload)
    || !Number.isSafeInteger(approval.revision) || approval.revision + 1 !== turn.revision) return false
  const scope: ApprovalScopeInput = { userId: approval.userId, sessionId: approval.sessionId, turnId, jobId: task.jobId,
    toolCallId: `application-submit:${task.id}`, action: "submit_application", resourceHash: artifactHash, materialHash, answersHash, revision: approval.revision, expiresAt }
  return await hashApprovalScope(protocolScope(scope, approval.nonceHash)) === approval.scopeHash
}

/** Commits the review checkpoint, immutable manifest, approval, Turn wait, and Session projection together. */
export async function completeApplicationFillForReview(pool: Pool, input: { readonly lease: SubagentLease; readonly now?: Date }): Promise<FillStatus> {
  const { lease } = input, now = input.now ?? new Date()
  if (!validLease(lease, now) || !lease.turnId) return { status: "stale" }
  const turnId = lease.turnId
  return inTransaction(pool, lease.userId, async client => {
    const locked = await lockFillScope(client, lease, now)
    if (!locked) return { status: "stale" }
    const { turn, task } = locked
    const awaitingApproval = task.status === "waiting_for_authorization" && task.checkpoint === "form_filled", authorizedForSubmission = task.status === "filling" && task.checkpoint === "submission_authorized", queueRetry = task.status === "waiting_for_authorization" && task.checkpoint === "queue_retry"
    if (awaitingApproval || authorizedForSubmission || queueRetry) return turn.status === "waiting_for_approval"
      ? { status: await existingCompletion(client, lease, task, turn, authorizedForSubmission || queueRetry) ? "completed" : "conflict" } : { status: "conflict" }
    if (task.status !== "filling" || task.checkpoint !== "browser_active" || turn.status !== "in_progress") return { status: "conflict" }
    const transitioned = await client.query(`UPDATE "application_tasks" SET "status" = 'waiting_for_authorization', "checkpoint" = 'form_filled', "error" = NULL, "updatedAt" = $4 WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3 AND "status" = 'filling' AND "checkpoint" = 'browser_active' RETURNING "id"`, [task.id, lease.userId, lease.sessionId, now])
    if (transitioned.rowCount !== 1) return { status: "conflict" }
    await client.query(`INSERT INTO "application_task_events" ("id", "taskId", "type", "actor", "body", "data", "createdAt")
      VALUES ($1, $2, 'form_filled', 'worker', $3, $4::jsonb, $5)`, [randomUUID(), task.id, "Form filled without submission; final user authorization requested.", JSON.stringify({ turnId: lease.turnId }), now])
    const answersHash = await hashAgentReceiptValue("answers", task.confirmedAnswers ?? null)
    const artifact = await ensureSubmissionArtifactWithClient(client, { applicationTaskId: task.id, userId: lease.userId, jobId: task.jobId, resumeId: task.resumeId, coverLetterId: task.coverLetterId, answersHash })
    const payload = submissionPayload(task)
    const approvalInput: IssueApprovalReceiptInput = { approvalId: `application-fill:${task.id}:${turnId}`, taskId: lease.id,
      scope: { userId: lease.userId, sessionId: lease.sessionId, turnId, jobId: task.jobId, toolCallId: `application-submit:${task.id}`, action: "submit_application", resourceHash: artifact.hash,
        materialHash: await hashAgentReceiptValue("material", payload), answersHash, revision: turn.revision, expiresAt: new Date(now.getTime() + 15 * 60 * 1000) },
      title: COMPLETION_TITLE, body: COMPLETION_BODY, impact: { externalSubmission: true, jobId: task.jobId }, payload, nonce: createApprovalNonce() }
    const receipt = await createPgApprovalStore(pool, { userId: lease.userId }).issueInTransaction(client, approvalInput)
    await client.query(`INSERT INTO "agent_transcript_events" ("id", "sessionId", "taskId", "type", "speaker", "title", "body", "data", "createdAt") VALUES ($1, $2, NULL, 'approval_request', 'Executor', $3, $4, jsonb_build_object('approval', jsonb_build_object('id', $5::text, 'type', 'submit_application', 'title', $3::text, 'body', $4::text, 'impact', jsonb_build_object('externalSubmission', true, 'jobId', $6::text), 'payload', $7::jsonb, 'scopeHash', $8::text, 'status', 'pending')), $9)`, [randomUUID(), lease.sessionId, COMPLETION_TITLE, COMPLETION_BODY, receipt.approval.id, task.jobId, JSON.stringify(payload), receipt.approval.scopeHash, now])
    await client.query(`UPDATE "agent_sessions" SET "status" = 'waiting_for_user', "completedAt" = NULL, "updatedAt" = $2 WHERE "id" = $1 AND "userId" = $3`, [lease.sessionId, now, lease.userId])
    return { status: "completed" }
  })
}

const SAFE_PRESTART_FAILURE = "Application fill could not start after the final retry attempt."

/** Fails only an exhausted, lease-fenced fill that has not started browser work. */
export async function failApplicationFillBeforeBrowser(pool: Pool, input: { readonly lease: SubagentLease; readonly now?: Date }): Promise<FillStatus> {
  const { lease } = input, now = input.now ?? new Date()
  if (!validLease(lease, now) || !lease.turnId || !Number.isSafeInteger(lease.maxAttempts) || lease.maxAttempts < 1) return { status: "stale" }
  if (lease.attemptCount < lease.maxAttempts) return { status: "conflict" }
  return inTransaction(pool, lease.userId, async client => {
    const locked = await lockFillScope(client, lease, now)
    if (!locked) return { status: "stale" }
    const { turn, task } = locked
    if (task.status !== "filling" || task.checkpoint !== "taskgraph_fill_queued" || turn.status !== "in_progress") return { status: "conflict" }
    const updated = await client.query(`UPDATE "application_tasks" SET "status" = 'failed', "checkpoint" = 'fill_prestart_failed', "error" = $4, "updatedAt" = $5 WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3 AND "status" = 'filling' AND "checkpoint" = 'taskgraph_fill_queued' RETURNING "id"`, [task.id, lease.userId, lease.sessionId, SAFE_PRESTART_FAILURE, now])
    if (updated.rowCount !== 1) return { status: "conflict" }
    await client.query(`INSERT INTO "application_task_events" ("id", "taskId", "type", "actor", "body", "data", "createdAt") VALUES ($1, $2, 'fill_prestart_failed', 'worker', $3, $4::jsonb, $5)`, [randomUUID(), task.id, SAFE_PRESTART_FAILURE, JSON.stringify({ turnId: lease.turnId, attemptCount: lease.attemptCount, maxAttempts: lease.maxAttempts }), now])
    return { status: "failed" }
  })
}

function waitMessage(detail: WaitDetail): string {
  const messages: Record<WaitDetail, string> = {
    captcha_required: "A site challenge requires your action before the fill can continue.", authentication_required: "Sign in to the application site before the fill can continue.",
    mfa_required: "Complete the verification step before the fill can continue.", unknown_sensitive_field: "Review and confirm the sensitive application fields before the fill can continue.",
    required_field: "Provide the missing required application information before the fill can continue.", stale_review: "The application changed during review. Review the current form before continuing.",
    review_required: "Review the filled application before continuing.", fill_outcome_uncertain: "The browser stopped after starting the fill. This fill does not submit the application. Stop this Turn before requesting another fill attempt.",
    unattended_apply_unavailable: "Unattended form fill is unavailable. Review the application manually.", cancelled: "The application fill was cancelled.",
    browser_fill_failed: "The application form could not be filled. Review it manually before continuing.",
  }
  return messages[detail]
}

function safeNeeds(needs?: FormReviewNeeds): FormReviewNeeds {
  const clean = (fields: FormReviewNeeds["missing"] | undefined) => (fields ?? []).slice(0, 10).map(({ key, label }) => ({
    key: key && isFormAnswerKeyV2(key) ? key : null,
    label: redactSensitiveText(label).slice(0, 200),
  }))
  return { missing: clean(needs?.missing), sensitive: clean(needs?.sensitive) }
}

/** Persists an application-specific wait without using the legacy unfenced pause path. */
export async function persistApplicationFillWait(
  pool: Pool, input: { readonly lease: SubagentLease; readonly checkpoint: WaitCheckpoint; readonly detail: string; readonly needs?: FormReviewNeeds; readonly now?: Date },
): Promise<FillStatus> {
  const { lease } = input, now = input.now ?? new Date(), detail = input.detail as WaitDetail
  if (!validLease(lease, now) || !lease.turnId || !SAFE_WAIT_DETAILS.has(detail)) return { status: "stale" }
  return inTransaction(pool, lease.userId, async client => {
    const locked = await lockFillScope(client, lease, now)
    if (!locked) return { status: "stale" }
    const { turn, task } = locked
    const expectedCheckpoint = input.checkpoint
    if (task.status === "waiting_for_user" && task.checkpoint === expectedCheckpoint) return { status: "waiting" }
    if (task.status !== "filling" || task.checkpoint !== "browser_active" || !["in_progress", "waiting_for_user"].includes(turn.status)) return { status: "conflict" }
    const needs = safeNeeds(input.needs), message = waitMessage(detail)
    const checkpoint: WaitCheckpoint = detail === "fill_outcome_uncertain" ? "fill_outcome_uncertain" : expectedCheckpoint
    const question = checkpoint === "form_answer_required" ? { waitId: randomUUID(), detail: message, missing: needs.missing, sensitive: needs.sensitive } : null
    const updated = await client.query(`UPDATE "application_tasks" SET "status" = 'waiting_for_user', "checkpoint" = $4, "error" = $5,
      "question" = $6::jsonb, "updatedAt" = $7 WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3
      AND "status" = 'filling' AND "checkpoint" = 'browser_active' RETURNING "id"`,
    [task.id, lease.userId, lease.sessionId, checkpoint, message, JSON.stringify(question), now])
    if (updated.rowCount !== 1) return { status: "conflict" }
    await client.query(`INSERT INTO "application_task_events" ("id", "taskId", "type", "actor", "body", "data", "createdAt")
      VALUES ($1, $2, $3, 'worker', $4, $5::jsonb, $6)`, [randomUUID(), task.id, checkpoint, message,
      JSON.stringify({ reason: detail, missingCount: needs.missing.length, sensitiveCount: needs.sensitive.length, turnId: lease.turnId, attemptCount: lease.attemptCount }), now])
    await client.query(`INSERT INTO "agent_transcript_events" ("id", "sessionId", "taskId", "type", "speaker", "title", "body", "data", "createdAt")
      VALUES ($1, $2, NULL, 'subagent_result', 'Executor', 'Application fill needs your attention', $3, $4::jsonb, $5)`,
    [randomUUID(), lease.sessionId, message, JSON.stringify({ applicationTaskId: task.id, checkpoint, turnId: lease.turnId }), now])
    const turnUpdate = await client.query(`UPDATE "agent_turns" SET "status" = 'waiting_for_user', "revision" = "revision" + 1,
      "completedAt" = NULL, "updatedAt" = $4 WHERE "id" = $1 AND "sessionId" = $2 AND "revision" = $3
      AND "status" IN ('in_progress', 'waiting_for_user') RETURNING "id"`, [lease.turnId, lease.sessionId, turn.revision, now])
    if (turnUpdate.rowCount !== 1) return { status: "conflict" }
    await client.query(`UPDATE "agent_sessions" SET "status" = 'waiting_for_user', "completedAt" = NULL, "updatedAt" = $2 WHERE "id" = $1 AND "userId" = $3`, [lease.sessionId, now, lease.userId])
    return { status: "waiting" }
  })
}
