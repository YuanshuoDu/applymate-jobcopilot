import type { Prisma } from "@prisma/client"
import { parseObjectiveApplicationReviewMemberProof } from "@jobcopilot/shared"
import { parseObjectiveApprovalSetMemberEnvelope, type LoadedObjectiveApprovalSetMember } from "./objective-approval-set-decision-data"

const EVENT_TYPE = "objective_application_review_retired"
const EVENT_SCHEMA = "objective-application-review-retirement.v1"
const EVENT_BODY = "Objective application review member was retired."
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

export const OBJECTIVE_APPLICATION_APPROVAL_RETIREMENT_REASONS = [
  "approval_ttl_reached", "approval_revision_changed", "resume_witness_unavailable",
  "resume_material_changed", "completed_source_changed",
] as const
export type ObjectiveApplicationApprovalRetirementReason = typeof OBJECTIVE_APPLICATION_APPROVAL_RETIREMENT_REASONS[number]
export type ObjectiveApplicationApprovalRetirementScope = Readonly<{
  userId: string; sessionId: string; reviewTurnId: string; sourceTurnId: string; setId: string
  slotOrdinal: number; jobId: string; applicationTaskId: string; approvalId: string; receiptRevision: number
}>
type Tx = Prisma.TransactionClient
type Row = Record<string, unknown>

export async function recordObjectiveApplicationApprovalRetirement(
  tx: Tx, member: LoadedObjectiveApprovalSetMember, setId: string, sourceTurnId: string,
  reason: ObjectiveApplicationApprovalRetirementReason,
): Promise<void> {
  const scope = scopeFromMember(member, setId, sourceTurnId)
  if (!scope || !isReason(reason)) return deny()
  const tasks = await tx.applicationTask.findMany({ where: { id: scope.applicationTaskId, userId: scope.userId,
    sessionId: scope.sessionId, jobId: scope.jobId }, take: 2, select: { id: true, userId: true, sessionId: true, jobId: true } })
  if (tasks.length === 0) return
  if (tasks.length !== 1 || !sameTask(tasks[0], scope)) return deny()
  const prior = await tx.applicationTaskEvent.findMany({ where: { taskId: scope.applicationTaskId, type: EVENT_TYPE,
    data: { path: ["approvalId"], equals: scope.approvalId } }, take: 2,
    select: { id: true, taskId: true, type: true, actor: true, body: true, data: true } })
  if (prior.length !== 0) return deny()
  const id = retirementId(scope.setId, scope.slotOrdinal), collision = await tx.applicationTaskEvent.findUnique({ where: { id } })
  if (collision) return deny()
  await tx.applicationTaskEvent.create({ data: { id, taskId: scope.applicationTaskId, type: EVENT_TYPE, actor: "system",
    body: EVENT_BODY, data: { schemaVersion: EVENT_SCHEMA, ...scope, reason } } })
}

/** Returns a cause only when the exact owner-scoped expired receipt and its one private fact agree. */
export async function readObjectiveApplicationApprovalRetirement(
  tx: Tx, expected: ObjectiveApplicationApprovalRetirementScope,
): Promise<ObjectiveApplicationApprovalRetirementReason | undefined> {
  if (!validScope(expected)) return undefined
  const [tasks, approvals, events] = await Promise.all([
    tx.applicationTask.findMany({ where: { id: expected.applicationTaskId, userId: expected.userId,
      sessionId: expected.sessionId, jobId: expected.jobId }, take: 2, select: { id: true, userId: true, sessionId: true, jobId: true } }),
    tx.agentApproval.findMany({ where: { id: expected.approvalId, userId: expected.userId, sessionId: expected.sessionId,
      turnId: expected.reviewTurnId, taskId: expected.applicationTaskId, jobId: expected.jobId, type: "review_application",
      status: "expired", revision: expected.receiptRevision }, take: 2, select: { id: true, userId: true, sessionId: true,
      turnId: true, taskId: true, jobId: true, type: true, status: true, revision: true, payload: true } }),
    tx.applicationTaskEvent.findMany({ where: { taskId: expected.applicationTaskId, type: EVENT_TYPE,
      data: { path: ["approvalId"], equals: expected.approvalId } }, take: 2,
      select: { id: true, taskId: true, type: true, actor: true, body: true, data: true } }),
  ])
  const approval = approvals[0], envelope = approval && parseObjectiveApprovalSetMemberEnvelope(approval.payload)
  if (tasks.length !== 1 || !sameTask(tasks[0], expected) || approvals.length !== 1 || events.length !== 1 || !approval || !envelope
    || approval.id !== expected.approvalId || approval.userId !== expected.userId || approval.sessionId !== expected.sessionId
    || approval.turnId !== expected.reviewTurnId || approval.taskId !== expected.applicationTaskId || approval.jobId !== expected.jobId
    || approval.type !== "review_application" || approval.status !== "expired" || approval.revision !== expected.receiptRevision
    || envelope.setId !== expected.setId || envelope.sourceTurnId !== expected.sourceTurnId || envelope.slotOrdinal !== expected.slotOrdinal
    || envelope.proof.source.jobId !== expected.jobId || envelope.proof.source.sourceTurnId !== expected.sourceTurnId
    || envelope.proof.source.slotOrdinal !== expected.slotOrdinal || envelope.proof.resumeWitness.userId !== expected.userId) return undefined
  return parseObjectiveApplicationApprovalRetirement(events[0], expected)
}

export function parseObjectiveApplicationApprovalRetirement(
  value: unknown, expected: ObjectiveApplicationApprovalRetirementScope,
): ObjectiveApplicationApprovalRetirementReason | undefined {
  if (!validScope(expected)) return undefined
  const row = record(value), data = record(row?.data)
  if (!row || !data || Object.keys(row).sort().join(",") !== "actor,body,data,id,taskId,type"
    || Object.keys(data).sort().join(",") !== "applicationTaskId,approvalId,jobId,reason,receiptRevision,reviewTurnId,schemaVersion,sessionId,setId,slotOrdinal,sourceTurnId,userId"
    || row.id !== retirementId(expected.setId, expected.slotOrdinal) || row.taskId !== expected.applicationTaskId
    || row.type !== EVENT_TYPE || row.actor !== "system" || row.body !== EVENT_BODY
    || data.schemaVersion !== EVENT_SCHEMA || !isReason(data.reason)) return undefined
  return sameScope(data, expected) ? data.reason : undefined
}

function scopeFromMember(member: LoadedObjectiveApprovalSetMember, setId: string, sourceTurnId: string): ObjectiveApplicationApprovalRetirementScope | undefined {
  const row = member.row, scope = { userId: row.userId, sessionId: row.sessionId, reviewTurnId: row.turnId, sourceTurnId,
    setId, slotOrdinal: member.slotOrdinal, jobId: row.jobId, applicationTaskId: row.taskId, approvalId: row.id, receiptRevision: row.revision }
  const proof = parseObjectiveApplicationReviewMemberProof(member.member.proof)
  return validScope(scope) && proof && proof.source.jobId === scope.jobId && proof.source.sourceTurnId === sourceTurnId
    && proof.source.slotOrdinal === member.slotOrdinal && proof.resumeWitness.userId === scope.userId
    ? scope as ObjectiveApplicationApprovalRetirementScope : undefined
}
function validScope(value: unknown): value is ObjectiveApplicationApprovalRetirementScope {
  const row = record(value)
  return !!row && Object.keys(row).sort().join(",") === "applicationTaskId,approvalId,jobId,receiptRevision,reviewTurnId,sessionId,setId,slotOrdinal,sourceTurnId,userId"
    && [row.userId, row.sessionId, row.reviewTurnId, row.sourceTurnId, row.setId, row.jobId, row.applicationTaskId, row.approvalId].every(id)
    && Number.isSafeInteger(row.slotOrdinal) && Number(row.slotOrdinal) >= 1 && Number(row.slotOrdinal) <= 8
    && Number.isSafeInteger(row.receiptRevision) && Number(row.receiptRevision) >= 0
}
function sameScope(left: Row, right: ObjectiveApplicationApprovalRetirementScope): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId && left.reviewTurnId === right.reviewTurnId
    && left.sourceTurnId === right.sourceTurnId && left.setId === right.setId && left.slotOrdinal === right.slotOrdinal
    && left.jobId === right.jobId && left.applicationTaskId === right.applicationTaskId
    && left.approvalId === right.approvalId && left.receiptRevision === right.receiptRevision
}
function sameTask(value: unknown, scope: ObjectiveApplicationApprovalRetirementScope): boolean {
  const task = record(value)
  return !!task && task.id === scope.applicationTaskId && task.userId === scope.userId
    && task.sessionId === scope.sessionId && task.jobId === scope.jobId
}
function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const keys = Reflect.ownKeys(value)
    if ((Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      || keys.some(key => typeof key !== "string" || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"))) return null
    return value as Row
  } catch { return null }
}
function retirementId(setId: string, ordinal: number) { return `objective-application-review-retired:${setId}:${ordinal}` }
function isReason(value: unknown): value is ObjectiveApplicationApprovalRetirementReason {
  return OBJECTIVE_APPLICATION_APPROVAL_RETIREMENT_REASONS.some(reason => reason === value)
}
function id(value: unknown): value is string { return typeof value === "string" && value.trim() === value && ID.test(value) }
function deny(): never { throw new Error("objective_application_approval_retirement_invalid") }
