import { Prisma } from "@prisma/client"
import {
  canonicalJson,
  parseObjectiveApplicationReviewMemberProof,
  parseObjectiveApplicationResumeWitness,
} from "@jobcopilot/shared"
import { hashApprovalScope, isApprovalHash } from "@jobcopilot/agent-protocol"
import { protocolScope } from "../approval/types"
import { parseObjectiveApprovalSetMemberEnvelope } from "./objective-approval-set-decision-data"
import type { ObjectiveApprovalSetSourceInput } from "./objective-application-approval-set-decision"

const EVENT_TYPE = "objective_application_review_approved"
const EVENT_SCHEMA = "objective-application-review-approved-intent.v1"
const EVENT_BODY = "Objective application review approval recorded."
const HASH = /^[a-f0-9]{64}$/
type Tx = Prisma.TransactionClient

type ApprovedIntent = Readonly<{
  schemaVersion: typeof EVENT_SCHEMA
  userId: string
  sessionId: string
  reviewTurnId: string
  applicationTaskId: string
  jobId: string
  approvalId: string
  setId: string
  slotOrdinal: number
  sourceTurnId: string
  materialProofHash: string
}>

function deny(): never { throw new Error("objective_application_approved_intent_invalid") }
function eventId(setId: string, slotOrdinal: number): string {
  return `objective-application-approved:${setId}:${slotOrdinal}`
}

/** Writes a private pointer only after the grouped review receipt was approved in this transaction. */
export async function recordObjectiveApplicationApprovedIntent(
  tx: Tx,
  input: ObjectiveApprovalSetSourceInput,
): Promise<void> {
  const { member } = input
  const reviewTurnId = member.turnId
  const proof = parseObjectiveApplicationReviewMemberProof(member.proof)
  if (!proof || !validIds(input, reviewTurnId) || typeof member.taskId !== "string" || proof.source.jobId !== member.jobId
    || proof.source.sourceTurnId !== input.sourceTurnId || proof.source.slotOrdinal !== input.slotOrdinal
    || proof.resumeWitness.userId !== member.userId || proof.resumeWitness.jobId !== member.jobId
    || canonicalJson(proof.resumeWitness) !== canonicalJson(parseObjectiveApplicationResumeWitness(member.resumeWitness))) deny()

  const approval = await tx.agentApproval.findFirst({ where: {
    id: member.approvalId, userId: member.userId, sessionId: member.sessionId, turnId: reviewTurnId,
  } })
  const envelope = approval && parseObjectiveApprovalSetMemberEnvelope(approval.payload)
  const persistedProof = envelope && parseObjectiveApplicationReviewMemberProof(envelope.proof)
  if (!approval || !envelope || !persistedProof || canonicalJson(persistedProof) !== canonicalJson(proof)
    || envelope.setId !== input.setId || envelope.sourceTurnId !== input.sourceTurnId || envelope.slotOrdinal !== input.slotOrdinal
    || approval.id !== member.approvalId || approval.userId !== member.userId || approval.sessionId !== member.sessionId
    || approval.turnId !== reviewTurnId || approval.taskId !== member.taskId || approval.jobId !== member.jobId
    || approval.toolCallId !== member.toolCallId || approval.type !== "review_application" || approval.status !== "approved"
    || approval.revision !== member.revision || approval.scopeHash !== member.scopeHash
    || approval.materialHash !== proof.materialProofHash || approval.consumedAt !== null
    || !(approval.expiresAt instanceof Date) || !(approval.decidedAt instanceof Date)
    || approval.expiresAt.getTime() !== member.expiresAt.getTime()
    || approval.expiresAt <= approval.decidedAt || !await validScope(approval)) deny()

  const lockedTask = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "application_tasks" WHERE "id" = ${member.taskId} AND "userId" = ${member.userId}
      AND "sessionId" = ${member.sessionId} AND "jobId" = ${member.jobId} FOR UPDATE
  `)
  if (lockedTask.length !== 1 || lockedTask[0]?.id !== member.taskId) deny()
  const task = await tx.applicationTask.findFirst({
    where: { id: member.taskId!, userId: member.userId, sessionId: member.sessionId, jobId: member.jobId },
    select: { id: true, resumeId: true, status: true, checkpoint: true, workerTaskId: true, fillTurnId: true,
      fillTurnSessionId: true, fillTurnUserId: true, startedAt: true, completedAt: true },
  })
  if (!task || task.id !== member.taskId || task.resumeId !== proof.resumeWitness.resumeId
    || task.status !== "waiting_for_user" || task.checkpoint !== "materials_ready" || task.workerTaskId !== null
    || task.fillTurnId !== null || task.fillTurnSessionId !== null || task.fillTurnUserId !== null
    || task.startedAt !== null || task.completedAt !== null) deny()

  const intent: ApprovedIntent = {
    schemaVersion: EVENT_SCHEMA, userId: member.userId, sessionId: member.sessionId, reviewTurnId,
    applicationTaskId: member.taskId!, jobId: member.jobId, approvalId: member.approvalId,
    setId: input.setId, slotOrdinal: input.slotOrdinal, sourceTurnId: input.sourceTurnId,
    materialProofHash: proof.materialProofHash,
  }
  const id = eventId(input.setId, input.slotOrdinal)
  const prior = await tx.applicationTaskEvent.findMany({
    where: { taskId: member.taskId, type: EVENT_TYPE, data: { path: ["approvalId"], equals: member.approvalId } },
    select: { id: true, taskId: true, type: true, actor: true, body: true, data: true },
    take: 2,
  })
  if (prior.length > 1) deny()
  if (prior.length === 1) {
    const row = prior[0]!
    if (row.id !== id || row.taskId !== member.taskId || row.type !== EVENT_TYPE || row.actor !== "user"
      || row.body !== EVENT_BODY || canonicalJson(row.data) !== canonicalJson(intent)) deny()
    return
  }
  const collision = await tx.applicationTaskEvent.findUnique({ where: { id } })
  if (collision) deny()
  await tx.applicationTaskEvent.create({
    data: { id, taskId: member.taskId!, type: EVENT_TYPE, actor: "user", body: EVENT_BODY,
      data: intent as unknown as Prisma.InputJsonObject },
  })
}

function validIds(input: ObjectiveApprovalSetSourceInput, reviewTurnId: string): boolean {
  return [input.setId, input.intentHash, input.sourceTurnId, input.member.approvalId,
    input.member.userId, input.member.sessionId, reviewTurnId, input.member.jobId, input.member.toolCallId]
    .every(value => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256)
    && HASH.test(input.intentHash) && Number.isSafeInteger(input.slotOrdinal) && input.slotOrdinal >= 1 && input.slotOrdinal <= 8
    && Number.isSafeInteger(input.member.revision) && input.member.revision >= 0 && isApprovalHash(input.member.scopeHash)
}

async function validScope(row: {
  userId: string; sessionId: string; turnId: string | null; jobId: string | null; toolCallId: string | null
  resourceHash: string | null; materialHash: string | null; answersHash: string | null; scopeHash: string | null
  nonceHash: string | null; revision: number; expiresAt: Date | null
}): Promise<boolean> {
  if (!row.turnId || !row.jobId || !row.toolCallId || !row.resourceHash || !row.materialHash || !row.answersHash
    || !row.scopeHash || !row.nonceHash || !row.expiresAt
    || ![row.resourceHash, row.materialHash, row.answersHash, row.scopeHash, row.nonceHash].every(isApprovalHash)) return false
  return row.scopeHash === await hashApprovalScope(protocolScope({
    userId: row.userId, sessionId: row.sessionId, turnId: row.turnId, jobId: row.jobId,
    toolCallId: row.toolCallId, action: "review_application", resourceHash: row.resourceHash,
    materialHash: row.materialHash, answersHash: row.answersHash, revision: row.revision, expiresAt: row.expiresAt,
  }, row.nonceHash))
}
