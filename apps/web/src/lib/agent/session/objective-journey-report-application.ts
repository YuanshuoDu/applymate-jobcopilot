import { createHash } from "node:crypto"
import { Prisma } from "@prisma/client"
import { objectiveApplicationApprovedIntentId, objectiveReviewedFillHandoffIdempotencyKey,
  parseObjectiveApplicationApprovedIntent, parseObjectiveApplicationReviewMemberProof, parseObjectiveReviewedFillSource,
  type ObjectiveApplicationApprovedIntent } from "@jobcopilot/shared"
import { parseObjectiveApprovalSetMemberEnvelope } from "../broker/objective-approval-set-decision-data"
import type { ObjectiveJourneyReport } from "./objective-journey-report-contract"
import { readObjectiveReviewedApplicationFillOutcome } from "../control-plane/commands/objective-reviewed-application-fill-outcome"
import type { ObjectiveJourneyApprovedBinding } from "./objective-journey-report-approvals"

type Tx = Prisma.TransactionClient
type Row = Record<string, unknown>
type Projection = Pick<ObjectiveJourneyReport["slots"][number], "applicationStatus" | "submissionEvidence">
const APPROVED = "objective_application_review_approved", APPROVED_BODY = "Objective application review approval recorded."
const FAILURE = "fill_prestart_failed", FAILURE_SCHEMA = "agent-harness.v2.objective-fill-prestart-failure.v1"
const FAILURE_BODY = "Objective application fill could not start before browser work began."
const FILL_TEXT = "Fill the server-bound application form for user review. Never submit it."
const SUBMIT_TITLE = "Final submission authorization"
const SUBMIT_BODY = "The form was filled without submission. Review the current job, material alignment, required answers, and sensitive declarations before authorizing an external submission."
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

/** Reports only exact current owner/source bindings. The browser-confirmed result reader is the sole submitted proof. */
export async function readObjectiveJourneyReportApplication(
  tx: Tx, binding: ObjectiveJourneyApprovedBinding | null,
): Promise<Projection> {
  if (!binding) return projection("not_started")
  const unknown = () => projection("unknown")
  const approvals = await tx.agentApproval.findMany({ where: { id: binding.approvalId, userId: binding.userId,
    sessionId: binding.sessionId, turnId: binding.reviewTurnId, taskId: binding.applicationTaskId, jobId: binding.jobId,
    type: "review_application", status: "approved", consumedAt: null }, take: 2,
    select: { id: true, userId: true, sessionId: true, turnId: true, taskId: true, jobId: true, type: true, status: true, payload: true } })
  const receipt = approvals[0], envelope = receipt && parseObjectiveApprovalSetMemberEnvelope(receipt.payload)
  const proof = envelope && parseObjectiveApplicationReviewMemberProof(envelope.proof)
  const intent = approvals.length === 1 && receipt && envelope && proof && receipt.id === binding.approvalId
    && envelope.setId === binding.setId && envelope.sourceTurnId === binding.sourceTurnId && envelope.slotOrdinal === binding.slotOrdinal
    && receipt.jobId === binding.jobId && receipt.taskId === binding.applicationTaskId
    && proof.source.jobId === binding.jobId && proof.source.sourceTurnId === binding.sourceTurnId
    && proof.source.slotOrdinal === binding.slotOrdinal && proof.materialProofHash === binding.materialProofHash
    ? parseObjectiveApplicationApprovedIntent((await approvedEvent(tx, binding))?.data) : null
  if (!intent || !sameBinding(intent, binding)) return unknown()
  const tasks = await tx.applicationTask.findMany({ where: { id: binding.applicationTaskId, userId: binding.userId,
    sessionId: binding.sessionId, jobId: binding.jobId }, take: 2,
    select: { id: true, userId: true, sessionId: true, jobId: true, status: true, checkpoint: true, workerTaskId: true,
      fillTurnId: true, fillTurnSessionId: true, fillTurnUserId: true, completedAt: true, error: true } })
  const task = tasks[0]
  if (tasks.length !== 1 || !task || task.id !== binding.applicationTaskId || task.userId !== binding.userId
    || task.sessionId !== binding.sessionId || task.jobId !== binding.jobId) return unknown()
  if (task.fillTurnId === null) return task.status === "waiting_for_user" && task.checkpoint === "materials_ready"
    && task.workerTaskId === null ? projection("preparing") : unknown()
  const fillTurnId = task.fillTurnId
  if (!validId(fillTurnId) || task.fillTurnSessionId !== binding.sessionId || task.fillTurnUserId !== binding.userId) return unknown()
  const turns = await tx.agentTurn.findMany({ where: { id: fillTurnId, userId: binding.userId, sessionId: binding.sessionId }, take: 2,
    select: { id: true, userId: true, sessionId: true, source: true, executionMode: true, status: true, input: true,
      finalResponse: true, error: true, completedAt: true, rootTaskId: true, leaseOwnerId: true, leaseExpiresAt: true, revision: true } })
  const turn = turns[0]
  if (turns.length !== 1 || !turn || turn.id !== fillTurnId || turn.userId !== binding.userId || turn.sessionId !== binding.sessionId
    || turn.source !== "user" || turn.executionMode !== "canonical_task_graph" || !fillInput(turn.input, binding)) return unknown()
  if (task.status === "waiting_for_user" && task.checkpoint === "submission_uncertain"
    && await exactSubmissionStarted(tx, task, fillTurnId, binding)) return projection("uncertain")
  if (task.status === "failed" && task.checkpoint === FAILURE && await exactPrestartFailure(tx, task, turn, fillTurnId, binding)) return projection("failed")
  if (task.status === "waiting_for_authorization" && task.checkpoint === "form_filled" && turn.status === "waiting_for_approval"
    && await awaitingSubmitApproval(tx, task.id, fillTurnId, Number(turn.revision), binding)) return projection("awaiting_submit_approval")
  if (task.status === "submitted" && task.checkpoint === "submission_verified" && turn.status === "completed") {
    const result = await readObjectiveReviewedApplicationFillOutcome(tx, { ...binding, fillTurnId })
    if (result.status === "confirmed") return { applicationStatus: "submitted",
      submissionEvidence: { fillTurnId: result.fillTurnId, finalItemId: result.finalItemId } }
    return unknown()
  }
  if (task.status === "filling" && ["queued", "in_progress", "waiting_for_dependency", "waiting_for_user"].includes(turn.status)
    || task.status === "waiting_for_user" && ["form_answer_required", "user_takeover"].includes(task.checkpoint ?? "")
      && ["waiting_for_user", "in_progress", "waiting_for_dependency"].includes(turn.status)) return projection("preparing")
  return unknown()
}

async function approvedEvent(tx: Tx, binding: ObjectiveJourneyApprovedBinding) {
  const rows = await tx.applicationTaskEvent.findMany({ where: { taskId: binding.applicationTaskId, type: APPROVED,
    data: { path: ["approvalId"], equals: binding.approvalId } }, take: 2,
    select: { id: true, taskId: true, type: true, actor: true, body: true, data: true } })
  const event = rows[0], intent = event && parseObjectiveApplicationApprovedIntent(event.data)
  return rows.length === 1 && event?.id === (intent && objectiveApplicationApprovedIntentId(intent.setId, intent.slotOrdinal))
    && event.taskId === binding.applicationTaskId && event.type === APPROVED && event.actor === "user" && event.body === APPROVED_BODY
    && intent && sameBinding(intent, binding) ? event : null
}

async function awaitingSubmitApproval(tx: Tx, taskId: string, fillTurnId: string, turnRevision: number,
  binding: ObjectiveJourneyApprovedBinding): Promise<boolean> {
  const id = `application-fill:${taskId}:${fillTurnId}`
  const [receipts, items] = await Promise.all([
    tx.agentApproval.findMany({ where: { id, userId: binding.userId, sessionId: binding.sessionId, turnId: fillTurnId,
      taskId, jobId: binding.jobId, type: "submit_application", status: "pending" }, take: 2,
      select: { id: true, userId: true, sessionId: true, turnId: true, taskId: true, jobId: true, toolCallId: true,
        type: true, status: true, revision: true, expiresAt: true, decidedAt: true, consumedAt: true, scopeHash: true } }),
    tx.agentItem.findMany({ where: { id: `agent-wait:approval:${id}`, sessionId: binding.sessionId, turnId: fillTurnId,
      type: "approval_request", status: "started", phase: "commentary", revision: 0 }, take: 2,
      select: { id: true, sessionId: true, turnId: true, stepId: true, taskId: true, type: true, status: true,
        phase: true, revision: true, content: true } }),
  ])
  const item = items[0], content = record(item?.content), receipt = receipts[0]
  const impact = record(content?.impact), expiresAt = receipt?.expiresAt
  return Boolean(receipts.length === 1 && items.length === 1 && item?.id === `agent-wait:approval:${id}`
    && item.sessionId === binding.sessionId && item.turnId === fillTurnId && item.stepId === null && item.taskId === null
    && item.type === "approval_request" && item.status === "started" && item.phase === "commentary" && item.revision === 0
    && receipt?.id === id && receipt.userId === binding.userId && receipt.sessionId === binding.sessionId
    && receipt.turnId === fillTurnId && receipt.taskId === taskId && receipt.jobId === binding.jobId
    && receipt.type === "submit_application" && receipt.status === "pending"
    && receipt.toolCallId === `application-submit:${taskId}` && Number.isSafeInteger(receipt.revision)
    && Number(receipt.revision) >= 0 && Number.isSafeInteger(turnRevision) && Number(receipt.revision) + 1 === turnRevision
    && validDate(expiresAt) && expiresAt.getTime() > Date.now() && receipt.decidedAt === null && receipt.consumedAt === null
    && typeof receipt.scopeHash === "string" && receipt.scopeHash.length > 0
    && content !== null && exact(content, "action,approvalId,body,decision,expiresAt,impact,receiptRevision,scopeHash,title,toolCallId,waitKind")
    && content.approvalId === id && content.action === "submit_application" && content.waitKind === "approval"
    && content.toolCallId === receipt.toolCallId && content.scopeHash === receipt.scopeHash
    && content.receiptRevision === receipt.revision && content.expiresAt === expiresAt.toISOString() && content.decision === null
    && content.title === SUBMIT_TITLE && content.body === SUBMIT_BODY
    && impact !== null && exact(impact, "externalSubmission,jobId") && impact.externalSubmission === true && impact.jobId === binding.jobId)
}

async function exactSubmissionStarted(tx: Tx, task: Row, turnId: string, binding: ObjectiveJourneyApprovedBinding): Promise<boolean> {
  const workerTaskId = task.workerTaskId, taskId = task.id
  if (!validId(workerTaskId) || !validId(taskId)) return false
  const id = `application-fill:${taskId}:${turnId}`
  const [events, receipts] = await Promise.all([
    tx.applicationTaskEvent.findMany({ where: { taskId, type: "submission_execution_started",
      data: { path: ["fillTurnId"], equals: turnId } }, take: 2,
      select: { id: true, taskId: true, type: true, actor: true, body: true, data: true } }),
    tx.agentApproval.findMany({ where: { id, userId: binding.userId, sessionId: binding.sessionId, turnId,
      taskId, jobId: binding.jobId, type: "submit_application", status: "consumed" }, take: 2,
      select: { id: true, scopeHash: true, consumedAt: true } }),
  ])
  const event = events[0], data = record(event?.data), receipt = receipts[0]
  return events.length === 1 && receipts.length === 1 && data !== null && validId(data.executionId)
    && event?.id === `evt_${data.executionId}` && event.taskId === taskId
    && event.type === "submission_execution_started" && event.actor === "worker"
    && event.body === "Submit execution started" && data !== null
    && exact(data, "applicationTaskId,approvalId,constraintHash,executionId,fillTurnId,jobId,sessionId,userId,workerTaskId")
    && data.applicationTaskId === taskId && data.userId === binding.userId && data.sessionId === binding.sessionId
    && data.jobId === binding.jobId && data.fillTurnId === turnId && data.workerTaskId === workerTaskId
    && data.approvalId === id && data.constraintHash === receipt.scopeHash && receipt.id === id
    && receipt.consumedAt instanceof Date && Number.isFinite(receipt.consumedAt.getTime())
}

async function exactPrestartFailure(tx: Tx, task: Row, turn: Row, turnId: string, binding: ObjectiveJourneyApprovedBinding): Promise<boolean> {
  if (turn.status !== "failed" || turn.rootTaskId !== null || !validDate(turn.completedAt) || turn.leaseOwnerId !== null
    || turn.leaseExpiresAt !== null || task.workerTaskId !== null || task.error !== FAILURE_BODY) return false
  const taskId = task.id
  if (!validId(taskId)) return false
  const key = objectiveReviewedFillHandoffIdempotencyKey(binding.approvalId)
  if (!key) return false
  const rows = await tx.applicationTaskEvent.findMany({ where: { taskId, type: FAILURE,
    data: { path: ["fillTurnId"], equals: turnId } }, take: 2,
    select: { id: true, taskId: true, type: true, actor: true, body: true, data: true } })
  const event = rows[0], data = record(event?.data)
  const id = `objective-fill-prestart-failure:${createHash("sha256").update(JSON.stringify([taskId, turnId, key])).digest("hex")}`
  return rows.length === 1 && event?.id === id && event.taskId === taskId && event.type === FAILURE
    && event.actor === "worker" && event.body === FAILURE_BODY && data !== null
    && exact(data, "applicationTaskId,approvalId,clientMessageId,fillTurnId,schemaVersion,sessionId,userId")
    && data.schemaVersion === FAILURE_SCHEMA && data.applicationTaskId === binding.applicationTaskId
    && data.userId === binding.userId && data.sessionId === binding.sessionId && data.fillTurnId === turnId
    && data.approvalId === binding.approvalId && data.clientMessageId === key
}

function fillInput(value: unknown, binding: ObjectiveJourneyApprovedBinding): boolean {
  const input = record(value), source = parseObjectiveReviewedFillSource(value), parts = input?.content
  const text = Array.isArray(parts) && parts.length === 1 ? record(parts[0]) : null
  return !!input && Object.keys(input).sort().join(",") === "clientMessageId,content,goal,reviewedApplicationMaterialSource"
    && input.clientMessageId === objectiveReviewedFillHandoffIdempotencyKey(binding.approvalId) && input.goal === FILL_TEXT
    && !!text && Object.keys(text).sort().join(",") === "text,type" && text.type === "text" && text.text === FILL_TEXT
    && !!source && source.approvalId === binding.approvalId && source.reviewTurnId === binding.reviewTurnId
    && source.materialProofHash === binding.materialProofHash
}
function sameBinding(intent: ObjectiveApplicationApprovedIntent, binding: ObjectiveJourneyApprovedBinding): boolean {
  return intent.userId === binding.userId && intent.sessionId === binding.sessionId && intent.sourceTurnId === binding.sourceTurnId
    && intent.slotOrdinal === binding.slotOrdinal && intent.jobId === binding.jobId && intent.reviewTurnId === binding.reviewTurnId
    && intent.setId === binding.setId && intent.approvalId === binding.approvalId
    && intent.applicationTaskId === binding.applicationTaskId && intent.materialProofHash === binding.materialProofHash
}
function projection(applicationStatus: Projection["applicationStatus"]): Projection { return { applicationStatus, submissionEvidence: null } }
function validId(value: unknown): value is string { return typeof value === "string" && ID.test(value) && value.trim() === value }
function validDate(value: unknown): value is Date { return value instanceof Date && Number.isFinite(value.getTime()) }
function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try { if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return null
    if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"))) return null
    return value as Row
  } catch { return null }
}
function exact(value: Row, csv: string): boolean { return Reflect.ownKeys(value).length === csv.split(",").length && Object.keys(value).sort().join(",") === csv.split(",").sort().join(",") }
