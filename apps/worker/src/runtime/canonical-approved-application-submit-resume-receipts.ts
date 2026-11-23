import { createHash } from "node:crypto"
import type { PoolClient } from "pg"
import { hashApprovalScope } from "@jobcopilot/agent-protocol"
import {
  buildApplicationSubmissionManifest, hashAgentReceiptValue, hashApplicationSubmissionMaterial, matchesApplyTaskSubmitPayload,
  type ApplicationSubmissionMaterial,
} from "@jobcopilot/shared"
import { verifyExistingApplicationFillCompletion, type ApplicationRow } from "../db/application-task-completion.js"
import { protocolScope } from "./approval/types.js"
import { hashArtifactContent } from "./subagents/artifact-adapters.js"
import type { TurnLease } from "./turns/lease.js"

type Client = Pick<PoolClient, "query">; type Row = Record<string, unknown>
type Task = ApplicationRow & { workerTaskId: string | null; question: unknown }
export type CanonicalApprovedApplicationSubmitReceipts = Readonly<{
  resourceHash: string; materialHash: string; answersHash: string; scopeHash: string; approvalRevision: number
  state: "form_filled" | "submission_authorized"; workerTaskId: string | null; outboxId: string | null
}>
type Input = Readonly<{ lease: TurnLease; task: Task; material: ApplicationSubmissionMaterial; now: Date; turnRevision: number }>
const WAIT_TITLE = "Final submission authorization"
const WAIT_BODY = "The form was filled without submission. Review the current job, material alignment, required answers, and sensitive declarations before authorizing an external submission."
const HEX = /^[a-f0-9]{64}$/

/** Verifies the immutable submission receipt and either its absent or committed queue intent. */
export async function readCanonicalApprovedApplicationSubmitReceipts(client: Client, input: Input): Promise<CanonicalApprovedApplicationSubmitReceipts | null> {
  const { lease, task, material, now, turnRevision } = input
  const answersHash = await hashAgentReceiptValue("answers", task.confirmedAnswers ?? null)
  const materialHash = await hashApplicationSubmissionMaterial(material)
  const manifest = buildApplicationSubmissionManifest(material, answersHash)
  if (!answersHash || !materialHash || !manifest || !Number.isSafeInteger(turnRevision)) return null
  const resourceHash = hashArtifactContent(manifest).slice("sha256:".length)
  if (!HEX.test(resourceHash)) return null
  const approvalId = `application-fill:${task.id}:${lease.turnId}`, waitItemId = `agent-wait:approval:${approvalId}`
  const wait = await readApprovedWait(client, { lease, task, approvalId, waitItemId, resourceHash, materialHash, answersHash, now })
  if (!wait || turnRevision < wait.nextTurnRevision + 2
    || !await verifyExistingApplicationFillCompletion(client, lease, task, { revision: turnRevision }, true,
      "reviewedCoverLetterHash" in material ? material : undefined, wait.approvalRevision)) return null
  const base = { resourceHash, materialHash, answersHash, scopeHash: wait.scopeHash, approvalRevision: wait.approvalRevision }
  if (task.status === "waiting_for_authorization" && task.checkpoint === "form_filled" && task.workerTaskId === null) {
    const absent = await readSubmitIntent(client, { task, lease, approvalId, constraintHash: wait.scopeHash, requirePresent: false })
    if (!absent || jobState(await readJob(client, task.jobId, lease.userId)) !== "ready_to_apply") return null
    return { ...base, state: "form_filled", workerTaskId: null, outboxId: null }
  }
  if (task.status === "filling" && task.checkpoint === "submission_authorized" && validId(task.workerTaskId)) {
    const intent = await readSubmitIntent(client, { task, lease, approvalId, constraintHash: wait.scopeHash, requirePresent: true })
    if (!intent || intent.workerTaskId !== task.workerTaskId || jobState(await readJob(client, task.jobId, lease.userId)) !== "queued") return null
    return { ...base, state: "submission_authorized", workerTaskId: intent.workerTaskId, outboxId: intent.outboxId }
  }
  return null
}

async function readApprovedWait(client: Client, input: { lease: TurnLease; task: Task; approvalId: string; waitItemId: string; resourceHash: string; materialHash: string; answersHash: string; now: Date }) {
  const result = await client.query<Row>(`SELECT approval."id", approval."userId", approval."sessionId", approval."turnId", approval."taskId",
      approval."jobId", approval."type", approval."status", approval."title", approval."body", approval."impact", approval."payload",
      approval."resourceHash", approval."materialHash", approval."answersHash", approval."scopeHash", approval."nonceHash",
      approval."toolCallId", approval."revision", approval."expiresAt", approval."decidedAt", approval."consumedAt",
      item."id" AS "waitItemId", item."stepId" AS "waitStepId", item."taskId" AS "waitTaskId", item."type" AS "waitType",
      item."status" AS "waitStatus", item."phase" AS "waitPhase", item."revision" AS "waitRevision", item."content" AS "waitContent",
      resolved."actor" AS "resolvedActor", resolved."taskId" AS "resolvedTaskId", resolved."itemId" AS "resolvedItemId",
      resolved."type" AS "resolvedType", resolved."correlationId" AS "resolvedCorrelationId", resolved."payload" AS "resolvedPayload"
    FROM "agent_approvals" AS approval JOIN "application_tasks" AS app ON app."id"=approval."taskId"
      AND app."userId"=approval."userId" AND app."sessionId"=approval."sessionId" AND app."jobId"=approval."jobId"
    JOIN "agent_items" AS item ON item."id"=$2 AND item."sessionId"=approval."sessionId" AND item."turnId"=approval."turnId"
    JOIN "agent_events" AS resolved ON resolved."sessionId"=approval."sessionId" AND resolved."turnId"=approval."turnId"
      AND resolved."itemId"=item."id" AND resolved."type"='approval.resolved' AND resolved."correlationId"=approval."id"
    WHERE approval."id"=$1 AND approval."userId"=$3 AND approval."sessionId"=$4 AND approval."turnId"=$5
      AND approval."taskId"=$6 AND approval."jobId"=$7 AND item."type"='approval_request' LIMIT 2`,
  [input.approvalId, input.waitItemId, input.lease.userId, input.lease.sessionId, input.lease.turnId, input.task.id, input.task.jobId])
  if (result.rows.length !== 1) return null
  const row = result.rows[0]!, expiry = date(row.expiresAt), decided = date(row.decidedAt)
  const payload = exact(row.payload, "applicationTaskId,coverLetterId,jobId,resumeId"), impact = exact(row.impact, "externalSubmission,jobId")
  const content = exact(row.waitContent, "action,approvalId,body,decision,expiresAt,impact,receiptRevision,respondedAt,responseAvailable,scopeHash,title,toolCallId,waitKind")
  const waitImpact = exact(content?.impact, "externalSubmission,jobId")
  const event = exact(row.resolvedPayload, "answerAvailable,itemId,nextTurnRevision,status,toolCallId,turnId,waitId,waitKind")
  if (row.status !== "approved" || row.type !== "submit_application" || row.title !== WAIT_TITLE || row.body !== WAIT_BODY
    || row.toolCallId !== `application-submit:${input.task.id}` || row.resourceHash !== input.resourceHash
    || row.materialHash !== input.materialHash || row.answersHash !== input.answersHash || !HEX.test(String(row.scopeHash))
    || !HEX.test(String(row.nonceHash)) || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0
    || !expiry || expiry <= input.now || !decided || row.consumedAt != null
    || !payload || payload.applicationTaskId !== input.task.id || payload.jobId !== input.task.jobId
    || payload.resumeId !== input.task.resumeId || payload.coverLetterId !== input.task.coverLetterId
    || impact?.externalSubmission !== true || impact.jobId !== input.task.jobId
    || row.waitItemId !== input.waitItemId || row.waitStepId !== null || row.waitTaskId !== null
    || row.waitType !== "approval_request" || row.waitStatus !== "completed" || row.waitPhase !== "commentary" || Number(row.waitRevision) !== 1
    || content?.waitKind !== "approval" || content.approvalId !== row.id || content.toolCallId !== row.toolCallId
    || content.action !== "submit_application" || content.title !== WAIT_TITLE || content.body !== WAIT_BODY
    || content.scopeHash !== row.scopeHash || Number(content.receiptRevision) !== Number(row.revision)
    || content.expiresAt !== expiry.toISOString() || content.decision !== "approved" || content.responseAvailable !== true
    || content.respondedAt !== decided.toISOString() || waitImpact?.externalSubmission !== true || waitImpact.jobId !== input.task.jobId
    || row.resolvedActor !== "user" || row.resolvedTaskId !== input.task.id || row.resolvedItemId !== input.waitItemId
    || row.resolvedType !== "approval.resolved" || row.resolvedCorrelationId !== input.approvalId
    || event?.waitKind !== "approval" || event.waitId !== input.approvalId || event.itemId !== input.waitItemId
    || event.turnId !== input.lease.turnId || event.toolCallId !== row.toolCallId || event.status !== "approved"
    || event.answerAvailable !== false || !Number.isSafeInteger(event.nextTurnRevision)
    || Number(event.nextTurnRevision) !== Number(row.revision) + 2) return null
  const scope = { userId: input.lease.userId, sessionId: input.lease.sessionId, turnId: input.lease.turnId, jobId: input.task.jobId,
    toolCallId: row.toolCallId as string, action: "submit_application" as const, resourceHash: input.resourceHash,
    materialHash: input.materialHash, answersHash: input.answersHash, revision: Number(row.revision), expiresAt: expiry }
  if (await hashApprovalScope(protocolScope(scope, String(row.nonceHash))) !== row.scopeHash) return null
  return { scopeHash: String(row.scopeHash), approvalRevision: Number(row.revision), nextTurnRevision: Number(event.nextTurnRevision) }
}

async function readJob(client: Client, jobId: string, userId: string): Promise<Row | null> {
  const rows = await client.query<Row>(`SELECT "id", "status", "workflowState" FROM "Job" WHERE "id"=$1 AND "userId"=$2 LIMIT 2`, [jobId, userId])
  return rows.rows.length === 1 && rows.rows[0]!.id === jobId ? rows.rows[0]! : null
}
function jobState(value: Row | null): string | null { return value?.workflowState === "ready_to_apply" && value.status === "saved" ? "ready_to_apply" : value?.workflowState === "queued" && value.status === "saved" ? "queued" : null }

async function readSubmitIntent(client: Client, input: { task: Task; lease: TurnLease; approvalId: string; constraintHash: string; requirePresent: boolean }) {
  const digest = createHash("sha256").update(JSON.stringify([input.task.id, input.lease.turnId, input.approvalId])).digest("hex")
  const workerTaskId = `apply-submit-${digest}`, outboxId = `application-submit-outbox-${digest}`, idempotencyKey = `application-submit:${digest}`
  const [events, outboxes] = await Promise.all([
    client.query<Row>(`SELECT "actor", "body", "data" FROM "application_task_events" WHERE "taskId"=$1 AND "type"='submission_queued' LIMIT 2`, [input.task.id]),
    client.query<Row>(`SELECT "id", "topic", "aggregateId", "idempotencyKey", "payload" FROM "agent_outbox" WHERE "idempotencyKey"=$1 LIMIT 2`, [idempotencyKey]),
  ])
  if (!input.requirePresent) return events.rows.length === 0 && outboxes.rows.length === 0 ? { workerTaskId: null, outboxId: null } : null
  if (events.rows.length !== 1 || outboxes.rows.length !== 1) return null
  const event = exact(events.rows[0]!.data, "applicationTaskId,approvalId,constraintHash,fillTurnId,jobId,receiptId,sessionId,userId,workerTaskId")
  const outbox = outboxes.rows[0]!, wrapper = exact(outbox.payload, "applicationTaskId,constraintHash,fillTurnId,jobId,receiptId,sessionId,submitPayload,userId,workerTaskId")
  const submit = exact(wrapper?.submitPayload, "applicationTaskId,applyUrl,constraintHash,fillTurnId,jobId,operation,personaId,receiptId,resumePath,sessionId,userId")
  const identity = { applicationTaskId: input.task.id, jobId: input.task.jobId, userId: input.lease.userId,
    sessionId: input.lease.sessionId, fillTurnId: input.lease.turnId, receiptId: input.approvalId, constraintHash: input.constraintHash }
  if (events.rows[0]!.actor !== "user" || events.rows[0]!.body !== "User approved this job for background submission."
    || event?.applicationTaskId !== identity.applicationTaskId || event.approvalId !== input.approvalId || event.receiptId !== input.approvalId
    || event.constraintHash !== input.constraintHash || event.fillTurnId !== input.lease.turnId || event.jobId !== input.task.jobId
    || event.sessionId !== input.lease.sessionId || event.userId !== input.lease.userId || event.workerTaskId !== workerTaskId
    || outbox.id !== outboxId || outbox.topic !== "application.submit.dispatch" || outbox.aggregateId !== input.lease.sessionId
    || outbox.idempotencyKey !== idempotencyKey || wrapper?.applicationTaskId !== identity.applicationTaskId
    || wrapper.userId !== identity.userId || wrapper.jobId !== identity.jobId || wrapper.sessionId !== identity.sessionId
    || wrapper.fillTurnId !== identity.fillTurnId || wrapper.receiptId !== identity.receiptId || wrapper.constraintHash !== identity.constraintHash
    || wrapper.workerTaskId !== workerTaskId || !submit || !matchesApplyTaskSubmitPayload(submit, identity)
    || submit.personaId !== "server-side" || submit.resumePath !== "" || Object.hasOwn(submit, "dryRun") || Object.hasOwn(submit, "coverLetterPath")) return null
  return { workerTaskId, outboxId }
}

function exact(value: unknown, keys: string): Row | null { const row = object(value); return row && Object.keys(row).sort().join(",") === keys ? row : null }
function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { return Object.getPrototypeOf(parsed) === Object.prototype ? parsed as Row : null } catch { return null }
}
function validId(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 }
function date(value: unknown): Date | null { const parsed = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null; return parsed && Number.isFinite(parsed.getTime()) ? parsed : null }
