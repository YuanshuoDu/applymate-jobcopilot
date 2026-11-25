import { createHash } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import {
  objectiveApplicationApprovalSetItemId,
  parseObjectiveApplicationApprovalSet,
} from "@jobcopilot/agent-protocol"
import {
  canonicalJson,
  hashAgentReceiptValue,
  hashContent,
  hashObjectiveApplicationSubmissionMaterial,
  parseObjectiveApplicationApprovedIntent,
  parseObjectiveApplicationReviewMemberProof,
  parseObjectiveApplicationSubmissionManifestEvent,
  parseObjectiveReviewedApplicationFillBrowserStartEvent,
  parseObjectiveReviewedFillSource,
  hashReviewedApplicationMaterialProof,
} from "@jobcopilot/shared"
import {
  OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_BODY,
  OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_TYPE,
  objectiveApplicationSubmitResultEventId,
  parseObjectiveApplicationSubmitResultReceipt,
} from "../../../../../../worker/src/db/objective-application-submit-result.js"
import {
  OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_BODY,
  OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_TYPE,
  objectiveApplicationSubmitFinalizationEventId,
  parseObjectiveApplicationSubmitFinalizationReceipt,
} from "../../../../../../worker/src/runtime/turns/recovery-scanner-objective-submit.js"

type Row = Record<string, unknown>
export type ObjectiveWaveEvidenceScope = Readonly<{ userId: string; sessionId: string; reviewTurnId: string }>
export type ObjectiveWaveEvidenceSlot = Readonly<{
  ordinal: number; routeOrdinal: number; reviewApprovalId: string; applicationTaskId: string; jobId: string
  corrected: boolean; expectedCoverLetterSha256: string
}>
export type ObjectiveWaveSubmissionEvidence = Readonly<{
  scope: ObjectiveWaveEvidenceScope; slot: ObjectiveWaveEvidenceSlot; fillTurnId: string
  task: Readonly<{ id: string; status: "submitted"; checkpoint: "submission_verified"; workerTaskId: string }>
  turn: Readonly<{ id: string; status: "completed"; rootTaskId: string; sourceApprovalId: string }>
  root: Readonly<{ id: string; status: "completed"; leaseFree: true; finalItemId: string }>
  job: Readonly<{ id: string; status: "applied"; workflowState: "submitted" }>
  approval: Readonly<{ id: string; status: "consumed"; taskId: string; turnId: string; jobId: string }>
  result: Readonly<{ count: 1; eventId: string; executionId: string; attemptId: string; applyResultId: number; status: "submitted"; jobId: string }>
  execution: Readonly<{ startedCount: 1; settledCount: 1; startedEventId: string; settledEventId: string }>
  attempt: Readonly<{ count: 1; id: string; state: "submitted"; receiptId: string }>
  finalization: Readonly<{ count: 1; eventId: string; itemStatus: "completed"; finalItemId: string }>
}>
/** Read-only exact durable proof for one approved Objective slot after Fill Turn closure. */
export async function readObjectiveWaveSubmissionEvidence(
  client: PrismaClient,
  input: Readonly<{ scope: ObjectiveWaveEvidenceScope; slot: ObjectiveWaveEvidenceSlot; fillTurnId: string }>,
): Promise<ObjectiveWaveSubmissionEvidence | null> {
  const { scope, slot, fillTurnId } = input
  if (!validInput(scope, slot, fillTurnId)) return null
  const setId = `objective-review-${createHash("sha256").update(
    `objective-application-review-set.v1\0${scope.sessionId}\0${scope.reviewTurnId}`).digest("hex").slice(0, 40)}`
  const setItemId = objectiveApplicationApprovalSetItemId(setId)
  const submitApprovalId = `application-fill:${slot.applicationTaskId}:${fillTurnId}`
  const [reviewTurnRows, fillTurnRows, taskRows, jobRows, setItems, reviewApprovals, submitApprovals, events] = await Promise.all([
    client.agentTurn.findMany({ where: { id: scope.reviewTurnId, userId: scope.userId, sessionId: scope.sessionId }, take: 2 }),
    client.agentTurn.findMany({ where: { id: fillTurnId, userId: scope.userId, sessionId: scope.sessionId }, take: 2 }),
    client.applicationTask.findMany({ where: { id: slot.applicationTaskId, userId: scope.userId, sessionId: scope.sessionId,
      jobId: slot.jobId, fillTurnId, fillTurnUserId: scope.userId, fillTurnSessionId: scope.sessionId }, take: 2 }),
    client.job.findMany({ where: { id: slot.jobId, userId: scope.userId }, take: 2 }),
    client.agentItem.findMany({ where: { id: setItemId, sessionId: scope.sessionId, turnId: scope.reviewTurnId }, take: 2 }),
    client.agentApproval.findMany({ where: { id: slot.reviewApprovalId, userId: scope.userId, sessionId: scope.sessionId,
      turnId: scope.reviewTurnId, taskId: slot.applicationTaskId, jobId: slot.jobId, type: "review_application" }, take: 2 }),
    client.agentApproval.findMany({ where: { id: submitApprovalId, userId: scope.userId, sessionId: scope.sessionId,
      turnId: fillTurnId, taskId: slot.applicationTaskId, jobId: slot.jobId, type: "submit_application" }, take: 2 }),
    client.applicationTaskEvent.findMany({ where: { taskId: slot.applicationTaskId, type: { in: [
      "objective_application_review_approved", "reviewed_application_fill_browser_started",
      "objective_submission_manifest_recorded", OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_TYPE,
      "submission_execution_started", "submission_execution_settled", OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_TYPE,
    ] } }, take: 32 }),
  ])
  const reviewTurn = one(reviewTurnRows), turn = one(fillTurnRows), task = one(taskRows), job = one(jobRows)
  const setItem = one(setItems), reviewApproval = one(reviewApprovals), approval = one(submitApprovals)
  const eventsByType = new Map<string, Row[]>()
  for (const value of events) {
    const event = record(value), type = event?.type
    if (!event || typeof type !== "string") return null
    eventsByType.set(type, [...(eventsByType.get(type) ?? []), event])
  }
  const exactlyOne = (type: string): Row | null => {
    const rows = eventsByType.get(type) ?? []
    return rows.length === 1 ? rows[0]! : null
  }
  const approvedEvent = exactlyOne("objective_application_review_approved")
  const browserEvent = exactlyOne("reviewed_application_fill_browser_started")
  const manifestEvent = exactlyOne("objective_submission_manifest_recorded")
  const resultEvent = exactlyOne(OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_TYPE)
  const startedEvent = exactlyOne("submission_execution_started"), settledEvent = exactlyOne("submission_execution_settled")
  const finalizationEvent = exactlyOne(OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_TYPE)
  if (!reviewTurn || reviewTurn.status !== "completed" || reviewTurn.source !== "user" || reviewTurn.executionMode !== "canonical_task_graph"
    || !turn || turn.status !== "completed" || turn.executionMode !== "canonical_task_graph"
    || !task || task.status !== "submitted" || task.checkpoint !== "submission_verified" || !safeId(task.workerTaskId)
    || !task.completedAt || !job || job.status !== "applied" || job.workflowState !== "submitted" || !job.appliedAt
    || !setItem || setItem.id !== setItemId || setItem.type !== "approval_request" || setItem.status !== "completed" || setItem.revision !== 1
    || !reviewApproval || reviewApproval.status !== "approved" || reviewApproval.consumedAt !== null
    || !approval || approval.status !== "consumed" || !approval.consumedAt || approval.turnId !== fillTurnId
    || approval.toolCallId !== `application-submit:${slot.applicationTaskId}`
    || !approvedEvent || !browserEvent || !manifestEvent || !resultEvent || !startedEvent || !settledEvent || !finalizationEvent) return null
  const set = parseObjectiveApplicationApprovalSet(setItem.content)
  const member = record(reviewApproval.payload), proof = parseObjectiveApplicationReviewMemberProof(member?.proof)
  const fillSource = parseObjectiveReviewedFillSource(turn.input)
  const approvedIntent = parseObjectiveApplicationApprovedIntent(approvedEvent.data)
  if (!set || set.setId !== setId || set.sourceTurnId !== approvedIntent?.sourceTurnId
    || !set.members.some(value => value.slotOrdinal === slot.ordinal && value.approvalId === slot.reviewApprovalId)
    || !exactMember(member, setId, set.sourceTurnId, slot.ordinal)
    || reviewApproval.id !== slot.reviewApprovalId || reviewApproval.toolCallId !== `objective_review_application:${setId}:${slot.ordinal}`
    || !proof || proof.source.slotOrdinal !== slot.ordinal || proof.source.jobId !== slot.jobId
    || proof.materialProofHash !== fillSource?.materialProofHash
    || !fillSource || fillSource.approvalId !== slot.reviewApprovalId || fillSource.reviewTurnId !== scope.reviewTurnId
    || !approvedIntent || approvedIntent.schemaVersion !== "objective-application-review-approved-intent.v1"
    || approvedIntent.userId !== scope.userId || approvedIntent.sessionId !== scope.sessionId
    || approvedIntent.reviewTurnId !== scope.reviewTurnId || approvedIntent.applicationTaskId !== slot.applicationTaskId
    || approvedIntent.jobId !== slot.jobId || approvedIntent.approvalId !== slot.reviewApprovalId
    || approvedIntent.setId !== setId || approvedIntent.slotOrdinal !== slot.ordinal
    || approvedIntent.materialProofHash !== fillSource.materialProofHash) return null
  const manifestPacket = parseObjectiveApplicationSubmissionManifestEvent(manifestEvent.data)
  const browser = parseObjectiveReviewedApplicationFillBrowserStartEvent(browserEvent.data)
  const browserProofHash = browser ? await hashReviewedApplicationMaterialProof(browser.proof) : null
  const materialHash = manifestPacket ? await hashObjectiveApplicationSubmissionMaterial(manifestPacket.manifest.material) : null
  const answersHash = await hashAgentReceiptValue("answers", task.confirmedAnswers ?? null)
  const source = { schemaVersion: fillSource.schemaVersion, approvalId: fillSource.approvalId,
    reviewTurnId: fillSource.reviewTurnId, materialProofHash: fillSource.materialProofHash }
  if (!eventRow(approvedEvent, slot.applicationTaskId, "objective_application_review_approved", "user", "Objective application review approval recorded.")
    || !eventRow(browserEvent, slot.applicationTaskId, "reviewed_application_fill_browser_started", "worker", "Reviewed application material bound to browser-start attempt.")
    || !eventRow(manifestEvent, slot.applicationTaskId, "objective_submission_manifest_recorded", "worker", "Objective submission manifest recorded for this fill attempt.")
    || !manifestPacket || manifestPacket.scope.userId !== scope.userId || manifestPacket.scope.sessionId !== scope.sessionId
    || manifestPacket.scope.applicationTaskId !== slot.applicationTaskId || manifestPacket.scope.jobId !== slot.jobId
    || manifestPacket.scope.fillTurnId !== fillTurnId || manifestPacket.manifest.material.resumeId !== task.resumeId
    || manifestPacket.manifest.material.coverLetterId !== task.coverLetterId
    || !browserProofHash || manifestPacket.manifest.material.reviewedCoverLetterHash !== browserProofHash
    || manifestPacket.hash !== hashContent(manifestPacket.manifest)
    || manifestPacket.hash !== `sha256:${approval.resourceHash}` || !materialHash || materialHash !== approval.materialHash
    || !answersHash || answersHash !== manifestPacket.manifest.answersHash || answersHash !== approval.answersHash
    || canonicalJson(manifestPacket.manifest.material.objectiveSource) !== canonicalJson(source)
    || !browser || browser.userId !== scope.userId || browser.sessionId !== scope.sessionId
    || browser.applicationTaskId !== slot.applicationTaskId || browser.jobId !== slot.jobId || browser.fillTurnId !== fillTurnId
    || browser.proof.jobId !== slot.jobId
    || !(millis(browserEvent.createdAt) < millis(browser.leaseExpiresAt))
    || canonicalJson(browser.objectiveSource) !== canonicalJson(source)) return null
  const result = parseObjectiveApplicationSubmitResultReceipt(resultEvent.data)
  const execution = result && { userId: result.userId, sessionId: result.sessionId, applicationTaskId: result.applicationTaskId,
    jobId: result.jobId, fillTurnId: result.fillTurnId, approvalId: result.approvalId,
    constraintHash: result.constraintHash, workerTaskId: result.workerTaskId, executionId: result.executionId }
  const resultId = execution && objectiveApplicationSubmitResultEventId(execution)
  const started = record(startedEvent.data), settled = record(settledEvent.data)
  if (!result || !execution || result.schemaVersion !== "agent-harness.v2.objective-application-submit-result.v1"
    || result.applicationTaskId !== slot.applicationTaskId || result.userId !== scope.userId || result.sessionId !== scope.sessionId
    || result.jobId !== slot.jobId || result.fillTurnId !== fillTurnId || result.approvalId !== approval.id
    || result.constraintHash !== approval.scopeHash || result.workerTaskId !== task.workerTaskId
    || resultEvent.id !== resultId || resultEvent.actor !== "worker" || resultEvent.body !== OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_BODY
    || !eventRow(resultEvent, slot.applicationTaskId, OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_TYPE, "worker", OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_BODY)
    || !sameExecution(started, execution) || !sameExecution(settled, execution)
    || startedEvent.id !== `evt_${result.executionId}` || settledEvent.id === startedEvent.id
    || !eventRow(startedEvent, slot.applicationTaskId, "submission_execution_started", "worker", "Submit execution started")
    || !eventRow(settledEvent, slot.applicationTaskId, "submission_execution_settled", "worker", "Submit execution settled")) return null
  const resultIdValue = result.applyResultId
  if (typeof approval.scopeHash !== "string" || !/^[a-f0-9]{64}$/.test(approval.scopeHash)) return null
  const approvalScopeHash = approval.scopeHash
  const [applyRows, attemptRows] = await Promise.all([
    client.applyResult.findMany({ where: { id: resultIdValue }, take: 2 }),
    client.submissionAttempt.findMany({ where: { userId: scope.userId, jobId: slot.jobId, receiptId: approval.id,
      constraintHash: approvalScopeHash }, take: 2 }),
  ])
  const apply = one(applyRows), attempt = one(attemptRows)
  const finalization = parseObjectiveApplicationSubmitFinalizationReceipt(finalizationEvent.data)
  if (!apply || apply.id !== resultIdValue || apply.userId !== scope.userId || apply.jobId !== slot.jobId
    || apply.mode !== "unattended" || apply.atsType !== "greenhouse" || apply.flowUsed !== "application.submit"
    || apply.status !== "submitted" || apply.error !== null
    || !attempt || attempt.id !== result.attemptId || attempt.receiptId !== approval.id || attempt.state !== "submitted"
    || attempt.constraintHash !== approval.scopeHash || attempt.artifactHash !== approval.resourceHash || !safeId(attempt.responseRef)
    || !finalization || finalization.applicationTaskId !== slot.applicationTaskId || finalization.userId !== scope.userId
    || finalization.sessionId !== scope.sessionId || finalization.jobId !== slot.jobId || finalization.fillTurnId !== fillTurnId
    || finalization.approvalId !== approval.id || finalization.constraintHash !== approval.scopeHash
    || finalization.workerTaskId !== task.workerTaskId || finalization.executionId !== result.executionId
    || finalization.attemptId !== attempt.id || finalization.resultLinkEventId !== resultEvent.id
    || finalization.applyResultId !== resultIdValue
    || finalizationEvent.id !== objectiveApplicationSubmitFinalizationEventId(execution, resultEvent.id)
    || !eventRow(finalizationEvent, slot.applicationTaskId, OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_TYPE,
      "worker", OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_BODY)) return null
  const finalItemId = `turn:${fillTurnId}:item:final:objective-application-submit-finalize:${fillTurnId}`
  const rootTaskId = turn.rootTaskId
  if (!safeId(rootTaskId) || !approvedEvent.createdAt || !resultEvent.createdAt || !startedEvent.createdAt
    || !settledEvent.createdAt || !finalizationEvent.createdAt
    || millis(browserEvent.createdAt) > millis(startedEvent.createdAt)
    || millis(startedEvent.createdAt) > millis(resultEvent.createdAt) || millis(resultEvent.createdAt) > millis(settledEvent.createdAt)
    || millis(settledEvent.createdAt) > millis(finalizationEvent.createdAt)) return null
  const [roots, items, terminalEvents] = await Promise.all([
    client.subAgentTask.findMany({ where: { id: rootTaskId, sessionId: scope.sessionId, turnId: fillTurnId,
      rootTaskId, parentTaskId: null, role: "orchestrator", taskType: "root" }, take: 2 }),
    client.agentItem.findMany({ where: { id: finalItemId, sessionId: scope.sessionId, turnId: fillTurnId, taskId: rootTaskId }, take: 2 }),
    client.agentEvent.findMany({ where: { id: `turn:${fillTurnId}:event:turn-completed`, sessionId: scope.sessionId, turnId: fillTurnId }, take: 2 }),
  ])
  const root = one(roots), item = one(items), terminal = one(terminalEvents), rootResult = record(root?.result)
  const content = record(item?.content), final = record(content?.final), turnFinal = safeJson(turn.finalResponse)
  if (!root || root.status !== "completed" || root.failureReason !== null || root.leaseOwner !== null || root.leaseExpiresAt !== null
    || !root.completedAt || rootResult?.status !== "completed" || rootResult.finalItemId !== finalItemId || rootResult.waitId !== null
    || !item || item.type !== "agent_message" || item.status !== "completed" || item.phase !== "final_answer" || item.revision !== 1
    || !item.completedAt || content?.text !== "The application site confirmed that the application was submitted."
    || final?.schemaVersion !== "agent-harness.v2.final" || final.completed !== true || final.terminalReason !== "goal_satisfied"
    || !Array.isArray(final.evidenceRefs) || !final.evidenceRefs.includes("objective_application_submit_site_confirmation")
    || !turnFinal || canonicalJson(turnFinal) !== canonicalJson(final)
    || !terminal || terminal.type !== "turn.completed" || terminal.itemId !== finalItemId
    || terminal.correlationId !== `objective-application-submit-finalize:${fillTurnId}`) return null
  return {
    scope, slot, fillTurnId,
    task: { id: slot.applicationTaskId, status: "submitted", checkpoint: "submission_verified", workerTaskId: task.workerTaskId },
    turn: { id: fillTurnId, status: "completed", rootTaskId, sourceApprovalId: fillSource.approvalId },
    root: { id: rootTaskId, status: "completed", leaseFree: true, finalItemId },
    job: { id: slot.jobId, status: "applied", workflowState: "submitted" },
    approval: { id: approval.id, status: "consumed", taskId: approval.taskId!, turnId: fillTurnId, jobId: slot.jobId },
    result: { count: 1, eventId: resultEvent.id as string, executionId: result.executionId, attemptId: result.attemptId,
      applyResultId: resultIdValue, status: "submitted", jobId: slot.jobId },
    execution: { startedCount: 1, settledCount: 1, startedEventId: startedEvent.id as string, settledEventId: settledEvent.id as string },
    attempt: { count: 1, id: attempt.id, state: "submitted", receiptId: attempt.receiptId },
    finalization: { count: 1, eventId: finalizationEvent.id as string, itemStatus: "completed", finalItemId },
  }
}
function validInput(scope: ObjectiveWaveEvidenceScope, slot: ObjectiveWaveEvidenceSlot, fillTurnId: string): boolean {
  return [scope.userId, scope.sessionId, scope.reviewTurnId, slot.reviewApprovalId, slot.applicationTaskId, slot.jobId, fillTurnId]
    .every(safeId) && Number.isSafeInteger(slot.ordinal) && slot.ordinal >= 1 && slot.ordinal <= 8
    && Number.isSafeInteger(slot.routeOrdinal) && slot.routeOrdinal >= 1 && slot.routeOrdinal <= 8
    && typeof slot.corrected === "boolean" && /^[a-f0-9]{64}$/.test(slot.expectedCoverLetterSha256)
}
function safeId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try { return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null ? value as Row : null } catch { return null }
}
function exactMember(row: Row | null, setId: string, sourceTurnId: string, ordinal: number): boolean {
  return !!row && Object.keys(row).sort().join(",") === "proof,schema,setId,slotOrdinal,sourceTurnId"
    && row.schema === "objective-application-approval-set-member.v1" && row.setId === setId
    && row.sourceTurnId === sourceTurnId && row.slotOrdinal === ordinal
}
function eventRow(row: Row, taskId: string, type: string, actor: string, body: string): boolean {
  return row.taskId === taskId && row.type === type && row.actor === actor && row.body === body
}
function sameExecution(row: Row | null, execution: Row): boolean {
  return !!row && Object.keys(row).sort().join(",") === "applicationTaskId,approvalId,constraintHash,executionId,fillTurnId,jobId,sessionId,userId,workerTaskId"
    && ["applicationTaskId", "approvalId", "constraintHash", "executionId", "fillTurnId", "jobId", "sessionId", "userId", "workerTaskId"]
      .every(key => row[key] === execution[key])
}
function one<T>(rows: readonly T[]): T | null { return rows.length === 1 ? rows[0] ?? null : null }
function millis(value: unknown): number { const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null; return date?.getTime() ?? NaN }
function safeJson(value: unknown): Row | null { try { return typeof value === "string" ? record(JSON.parse(value) as unknown) : record(value) } catch { return null } }
