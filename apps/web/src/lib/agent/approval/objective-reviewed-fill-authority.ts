import { Prisma } from "@prisma/client"
import { objectiveApplicationApprovalSetItemId, parseObjectiveApplicationApprovalSet } from "@jobcopilot/agent-protocol"
import {
  OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA, objectiveApplicationApprovedIntentId,
  parseObjectiveApplicationApprovedIntent,
  sameObjectiveApplicationResumeWitness, type ObjectiveReviewedFillHandoffIntent,
  type ObjectiveReviewedFillSource,
} from "@jobcopilot/shared"
import { readObjectiveApplicationResumeWitness } from "./objective-application-resume-witness"
import { loadLockedObjectiveApprovalSetMembers, parseObjectiveApprovalSetMemberEnvelope } from "../broker/objective-approval-set-decision-data"
import type { ObjectiveApprovalSetSourceInput } from "../broker/objective-application-approval-set-decision"
import { verifyObjectiveApplicationReviewSource } from "../broker/objective-application-review-source"
import { ReviewedFillHandoffDeferredError } from "./reviewed-fill-handoff"
import { ReviewedFillSourceBindingError } from "./reviewed-fill-source-binding"

type Tx = Prisma.TransactionClient
const ACTIVE = new Set(["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"])
const EVENT_BODY = "Objective application review approval recorded."

export type ObjectiveReviewedFillAuthority = Readonly<{
  input: ObjectiveApprovalSetSourceInput
  source: ObjectiveReviewedFillSource
  jobId: string
  resumeId: string
  resumeWitness: ObjectiveApprovalSetSourceInput["member"]["resumeWitness"]
}>

/** Caller holds the source fence, Session and predecessor Turn locks before this exact proof read. */
export async function readObjectiveReviewedFillAuthority(
  tx: Tx, intent: ObjectiveReviewedFillHandoffIntent, now = new Date(),
): Promise<ObjectiveReviewedFillAuthority> {
  const approval = await tx.agentApproval.findFirst({ where: { id: intent.approvalId, userId: intent.userId,
    sessionId: intent.sessionId, turnId: intent.predecessorTurnId, type: "review_application", status: "approved" } })
  const envelope = approval && parseObjectiveApprovalSetMemberEnvelope(approval.payload)
  if (!approval || !envelope || approval.taskId !== intent.applicationTaskId || !validDate(approval.expiresAt)
    || approval.expiresAt <= now || !validDate(approval.decidedAt) || approval.expiresAt <= approval.decidedAt) return invalid()

  const itemId = objectiveApplicationApprovalSetItemId(envelope.setId)
  const locks = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "agent_items" WHERE "id" = ${itemId} AND "sessionId" = ${intent.sessionId}
      AND "turnId" = ${intent.predecessorTurnId} AND "type" = 'approval_request' FOR UPDATE
  `)
  const item = await tx.agentItem.findFirst({ where: { id: itemId, sessionId: intent.sessionId,
    turnId: intent.predecessorTurnId, type: "approval_request" }, select: { id: true, status: true, revision: true,
    phase: true, stepId: true, taskId: true, content: true } })
  const set = item && parseObjectiveApplicationApprovalSet(item.content)
  if (locks.length !== 1 || locks[0]?.id !== itemId || !item || item.id !== itemId || item.status !== "completed"
    || item.phase !== "commentary" || item.revision !== 1 || item.stepId !== null || item.taskId !== null || !set
    || set.setId !== envelope.setId || set.sourceTurnId !== envelope.sourceTurnId
    || !set.members.some(row => row.slotOrdinal === envelope.slotOrdinal && row.approvalId === intent.approvalId)) return invalid()

  const loaded = await loadLockedObjectiveApprovalSetMembers(tx, { userId: intent.userId, sessionId: intent.sessionId,
    expectedTurnId: intent.predecessorTurnId, approvalId: intent.approvalId }, set)
  if (loaded.length !== set.members.length || loaded.some(row => row.row.status === "pending")) return invalid()
  const selected = loaded.find(row => row.slotOrdinal === envelope.slotOrdinal)
  if (!selected || selected.row.id !== intent.approvalId || selected.row.status !== "approved"
    || selected.member.taskId !== intent.applicationTaskId || selected.member.expiresAt <= now
    || !validDate(selected.row.decidedAt) || selected.member.expiresAt <= selected.row.decidedAt) return invalid()

  const pointerId = objectiveApplicationApprovedIntentId(set.setId, envelope.slotOrdinal)
  const pointer = await tx.applicationTaskEvent.findUnique({ where: { id: pointerId },
    select: { id: true, taskId: true, type: true, actor: true, body: true, data: true } })
  const approved = parseObjectiveApplicationApprovedIntent(pointer?.data)
  if (!pointer || pointer.id !== pointerId || pointer.taskId !== intent.applicationTaskId
    || pointer.type !== "objective_application_review_approved" || pointer.actor !== "user" || pointer.body !== EVENT_BODY
    || !approved || approved.userId !== intent.userId || approved.sessionId !== intent.sessionId
    || approved.reviewTurnId !== intent.predecessorTurnId || approved.applicationTaskId !== intent.applicationTaskId
    || approved.jobId !== selected.member.jobId || approved.approvalId !== intent.approvalId
    || approved.setId !== set.setId || approved.slotOrdinal !== envelope.slotOrdinal
    || approved.sourceTurnId !== set.sourceTurnId || approved.materialProofHash !== selected.member.proof.materialProofHash) return invalid()

  const turn = await tx.agentTurn.findFirst({ where: { id: intent.predecessorTurnId, userId: intent.userId,
    sessionId: intent.sessionId }, select: { id: true, status: true } })
  if (turn && ACTIVE.has(turn.status)) throw new ReviewedFillHandoffDeferredError()
  if (!turn || turn.id !== intent.predecessorTurnId || turn.status !== "completed") return invalid()
  await assertCompletedSetWakeup(tx, intent, set.setId, itemId)
  const input: ObjectiveApprovalSetSourceInput = { setId: set.setId, intentHash: set.intentHash,
    sourceTurnId: set.sourceTurnId, slotOrdinal: envelope.slotOrdinal, member: selected.member }
  return { input, jobId: selected.member.jobId, resumeId: selected.member.resumeWitness.resumeId,
    resumeWitness: selected.member.resumeWitness, source: {
    schemaVersion: OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA, approvalId: intent.approvalId,
    reviewTurnId: intent.predecessorTurnId, materialProofHash: approved.materialProofHash,
  } }
}

/** Called after the ApplicationTask lock so source rows follow Session → Turn → set → task → material order. */
export async function verifyObjectiveReviewedFillFreshness(tx: Tx, authority: ObjectiveReviewedFillAuthority): Promise<void> {
  if (await verifyObjectiveApplicationReviewSource(tx, authority.input, "completed_review") !== "current") return invalid()
  const current = await readObjectiveApplicationResumeWitness(tx, { userId: authority.input.member.userId, jobId: authority.jobId })
  if (!current || current.resumeId !== authority.resumeId
    || !sameObjectiveApplicationResumeWitness(current, authority.resumeWitness)) return invalid()
}

async function assertCompletedSetWakeup(tx: Tx, intent: ObjectiveReviewedFillHandoffIntent, setId: string, itemId: string): Promise<void> {
  const completedKey = `agent-wait:${itemId}:completed`, wakeKey = `approval-set:${setId}:wakeup`
  const completed = await tx.agentEvent.findMany({ where: { sessionId: intent.sessionId, turnId: intent.predecessorTurnId,
    type: "item.completed", idempotencyKey: completedKey }, take: 2 })
  const wake = await tx.agentEvent.findMany({ where: { sessionId: intent.sessionId, turnId: intent.predecessorTurnId,
    type: "turn.wakeup", idempotencyKey: wakeKey }, take: 2 })
  const row = completed[0], event = wake[0], payload = event && safeRecord(event.payload)
  if (completed.length !== 1 || wake.length !== 1 || !row || !event || row.itemId !== itemId || row.actor !== "orchestrator"
    || row.taskId !== null || row.causationId !== itemId || !matchesCompletedPayload(row.payload, itemId)
    || event.itemId !== itemId || event.actor !== "user"
    || event.taskId !== null || event.causationId !== row.id || !payload || payload.waitKind !== "approval_set"
    || payload.waitId !== setId || payload.itemId !== itemId
    || payload.turnId !== intent.predecessorTurnId || payload.toolCallId !== null || payload.status !== "resolved"
    || !Number.isSafeInteger(payload.nextTurnRevision) || Number(payload.nextTurnRevision) < 1) return invalid()
}

function validDate(value: unknown): value is Date { return value instanceof Date && Number.isFinite(value.getTime()) }
function safeRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null ? value as Record<string, unknown> : null
}
function matchesCompletedPayload(value: unknown, itemId: string): boolean {
  const payload = safeRecord(value)
  return !!payload && Object.keys(payload).sort().join(",") === "itemId,status"
    && payload.itemId === itemId && payload.status === "completed"
}
function invalid(): never { throw new ReviewedFillSourceBindingError() }
