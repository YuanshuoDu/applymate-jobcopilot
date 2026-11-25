export type ObjectiveWaveSubmissionSlot = Readonly<{
  ordinal: number; routeOrdinal: number; reviewApprovalId: string
  applicationTaskId: string; jobId: string; corrected: boolean; expectedCoverLetterSha256: string
}>

export type ObjectiveWaveScope = Readonly<{ userId: string; sessionId: string; reviewTurnId: string }>

export type ObjectiveWaveStaleSlotProof = ObjectiveWaveScope & ObjectiveWaveSubmissionSlot & Readonly<{
  approvalStatus: "expired"; taskStatus: "waiting_for_user"; checkpoint: "materials_ready"
  fillTurnId: null; workerTaskId: null; outboxCount: 0; browserStartCount: 0
  routeGets: 0; routePostAttempts: 0
}>

export type ObjectiveWaveDeferredProof = ObjectiveWaveScope & ObjectiveWaveSubmissionSlot & Readonly<{
  outboxId: string; outboxTopic: "agent.objective-reviewed-fill.dispatch"; outboxAggregateId: string
  idempotencyKey: string; predecessorTurnId: string
  schemaVersion: "agent-harness.v2.objective-reviewed-fill-handoff.v1"
  acknowledgement: "deferred"; published: false
}>

export type ObjectiveWaveHandoffProof = ObjectiveWaveScope & ObjectiveWaveSubmissionSlot & Readonly<{
  fillTurnId: string; outboxId: string; outboxTopic: "agent.objective-reviewed-fill.dispatch"
  outboxAggregateId: string; idempotencyKey: string; predecessorTurnId: string
  schemaVersion: "agent-harness.v2.objective-reviewed-fill-handoff.v1"
  acknowledgement: "queued" | "duplicate"; published: true; publishAttemptCount: 1
  routeGetsBefore: number; routePostAttemptsBefore: number
  routePostValidBefore: number; routePostMalformedBefore: number
}>

export type ObjectiveWaveSubmissionProof = Readonly<{
  durable: ObjectiveWaveSubmissionEvidence
  site: Readonly<{ routeOrdinal: number; getsAfter: number; postAttemptsAfter: number; postValidAfter: number; postMalformedAfter: number; coverLetterSha256: string }>
  restartCount: 0 | 1
}>

export type ObjectiveWaveRestartProof = Readonly<{
  projectionBlocked: true; committedResultBeforeCrash: true; capturedWorkerKilled: true
  workerExitObserved: true; barrierUnblocked: true; successorStartedOnce: true; successorReady: true
}>

export type ObjectiveWaveWindowProof = Readonly<{
  expired: true; completedApplications: 2; expectedCounter: 4; userCounterPreserved: true
}>

export type ObjectiveWaveSubmissionOps = Readonly<{
  assertDeferred(slots: readonly ObjectiveWaveSubmissionSlot[], stale: ObjectiveWaveSubmissionSlot): Promise<readonly ObjectiveWaveDeferredProof[]>
  readStale(stale: ObjectiveWaveSubmissionSlot): Promise<ObjectiveWaveStaleSlotProof>
  releaseAndQueue(slot: ObjectiveWaveSubmissionSlot): Promise<ObjectiveWaveHandoffProof>
  approveSubmitAndReadProof(slot: ObjectiveWaveSubmissionSlot, handoff: ObjectiveWaveHandoffProof): Promise<ObjectiveWaveSubmissionProof>
  approveSubmitWithCrashRecoveryAndReadProof(slot: ObjectiveWaveSubmissionSlot, handoff: ObjectiveWaveHandoffProof): Promise<Readonly<{ proof: ObjectiveWaveSubmissionProof; restart: ObjectiveWaveRestartProof }>>
  advanceRateWindow(pair: readonly [ObjectiveWaveSubmissionProof, ObjectiveWaveSubmissionProof]): Promise<ObjectiveWaveWindowProof>
}>

export async function runObjectiveWaveSubmissions(input: Readonly<{
  scope: ObjectiveWaveScope
  slots: readonly ObjectiveWaveSubmissionSlot[]
  stale: ObjectiveWaveSubmissionSlot
  ops: ObjectiveWaveSubmissionOps
}>): Promise<readonly ObjectiveWaveSubmissionProof[]> {
  validateInput(input.scope, input.slots, input.stale)
  const deferred = await input.ops.assertDeferred(input.slots, input.stale)
  const deferredOutboxIds = validateDeferred(input.scope, input.slots, input.stale, deferred)
  validateStale(input.scope, input.stale, await input.ops.readStale(input.stale))
  const crashIndex = input.slots.findIndex(slot => slot.corrected)
  const proofs: ObjectiveWaveSubmissionProof[] = []
  const uniqueIds = new Set<string>()
  let restartCount = 0
  for (let index = 0; index < input.slots.length; index++) {
    const slot = input.slots[index]!
    const handoff = await input.ops.releaseAndQueue(slot)
    validateHandoff(input.scope, slot, handoff, deferredOutboxIds.get(slot.reviewApprovalId))
    let proof: ObjectiveWaveSubmissionProof
    if (index === crashIndex) {
      const recovered = await input.ops.approveSubmitWithCrashRecoveryAndReadProof(slot, handoff)
      validateRestart(recovered.restart)
      restartCount++
      proof = recovered.proof
    } else {
      proof = await input.ops.approveSubmitAndReadProof(slot, handoff)
    }
    validateSubmission(input.scope, slot, handoff, proof, index === crashIndex ? 1 : 0)
    recordDistinctSubmissionIds(proof, uniqueIds)
    proofs.push(proof)
    if ((index + 1) % 2 === 0 && index < 4) {
      const pair = proofs.slice(index - 1, index + 1) as [ObjectiveWaveSubmissionProof, ObjectiveWaveSubmissionProof]
      validateWindow(await input.ops.advanceRateWindow(pair))
    }
  }
  if (restartCount !== 1) throw new Error("objective_wave_restart_count_invalid")
  const staleAfter = await input.ops.readStale(input.stale)
  validateStale(input.scope, input.stale, staleAfter)
  return proofs
}

function validateInput(scope: ObjectiveWaveScope, slots: readonly ObjectiveWaveSubmissionSlot[], stale: ObjectiveWaveSubmissionSlot): void {
  if (!id(scope.userId) || !/^full-loop-user-[a-f0-9]{32}-objective-wave$/.test(scope.userId)
    || !id(scope.sessionId) || !id(scope.reviewTurnId) || slots.length !== 5) throw new Error("objective_wave_submission_scope_invalid")
  const all = [...slots, stale], ordinals = new Set<number>(), routes = new Set<number>()
  const approvals = new Set<string>(), tasks = new Set<string>(), jobs = new Set<string>()
  for (const slot of all) {
    if (!validSlot(slot) || ordinals.has(slot.ordinal) || routes.has(slot.routeOrdinal)
      || approvals.has(slot.reviewApprovalId) || tasks.has(slot.applicationTaskId) || jobs.has(slot.jobId)) {
      throw new Error("objective_wave_submission_identity_invalid")
    }
    ordinals.add(slot.ordinal); routes.add(slot.routeOrdinal); approvals.add(slot.reviewApprovalId)
    tasks.add(slot.applicationTaskId); jobs.add(slot.jobId)
  }
  if (slots.filter(slot => slot.corrected).length < 1) throw new Error("objective_wave_corrected_slot_missing")
}

function validSlot(slot: ObjectiveWaveSubmissionSlot): boolean {
  return Number.isInteger(slot.ordinal) && slot.ordinal >= 1 && slot.ordinal <= 8
    && Number.isInteger(slot.routeOrdinal) && slot.routeOrdinal >= 1 && slot.routeOrdinal <= 8
    && id(slot.reviewApprovalId) && id(slot.applicationTaskId) && id(slot.jobId)
    && typeof slot.corrected === "boolean" && /^[a-f0-9]{64}$/.test(slot.expectedCoverLetterSha256)
}

function validateDeferred(scope: ObjectiveWaveScope, slots: readonly ObjectiveWaveSubmissionSlot[], stale: ObjectiveWaveSubmissionSlot,
  proofs: readonly ObjectiveWaveDeferredProof[]): ReadonlyMap<string, string> {
  if (proofs.length !== 5 || proofs.some(proof => sameSlot(stale, proof))) throw new Error("objective_wave_deferred_set_invalid")
  const outboxIds = new Set<string>(), byApproval = new Map<string, string>()
  for (const slot of slots) {
    const matches = proofs.filter(proof => sameSlot(slot, proof) && proof.userId === scope.userId
      && proof.sessionId === scope.sessionId && proof.reviewTurnId === scope.reviewTurnId
      && proof.outboxTopic === "agent.objective-reviewed-fill.dispatch" && proof.outboxAggregateId === scope.sessionId
      && proof.idempotencyKey === `agent-objective-reviewed-fill:${slot.reviewApprovalId}`
      && proof.predecessorTurnId === scope.reviewTurnId
      && proof.schemaVersion === "agent-harness.v2.objective-reviewed-fill-handoff.v1"
      && proof.acknowledgement === "deferred" && proof.published === false && id(proof.outboxId)
      && !outboxIds.has(proof.outboxId))
    if (matches.length !== 1) throw new Error("objective_wave_deferred_proof_mismatch")
    outboxIds.add(matches[0]!.outboxId)
    byApproval.set(slot.reviewApprovalId, matches[0]!.outboxId)
  }
  return byApproval
}

function validateStale(scope: ObjectiveWaveScope, slot: ObjectiveWaveSubmissionSlot, proof: ObjectiveWaveStaleSlotProof): void {
  if (!sameSlot(slot, proof) || proof.userId !== scope.userId || proof.sessionId !== scope.sessionId
    || proof.reviewTurnId !== scope.reviewTurnId || proof.approvalStatus !== "expired"
    || proof.taskStatus !== "waiting_for_user" || proof.checkpoint !== "materials_ready"
    || proof.fillTurnId !== null || proof.workerTaskId !== null || proof.outboxCount !== 0
    || proof.browserStartCount !== 0 || proof.routeGets !== 0 || proof.routePostAttempts !== 0) {
    throw new Error("objective_wave_stale_proof_invalid")
  }
}

function validateHandoff(scope: ObjectiveWaveScope, slot: ObjectiveWaveSubmissionSlot, proof: ObjectiveWaveHandoffProof,
  deferredOutboxId: string | undefined): void {
  if (!sameSlot(slot, proof) || proof.userId !== scope.userId || proof.sessionId !== scope.sessionId
    || proof.reviewTurnId !== scope.reviewTurnId || !id(proof.fillTurnId) || !id(proof.outboxId)
    || proof.outboxId !== deferredOutboxId
    || proof.outboxTopic !== "agent.objective-reviewed-fill.dispatch" || proof.outboxAggregateId !== scope.sessionId
    || proof.idempotencyKey !== `agent-objective-reviewed-fill:${slot.reviewApprovalId}`
    || proof.predecessorTurnId !== scope.reviewTurnId || proof.schemaVersion !== "agent-harness.v2.objective-reviewed-fill-handoff.v1"
    || (proof.acknowledgement !== "queued" && proof.acknowledgement !== "duplicate")
    || proof.published !== true || proof.publishAttemptCount !== 1
    || !counter(proof.routeGetsBefore) || !counter(proof.routePostAttemptsBefore)
    || !counter(proof.routePostValidBefore) || !counter(proof.routePostMalformedBefore)) {
    throw new Error("objective_wave_handoff_proof_invalid")
  }
}

function validateSubmission(scope: ObjectiveWaveScope, slot: ObjectiveWaveSubmissionSlot, handoff: ObjectiveWaveHandoffProof,
  proof: ObjectiveWaveSubmissionProof, expectedRestartCount: 0 | 1): void {
  const durable = proof.durable, task = durable.task, turn = durable.turn
  const root = durable.root, job = durable.job, approval = durable.approval
  const result = durable.result, execution = durable.execution, attempt = durable.attempt
  const finalization = durable.finalization, site = proof.site
  if (durable.scope.userId !== scope.userId || durable.scope.sessionId !== scope.sessionId
    || durable.scope.reviewTurnId !== scope.reviewTurnId || !sameSlot(slot, durable.slot)
    || durable.fillTurnId !== handoff.fillTurnId || task.id !== slot.applicationTaskId
    || task.status !== "submitted" || task.checkpoint !== "submission_verified" || !id(task.workerTaskId)
    || turn.id !== handoff.fillTurnId || turn.status !== "completed" || !id(turn.rootTaskId)
    || turn.sourceApprovalId !== slot.reviewApprovalId || root.id !== turn.rootTaskId
    || root.status !== "completed" || root.leaseFree !== true || job.id !== slot.jobId
    || job.status !== "applied" || job.workflowState !== "submitted"
    || approval.id !== `application-fill:${slot.applicationTaskId}:${handoff.fillTurnId}`
    || approval.taskId !== slot.applicationTaskId || approval.turnId !== handoff.fillTurnId
    || approval.jobId !== slot.jobId || approval.status !== "consumed"
    || result.count !== 1 || result.jobId !== slot.jobId || result.status !== "submitted"
    || !id(result.executionId) || !id(result.attemptId) || !Number.isSafeInteger(result.applyResultId)
    || execution.startedCount !== 1 || execution.settledCount !== 1
    || attempt.count !== 1 || attempt.id !== result.attemptId || attempt.receiptId !== approval.id || attempt.state !== "submitted"
    || finalization.count !== 1 || finalization.itemStatus !== "completed"
    || finalization.finalItemId !== root.finalItemId
    || proof.restartCount !== expectedRestartCount
    || site.routeOrdinal !== slot.routeOrdinal || !counter(site.getsAfter)
    || !counter(site.postAttemptsAfter) || !counter(site.postValidAfter) || !counter(site.postMalformedAfter)
    || site.getsAfter - handoff.routeGetsBefore !== 2
    || site.postAttemptsAfter - handoff.routePostAttemptsBefore !== 1
    || site.postValidAfter - handoff.routePostValidBefore !== 1
    || site.postMalformedAfter - handoff.routePostMalformedBefore !== 0
    || site.coverLetterSha256 !== slot.expectedCoverLetterSha256) {
    throw new Error("objective_wave_submission_proof_mismatch")
  }
}

function validateRestart(proof: ObjectiveWaveRestartProof): void {
  if (proof.projectionBlocked !== true || proof.committedResultBeforeCrash !== true
    || proof.capturedWorkerKilled !== true || proof.workerExitObserved !== true
    || proof.barrierUnblocked !== true || proof.successorStartedOnce !== true || proof.successorReady !== true) {
    throw new Error("objective_wave_restart_proof_invalid")
  }
}

function validateWindow(proof: ObjectiveWaveWindowProof): void {
  if (proof.expired !== true || proof.completedApplications !== 2 || proof.expectedCounter !== 4
    || proof.userCounterPreserved !== true) throw new Error("objective_wave_window_proof_invalid")
}

function sameSlot(slot: ObjectiveWaveSubmissionSlot, value: ObjectiveWaveSubmissionSlot): boolean {
  return slot.ordinal === value.ordinal && slot.routeOrdinal === value.routeOrdinal
    && slot.reviewApprovalId === value.reviewApprovalId && slot.applicationTaskId === value.applicationTaskId
    && slot.jobId === value.jobId && slot.corrected === value.corrected
}

function recordDistinctSubmissionIds(proof: ObjectiveWaveSubmissionProof, seen: Set<string>): void {
  const durable = proof.durable
  const ids = [durable.fillTurnId, durable.turn.rootTaskId, durable.task.workerTaskId, durable.approval.id,
    durable.result.executionId, durable.result.attemptId, String(durable.result.applyResultId)]
  if (ids.some(value => !id(value) || seen.has(value))) throw new Error("objective_wave_submission_identity_reused")
  for (const value of ids) seen.add(value)
}

function counter(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 }
function id(value: string): boolean { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
import type { ObjectiveWaveSubmissionEvidence } from "./application-task-full-loop.objective-wave-evidence"
