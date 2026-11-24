import { randomUUID } from "node:crypto"
import type { PoolClient } from "pg"
import { hashApprovalScope, isApprovalHash } from "@jobcopilot/agent-protocol"
import type { ReviewedApplicationMaterialProof } from "@jobcopilot/shared"
import { protocolScope, type ApprovalScopeInput } from "./approval/types.js"
import type { TurnLease } from "./turns/lease.js"

export const REVIEW_BINDING_SCHEMA = "agent-harness.v2.reviewed-application-review-binding.v1"
export const REVIEW_BINDING_EVENT = "reviewed_application_review_issued"
const REVIEW_BINDING_BODY = "Reviewed application approval binding recorded."
const SHA256 = /^sha256:[a-f0-9]{64}$/
type Queryable = Pick<PoolClient, "query">
type Row = Record<string, unknown>

export type ReviewReceiptScope = Readonly<{
  action: "review_application"; toolCallId: string; resourceHash: string; materialHash: string; answersHash: string
  revision: number; expiresAt: string
}>
export type ReviewedApplicationReviewBinding = Readonly<{
  schemaVersion: typeof REVIEW_BINDING_SCHEMA; approvalId: string; reviewTurnId: string; applicationTaskId: string
  userId: string; sessionId: string; jobId: string; proof: ReviewedApplicationMaterialProof; receiptScope: ReviewReceiptScope
}>
export type ReviewApprovalHashes = Readonly<{ resourceHash: string; materialHash: string; answersHash: string }>
export type ReviewReplayDecision = Readonly<{ status: "waiting" | "approved" | "rejected"; approvalId: string; waitItemId: string }>

/** Create one ready ApplicationTask or reuse only its untouched same-Session review state. */
export async function lockOrCreateReviewedApplicationTask(
  client: Queryable, input: { userId: string; sessionId: string; jobId: string; resumeId: string; now: Date },
): Promise<string | null> {
  await client.query(`INSERT INTO "application_tasks" ("id", "userId", "jobId", "sessionId", "resumeId", "status", "checkpoint", "updatedAt")
    VALUES ($1,$2,$3,$4,$5,'waiting_for_user','materials_ready',$6) ON CONFLICT ("userId","jobId") DO NOTHING`,
  [randomUUID(), input.userId, input.jobId, input.sessionId, input.resumeId, input.now])
  const result = await client.query(`SELECT "id", "userId", "sessionId", "jobId", "status", "checkpoint", "workerTaskId",
      "fillTurnId", "fillTurnSessionId", "fillTurnUserId", "resumeId", "startedAt", "completedAt"
    FROM "application_tasks" WHERE "userId"=$1 AND "jobId"=$2 FOR UPDATE`, [input.userId, input.jobId])
  if (result.rows.length !== 1) return null
  const row = record(result.rows[0])
  return row && safeReadyTask(row, input) && text(row.id, 256) ? row.id : null
}

export async function lockRejectedReviewTask(client: Queryable, input: { userId: string; sessionId: string; jobId: string; taskId: string }): Promise<boolean> {
  const result = await client.query(`SELECT "id", "userId", "sessionId", "jobId", "status", "checkpoint", "workerTaskId", "fillTurnId",
      "fillTurnSessionId", "fillTurnUserId", "startedAt", "completedAt" FROM "application_tasks"
    WHERE "id"=$1 AND "userId"=$2 AND "sessionId"=$3 AND "jobId"=$4 FOR UPDATE`,
  [input.taskId, input.userId, input.sessionId, input.jobId])
  const row = record(result.rows[0])
  return result.rows.length === 1 && row?.id === input.taskId && row.userId === input.userId
    && row.sessionId === input.sessionId && row.jobId === input.jobId && row.status === "waiting_for_user"
    && row.checkpoint === "materials_ready" && row.workerTaskId === null && row.fillTurnId === null
    && row.fillTurnSessionId === null && row.fillTurnUserId === null && row.startedAt === null && row.completedAt === null
}

/** Persist only private proof identity and the canonical immutable approval scope; never content or nonce. */
export async function writeReviewedApplicationReviewBinding(
  client: Queryable, binding: ReviewedApplicationReviewBinding, now: Date,
): Promise<void> {
  await client.query(`INSERT INTO "application_task_events" ("id", "taskId", "type", "actor", "body", "data", "createdAt")
    VALUES ($1,$2,$3,'worker',$4,$5::jsonb,$6)`,
  [randomUUID(), binding.applicationTaskId, REVIEW_BINDING_EVENT, REVIEW_BINDING_BODY, JSON.stringify(binding), now])
}

/** Read exactly one schema-valid private proof binding for same-Turn replay. */
export async function readReviewedApplicationReviewBinding(
  client: Queryable, applicationTaskId: string, reviewTurnId: string,
): Promise<ReviewedApplicationReviewBinding | null> {
  const result = await client.query(`SELECT "taskId", "type", "actor", "body", "data" FROM "application_task_events"
    WHERE "taskId"=$1 AND "type"=$2 AND "data"->>'reviewTurnId'=$3 LIMIT 2`,
  [applicationTaskId, REVIEW_BINDING_EVENT, reviewTurnId])
  if (result.rows.length !== 1) return null
  const row = record(result.rows[0]), binding = parseBinding(row?.data)
  return row?.taskId === applicationTaskId && row.type === REVIEW_BINDING_EVENT && row.actor === "worker"
    && row.body === REVIEW_BINDING_BODY && binding?.applicationTaskId === applicationTaskId
    && binding.reviewTurnId === reviewTurnId ? binding : null
}
export async function loadReviewedApplicationReviewApproval(client: Queryable, approvalId: string, lease: TurnLease): Promise<unknown[]> {
  return (await client.query(`SELECT * FROM "agent_approvals" WHERE "id"=$1 AND "userId"=$2 AND "sessionId"=$3 AND "turnId"=$4 LIMIT 2 FOR UPDATE`,
    [approvalId, lease.userId, lease.sessionId, lease.turnId])).rows
}
export async function hasReviewedApplicationReviewBinding(client: Queryable, taskId: string, turnId: string): Promise<boolean> {
  const result = await client.query(`SELECT "id" FROM "application_task_events" WHERE "taskId"=$1 AND "type"=$2
    AND "data"->>'reviewTurnId'=$3 LIMIT 2`, [taskId, REVIEW_BINDING_EVENT, turnId])
  return result.rows.length !== 0
}
/** Validate the current receipt and Wait against the immutable proof binding; nonce rotation remains supported. */
export async function readReviewedApplicationReviewReplay(client: Queryable, input: {
  value: unknown; lease: TurnLease; intent: { jobId: string; sourceTurnId: string }; proof: ReviewedApplicationMaterialProof
  applicationTaskId: string; approvalId: string; toolCallId: string; hashes: ReviewApprovalHashes; title: string; body: string; now: Date
}): Promise<ReviewReplayDecision | null> {
  const row = record(input.value), expiresAt = date(row?.expiresAt), decidedAt = date(row?.decidedAt), revision = row?.revision
  if (!row || !expiresAt || !Number.isSafeInteger(revision) || Number(revision) < 0 || row.id !== input.approvalId
    || row.userId !== input.lease.userId || row.sessionId !== input.lease.sessionId || row.turnId !== input.lease.turnId
    || row.taskId !== input.applicationTaskId || row.jobId !== input.intent.jobId || row.toolCallId !== input.toolCallId
    || row.type !== "review_application" || row.resourceHash !== input.hashes.resourceHash
    || row.materialHash !== input.hashes.materialHash || row.answersHash !== input.hashes.answersHash
    || !isApprovalHash(row.scopeHash) || !isApprovalHash(row.nonceHash) || row.consumedAt !== null
    || !sameJson(row.payload, { applicationTaskId: input.applicationTaskId, jobId: input.intent.jobId })
    || !sameJson(row.impact, { externalSubmission: false, jobId: input.intent.jobId })
    || row.title !== input.title || row.body !== input.body) return null
  const status = row.status
  if (status !== "pending" && status !== "approved" && status !== "rejected") return null
  if ((status === "pending" && (decidedAt || expiresAt <= input.now)) || (status !== "pending" && !decidedAt)) return null
  const savedBinding = await readReviewedApplicationReviewBinding(client, input.applicationTaskId, input.lease.turnId)
  const receiptScope = scopeInput(input.lease, input.intent, input.toolCallId, input.hashes, Number(revision), expiresAt)
  const expected: ReviewedApplicationReviewBinding = {
    schemaVersion: REVIEW_BINDING_SCHEMA, approvalId: input.approvalId, reviewTurnId: input.lease.turnId,
    applicationTaskId: input.applicationTaskId, userId: input.lease.userId, sessionId: input.lease.sessionId,
    jobId: input.intent.jobId, proof: input.proof,
    receiptScope: { action: "review_application", toolCallId: input.toolCallId, ...input.hashes,
      revision: Number(revision), expiresAt: expiresAt.toISOString() },
  }
  if (!savedBinding || !sameReviewedApplicationReviewBinding(savedBinding, expected)
    || row.scopeHash !== await hashApprovalScope(protocolScope(receiptScope, String(row.nonceHash)))) return null
  if (!await validReviewEvents(client, input.lease, input.applicationTaskId, row)
    || !await validReviewWait(client, input.lease, row, status, decidedAt, input.title, input.body)) return null
  return { status: status === "pending" ? "waiting" : status, approvalId: input.approvalId,
    waitItemId: `agent-wait:approval:${input.approvalId}` }
}

/** Reconcile a terminal rejection from its immutable proof binding even if current source material disappeared. */
export async function readRejectedReviewedApplicationReview(client: Queryable, input: {
  value: unknown; lease: TurnLease; intent: { jobId: string; sourceTurnId: string }; applicationTaskId: string
  approvalId: string; toolCallId: string; title: string; body: string
}): Promise<ReviewReplayDecision | null> {
  const row = record(input.value), expiresAt = date(row?.expiresAt), decidedAt = date(row?.decidedAt), binding =
    await readReviewedApplicationReviewBinding(client, input.applicationTaskId, input.lease.turnId)
  if (!row || !expiresAt || !decidedAt || row.id !== input.approvalId || row.status !== "rejected" || row.consumedAt !== null
    || row.userId !== input.lease.userId || row.sessionId !== input.lease.sessionId || row.turnId !== input.lease.turnId
    || row.taskId !== input.applicationTaskId || row.jobId !== input.intent.jobId || row.toolCallId !== input.toolCallId
    || row.type !== "review_application" || !isApprovalHash(row.nonceHash) || !isApprovalHash(row.scopeHash)
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0
    || !sameJson(row.payload, { applicationTaskId: input.applicationTaskId, jobId: input.intent.jobId })
    || !sameJson(row.impact, { externalSubmission: false, jobId: input.intent.jobId }) || row.title !== input.title || row.body !== input.body
    || !binding || binding.schemaVersion !== REVIEW_BINDING_SCHEMA || binding.approvalId !== input.approvalId
    || binding.reviewTurnId !== input.lease.turnId || binding.applicationTaskId !== input.applicationTaskId
    || binding.userId !== input.lease.userId || binding.sessionId !== input.lease.sessionId || binding.jobId !== input.intent.jobId
    || binding.proof.jobId !== input.intent.jobId || binding.proof.sourceTurnId !== input.intent.sourceTurnId) return null
  const saved = binding.receiptScope
  if (saved.action !== "review_application" || saved.toolCallId !== input.toolCallId || saved.resourceHash !== row.resourceHash
    || saved.materialHash !== row.materialHash || saved.answersHash !== row.answersHash || saved.revision !== row.revision
    || saved.expiresAt !== expiresAt.toISOString()) return null
  const scope = { userId: input.lease.userId, sessionId: input.lease.sessionId, turnId: input.lease.turnId, jobId: input.intent.jobId,
    toolCallId: input.toolCallId, action: "review_application" as const, resourceHash: saved.resourceHash,
    materialHash: saved.materialHash, answersHash: saved.answersHash, revision: Number(row.revision), expiresAt }
  if (row.scopeHash !== await hashApprovalScope(protocolScope(scope, String(row.nonceHash)))
    || !await validReviewEvents(client, input.lease, input.applicationTaskId, row)
    || !await validReviewWait(client, input.lease, row, "rejected", decidedAt, input.title, input.body)) return null
  return { status: "rejected", approvalId: input.approvalId, waitItemId: `agent-wait:approval:${input.approvalId}` }
}
export function sameReviewedApplicationReviewBinding(
  left: ReviewedApplicationReviewBinding, right: ReviewedApplicationReviewBinding,
): boolean {
  return stableJson(left) === stableJson(right)
}

function scopeInput(lease: TurnLease, intent: { jobId: string }, toolCallId: string, hashes: ReviewApprovalHashes,
  revision: number, expiresAt: Date): ApprovalScopeInput {
  return { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, jobId: intent.jobId, toolCallId,
    action: "review_application", ...hashes, revision, expiresAt }
}
async function validReviewEvents(client: Queryable, lease: TurnLease, taskId: string, approval: Row): Promise<boolean> {
  const request = await readAuditEvent(client, lease, "approval.requested", `approval:${String(approval.id)}:requested`)
  const event = record(request[0]), payload = record(event?.payload)
  if (request.length !== 1 || !event || !payload || !exactKeys(payload, "action,approvalId,revision,scopeHash")
    || event.sessionId !== lease.sessionId || event.turnId !== lease.turnId || event.taskId !== taskId
    || event.itemId !== null || event.type !== "approval.requested" || event.actor !== "orchestrator"
    || event.correlationId !== approval.id || event.idempotencyKey !== `approval:${String(approval.id)}:requested`
    || payload.approvalId !== approval.id || payload.action !== "review_application" || payload.revision !== approval.revision
    || !isApprovalHash(payload.scopeHash)) return false
  const waitId = `agent-wait:approval:${String(approval.id)}`
  const started = await readAuditEvent(client, lease, "item.started", `agent-wait:${waitId}:started`)
  const startEvent = record(started[0]), startPayload = record(startEvent?.payload)
  return started.length === 1 && Boolean(startEvent && startPayload && exactKeys(startPayload, "approvalId,itemId,toolCallId,waitKind")
    && startEvent.sessionId === lease.sessionId && startEvent.turnId === lease.turnId && startEvent.taskId === taskId
    && startEvent.itemId === waitId && startEvent.type === "item.started" && startEvent.actor === "orchestrator"
    && startEvent.correlationId === waitId && startEvent.idempotencyKey === `agent-wait:${waitId}:started`
    && startPayload.approvalId === approval.id && startPayload.itemId === waitId
    && startPayload.toolCallId === approval.toolCallId && startPayload.waitKind === "approval")
}
async function readAuditEvent(client: Queryable, lease: TurnLease, type: string, key: string): Promise<unknown[]> {
  return (await client.query(`SELECT "id", "sessionId", "turnId", "itemId", "taskId", "type", "actor", "correlationId", "idempotencyKey", "payload"
    FROM "agent_events" WHERE "sessionId"=$1 AND "turnId"=$2 AND "type"=$3 AND "idempotencyKey"=$4 LIMIT 2`,
  [lease.sessionId, lease.turnId, type, key])).rows
}
async function validReviewWait(client: Queryable, lease: TurnLease, approval: Row, status: string,
  decidedAt: Date | null, title: string, body: string): Promise<boolean> {
  const id = `agent-wait:approval:${String(approval.id)}`
  const result = await client.query(`SELECT "id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "completedAt"
    FROM "agent_items" WHERE "id"=$1 AND "sessionId"=$2 AND "turnId"=$3 LIMIT 2`, [id, lease.sessionId, lease.turnId])
  if (result.rows.length !== 1) return false
  const item = record(result.rows[0]), content = record(item?.content), expiry = date(approval.expiresAt), resolved = status !== "pending"
  const keys = resolved ? "action,approvalId,body,decision,expiresAt,impact,receiptRevision,respondedAt,responseAvailable,scopeHash,title,toolCallId,waitKind"
    : "action,approvalId,body,decision,expiresAt,impact,receiptRevision,scopeHash,title,toolCallId,waitKind"
  if (!item || !content || !expiry || !exactKeys(content, keys) || item.id !== id || item.sessionId !== lease.sessionId
    || item.turnId !== lease.turnId || item.stepId !== null || item.taskId !== null || item.type !== "approval_request"
    || item.phase !== "commentary" || !date(item.startedAt) || item.revision !== (resolved ? 1 : 0)
    || item.status !== (resolved ? "completed" : "started") || (resolved ? !date(item.completedAt) : item.completedAt !== null)
    || content.waitKind !== "approval" || content.approvalId !== approval.id || content.toolCallId !== approval.toolCallId
    || content.action !== "review_application" || content.title !== title || content.body !== body
    || !sameJson(content.impact, { externalSubmission: false, jobId: String(approval.jobId) })
    || content.scopeHash !== approval.scopeHash || content.receiptRevision !== approval.revision
    || content.expiresAt !== expiry.toISOString()) return false
  return resolved ? content.decision === status && content.responseAvailable === true && decidedAt !== null
    && content.respondedAt === decidedAt.toISOString() : content.decision === null
}
function safeReadyTask(row: Row, input: { userId: string; sessionId: string; jobId: string; resumeId: string }): boolean {
  return row.userId === input.userId && row.sessionId === input.sessionId && row.jobId === input.jobId
    && row.resumeId === input.resumeId
    && row.status === "waiting_for_user" && row.checkpoint === "materials_ready" && row.workerTaskId === null
    && row.fillTurnId === null && row.fillTurnSessionId === null && row.fillTurnUserId === null
    && row.startedAt === null && row.completedAt === null
}
function parseBinding(value: unknown): ReviewedApplicationReviewBinding | null {
  const row = record(value), scope = record(row?.receiptScope)
  const proof = parseProof(row?.proof)
  if (!row || !scope || !proof || !exactKeys(row, "applicationTaskId,approvalId,jobId,proof,receiptScope,reviewTurnId,schemaVersion,sessionId,userId")
    || !exactKeys(scope, "action,answersHash,expiresAt,materialHash,resourceHash,revision,toolCallId")
    || row.schemaVersion !== REVIEW_BINDING_SCHEMA || ![row.userId, row.sessionId, row.reviewTurnId, row.applicationTaskId, row.jobId, row.approvalId].every(value => text(value, 256))
    || !proof || proof.jobId !== row.jobId
    || scope.action !== "review_application" || !text(scope.toolCallId, 256)
    || ![scope.resourceHash, scope.materialHash, scope.answersHash].every(isApprovalHash)
    || !Number.isSafeInteger(scope.revision) || Number(scope.revision) < 0 || typeof scope.expiresAt !== "string" || !Number.isFinite(Date.parse(scope.expiresAt))) return null
  return row as unknown as ReviewedApplicationReviewBinding
}
function parseProof(value: unknown): ReviewedApplicationMaterialProof | null {
  const proof = record(value)
  if (!proof || !exactKeys(proof, "artifactId,contentHash,graphRevision,jobId,reviewHash,reviewerTaskId,reviewerToolCallId,rootTaskId,sourceDigest,sourceTurnId,version,writerTaskId")
    || ![proof.jobId, proof.sourceTurnId, proof.rootTaskId, proof.writerTaskId, proof.reviewerTaskId, proof.reviewerToolCallId, proof.artifactId].every(value => text(value, 256))
    || !Number.isSafeInteger(proof.graphRevision) || Number(proof.graphRevision) < 1 || !Number.isSafeInteger(proof.version) || Number(proof.version) < 1
    || ![proof.reviewHash, proof.contentHash, proof.sourceDigest].every(value => typeof value === "string" && SHA256.test(value))) return null
  return proof as unknown as ReviewedApplicationMaterialProof
}
function record(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return (prototype === Object.prototype || prototype === null)
    && Object.getOwnPropertySymbols(parsed).length === 0 ? parsed as Row : null } catch { return null }
}
function exactKeys(value: Row, keys: string): boolean { return Object.keys(value).sort().join(",") === keys }
function text(value: unknown, limit: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= limit }
function date(value: unknown): Date | null {
  const parsed = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null
}
function sameJson(left: unknown, right: unknown): boolean { return stableJson(left) === stableJson(right) }
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  const row = value as Row
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(",")}}`
}
