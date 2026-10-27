import { signalWasInterrupted } from "../interrupt/registry.js"
import { isSessionPauseRequestedError } from "../session-gate.js"
import { TurnStateRefreshRetryError, isTurnStateRefreshRetryError } from "../turns/turn-execution-question.js"
import { SCHEDULED_PIPELINE_COMPLETION, SCHEDULED_PIPELINE_EXISTING_AUDIT_RESUME, type ScheduledPipelineCompletionDisposition,
  type ScheduledPipelineExistingAuditResumeDisposition, type TurnEngineCompletionGate } from "../turns/turn-execution-types.js"
import { postScheduledPipelineContinuation, scheduledTaskGraphContinuationKey, type ScheduledPipelineAnalyzeCheckpointProof } from "./scheduled-pipeline-handoff.js"
import type { ScheduledAutomationPipelineAttestation, ScheduledAutomationPipelineBridgeResult, ScheduledAutomationPipelineBridgeScope } from "./scheduled-automation-pipeline-bridge.js"
import type { ScheduledPipelineCandidate, ScheduledPipelineCandidateIdentity } from "./scheduled-pipeline-candidate-store.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { parseScheduledTaskGraphContinuationReceipt, scheduledTaskGraphStableContinuationKey } from "./scheduled-taskgraph-continuation-receipt.js"
import type { ScheduledPipelineGateContinuationInput, ScheduledPipelineGateContinuationResult } from "./scheduled-automation-gate-bridge.js"
import { parseScheduledPipelinePrepareContinuationResult } from "./scheduled-pipeline-completion-proof.js"

export type ScheduledPipelineDependencyWait = Readonly<{ status: "waiting_for_dependency"; waitId: string }>
export type ScheduledPipelineChoiceWait = Readonly<{ status: "waiting_for_choice"; waitId: string }>
export type ScheduledPipelinePrepareChoice = Readonly<{ required: true; status: "answered"; scheduledWaitId: string }>
  | Readonly<{ required: false }>
export type ScheduledPipelineReadyPrepare = Readonly<{ status: "ready"; prepareProof: unknown; choice: ScheduledPipelinePrepareChoice }>
export type ScheduledPipelinePrepareContinuationResult = ScheduledPipelineDependencyWait | ScheduledPipelineChoiceWait | ScheduledPipelineReadyPrepare
export type ScheduledPipelinePrepareContinuationInput = Readonly<{
  owner: ScheduledAutomationPipelineBridgeScope
  executionOwner: TurnExecutionOwnerFence
  attestation: ScheduledAutomationPipelineAttestation
  proof: ScheduledPipelineAnalyzeCheckpointProof
  candidateText: string
  finalStepId: string
  finalStepOrdinal: number
  recoveryStepId: string
  signal: AbortSignal
}>
/** Must idempotently append or schedule Prepare under this exact root and replay its durable wait. */
export type ScheduledPipelinePrepareContinuation = (input: ScheduledPipelinePrepareContinuationInput) => Promise<ScheduledPipelinePrepareContinuationResult>
export type ScheduledPipelineGateContinuation = (input: ScheduledPipelineGateContinuationInput) => Promise<ScheduledPipelineGateContinuationResult>

export async function completeScheduledPipelineBeforeTerminal(input: Readonly<{
  owner: ScheduledAutomationPipelineBridgeScope
  executionOwner: TurnExecutionOwnerFence
  candidateText: string
  stageCandidate(input: ScheduledPipelineCandidateIdentity & { candidateText: string }): Promise<void>
  finalStepId: string
  finalStepOrdinal: number
  /** Current active Step for new waits and TaskGraph commands; finalStepId remains the candidate source. */
  recoveryStepId: string
  rootAttemptCount: number
  signal: AbortSignal
  bridge: (scope: ScheduledAutomationPipelineBridgeScope) => Promise<ScheduledAutomationPipelineBridgeResult>
  continueAfterAnalyze?: ScheduledPipelinePrepareContinuation
  continueAfterGate?: ScheduledPipelineGateContinuation
  recoveredCandidate?: ScheduledPipelineCandidate
  fetcher?: typeof fetch
  isOwnershipLost?: (error: unknown, signal: AbortSignal) => boolean
}>): Promise<ScheduledPipelineCompletionDisposition> {
  try {
    if (input.executionOwner.userId !== input.owner.userId || input.executionOwner.sessionId !== input.owner.sessionId
      || input.executionOwner.turnId !== input.owner.turnId || input.executionOwner.rootTaskId !== input.owner.rootTaskId
      || input.executionOwner.ownerId !== input.owner.turnLeaseOwnerId || input.executionOwner.leaseVersion !== input.owner.turnLeaseVersion
      || input.rootAttemptCount !== input.owner.rootAttemptCount) throw new Error("scheduled_candidate_owner_invalid")
    const candidate = { owner: input.executionOwner, rootAttemptCount: input.rootAttemptCount,
      finalStepId: input.finalStepId, finalStepOrdinal: input.finalStepOrdinal, candidateText: input.candidateText }
    const resumeAudit = async (stage = true): Promise<ScheduledPipelineCompletionDisposition | null> => {
      if (!input.continueAfterGate) return null
      const result = await input.continueAfterGate({ owner: input.owner, executionOwner: input.executionOwner,
        mode: "resume_audit", finalStepId: input.finalStepId, recoveryStepId: input.recoveryStepId, signal: input.signal })
      if (result.status === "not_registered") return null
      if (result.status === "gate_continuation") {
        const evidence = await input.bridge(input.owner)
        if (evidence.status === "blocked") return { status: "blocked", errorCode: `scheduled_pipeline_${evidence.reasonCode}` }
        if (!recoveredGateMatches(input.owner, evidence.attestation, result)) {
          return { status: "blocked", errorCode: "scheduled_pipeline_gate_recovery_invalid" }
        }
        if (stage) await input.stageCandidate(candidate)
        const continued = await input.continueAfterGate({ owner: input.owner, executionOwner: input.executionOwner,
          attestation: evidence.attestation, handoff: result.handoff, prepareProof: result.prepareProof,
          ...(result.scheduledWaitId ? { scheduledWaitId: result.scheduledWaitId } : {}),
          finalStepId: input.finalStepId, recoveryStepId: input.recoveryStepId, signal: input.signal })
        return mapGateContinuationResult(continued, input.candidateText)
      }
      if (result.status === "blocked") return result
      if (result.status === "completed") {
        if (stage) await input.stageCandidate(candidate)
        return { status: "completed", candidateText: input.candidateText }
      }
      if (result.status === "waiting_for_dependency") {
        if (stage) await input.stageCandidate(candidate)
        return { status: result.status, waitId: result.waitId, candidateText: input.candidateText }
      }
      return { status: "blocked", errorCode: "scheduled_audit_resume_result_invalid" }
    }
    if (input.continueAfterGate) {
      const recovered = await resumeAudit()
      if (recovered) return recovered
    }
    const evidence = await input.bridge(input.owner)
    if (evidence.status === "blocked") return { status: "blocked", errorCode: `scheduled_pipeline_${evidence.reasonCode}` }
    await input.stageCandidate(candidate)
    const continuation = await postScheduledPipelineContinuation({ owner: input.owner, attestation: evidence.attestation }, input.signal, input.fetcher)
    if (continuation.status === "blocked") return { status: "blocked", errorCode: continuation.errorCode }
    if (continuation.status === "waiting_for_user") return { status: "waiting_for_external_user", externalWaitId: continuation.waitId, candidateText: input.candidateText }
    if (continuation.status === "completed") {
      if (!input.continueAfterGate) return { status: "completed", candidateText: input.candidateText }
      return await resumeAudit(false) ?? { status: "blocked", errorCode: "scheduled_audit_not_registered" }
    }
    if (continuation.status === "analyze_checkpointed") {
      if (!input.continueAfterAnalyze) return { status: "blocked", errorCode: "scheduled_pipeline_prepare_continuation_unavailable" }
      const prepared = parseScheduledPipelinePrepareContinuationResult(await input.continueAfterAnalyze({ owner: input.owner, executionOwner: input.executionOwner,
        attestation: evidence.attestation, proof: continuation.proof, candidateText: input.candidateText,
        finalStepId: input.finalStepId, finalStepOrdinal: input.finalStepOrdinal, recoveryStepId: input.recoveryStepId, signal: input.signal }), input.owner,
        evidence.attestation, continuation.proof, input.finalStepId, input.finalStepOrdinal)
      if (!prepared) return { status: "blocked", errorCode: "scheduled_pipeline_prepare_proof_invalid" }
      if (prepared.status === "waiting_for_dependency") return { status: prepared.status, waitId: prepared.waitId, candidateText: input.candidateText }
      if (prepared.status === "waiting_for_choice") return { status: "waiting_for_user", waitId: prepared.waitId, candidateText: input.candidateText }
      const gate = await postScheduledPipelineContinuation({ owner: input.owner, attestation: evidence.attestation,
        prepareProof: prepared.prepareProof, ...(prepared.choice.required ? { scheduledWaitId: prepared.choice.scheduledWaitId } : {}) }, input.signal, input.fetcher)
      if (gate.status === "blocked") return { status: "blocked", errorCode: gate.errorCode }
      if (gate.status === "waiting_for_user") {
        if (gate.waitKind === "scheduled_prepare") return { status: "waiting_for_external_user", externalWaitId: gate.waitId,
          scheduledWaitId: gate.scheduledWaitId, candidateText: input.candidateText }
        return { status: "waiting_for_external_user", externalWaitId: gate.waitId, candidateText: input.candidateText }
      }
      if (gate.status === "analyze_checkpointed") return { status: "blocked", errorCode: "scheduled_pipeline_prepare_proof_not_accepted" }
      if (gate.status !== "gate_checkpointed" || !input.continueAfterGate) {
        return { status: "blocked", errorCode: "scheduled_pipeline_gate_checkpoint_missing" }
      }
      const gateResult = await input.continueAfterGate({ owner: input.owner, executionOwner: input.executionOwner,
        attestation: evidence.attestation, handoff: continuation.proof,
        prepareProof: prepared.prepareProof as Extract<ScheduledPipelineGateContinuationInput, { prepareProof: unknown }>["prepareProof"],
        ...(prepared.choice.required ? { scheduledWaitId: prepared.choice.scheduledWaitId } : {}),
        finalStepId: input.finalStepId, recoveryStepId: input.recoveryStepId, signal: input.signal })
      return mapGateContinuationResult(gateResult, input.candidateText)
    }
    return { status: "blocked", errorCode: "scheduled_pipeline_handoff_result_invalid" }
  } catch (error: unknown) {
    if (isTurnStateRefreshRetryError(error) || isSessionPauseRequestedError(error) || signalWasInterrupted(input.signal)
      || input.signal.aborted || input.isOwnershipLost?.(error, input.signal)) throw error
    throw new TurnStateRefreshRetryError()
  }
}
function mapGateContinuationResult(result: ScheduledPipelineGateContinuationResult, candidateText: string): ScheduledPipelineCompletionDisposition {
  if (result.status === "waiting_for_dependency") return { status: result.status, waitId: result.waitId, candidateText }
  if (result.status === "waiting_for_choice") return { status: "waiting_for_scheduled_gate_choice", waitId: result.waitId,
    question: result.question, binding: result.binding, candidateText }
  if (result.status === "waiting_for_external_user") return { status: result.status, externalWaitId: result.waitId, candidateText }
  if (result.status === "blocked") return result
  if (result.status === "completed") return { status: "completed", candidateText }
  return { status: "blocked", errorCode: result.status === "not_registered" ? "scheduled_audit_not_registered" : "scheduled_pipeline_gate_recovery_unexpected" }
}
function recoveredGateMatches(owner: ScheduledAutomationPipelineBridgeScope, attestation: ScheduledAutomationPipelineAttestation, recovery: Extract<ScheduledPipelineGateContinuationResult, { status: "gate_continuation" }>): boolean {
  const { handoff, prepareProof } = recovery, receipt = prepareProof.receipt, bound = receipt.owner
  return attestation.owner.userId === owner.userId && attestation.owner.sessionId === owner.sessionId
    && attestation.owner.turnId === owner.turnId && attestation.owner.rootTaskId === owner.rootTaskId
    && attestation.owner.rootAttemptCount === owner.rootAttemptCount
    && attestation.owner.turnLeaseOwnerId === owner.turnLeaseOwnerId && attestation.owner.turnLeaseVersion === owner.turnLeaseVersion
    && handoff.status === "analyze_checkpointed" && /^sha256:[a-f0-9]{64}$/.test(handoff.claimTokenDigest)
    && handoff.continuationKey === scheduledTaskGraphContinuationKey(owner, attestation, handoff.executionId, handoff.executionAttemptCount)
    && bound.userId === owner.userId && bound.sessionId === owner.sessionId && bound.turnId === owner.turnId
    && bound.rootTaskId === owner.rootTaskId && bound.rootAttemptCount === owner.rootAttemptCount
    && bound.executionId === handoff.executionId && bound.executionAttemptCount === handoff.executionAttemptCount
    && receipt.continuationKey === scheduledTaskGraphStableContinuationKey(receipt)
    && receipt.snapshotDigest === attestation.snapshotDigest && receipt.evidenceDigest === attestation.evidenceDigest
    && receipt.checkpointDigest === handoff.checkpointDigest
    && receipt.analyzeGraphRevision === attestation.graphRevision && receipt.prepareScheduleRevision === attestation.graphRevision + 1
    && (recovery.scheduledWaitId === undefined || validWaitId(recovery.scheduledWaitId))
}
function validWaitId(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 }

export function attachScheduledPipelineCompletion(input: Readonly<{
  gate: TurnEngineCompletionGate | undefined
  owner: ScheduledAutomationPipelineBridgeScope | undefined
  recoveredCandidate?: ScheduledPipelineCandidate
  bridge: (scope: ScheduledAutomationPipelineBridgeScope) => Promise<ScheduledAutomationPipelineBridgeResult>
  continueAfterAnalyze?: ScheduledPipelinePrepareContinuation
  continueAfterGate?: ScheduledPipelineGateContinuation
  fetcher?: typeof fetch
  onWebAccepted(): void
  stageCandidate(input: ScheduledPipelineCandidateIdentity & { candidateText: string }): Promise<void>
  rootAttemptCount: number
}>): TurnEngineCompletionGate | undefined {
  if (!input.gate || !input.owner) return input.gate
  delete input.gate[SCHEDULED_PIPELINE_EXISTING_AUDIT_RESUME]
  input.gate[SCHEDULED_PIPELINE_COMPLETION] = async ({ identity, candidateText, signal, stepId, stepOrdinal, isOwnershipLost }) => {
    if (identity.kind !== "turn" || identity.taskId !== input.owner!.rootTaskId) throw new Error("scheduled_candidate_owner_invalid")
    const recovered = input.recoveredCandidate?.candidateText === candidateText ? input.recoveredCandidate : undefined
    const disposition = await completeScheduledPipelineBeforeTerminal({ owner: input.owner!, executionOwner: identity, candidateText, signal,
      stageCandidate: input.stageCandidate, rootAttemptCount: input.rootAttemptCount,
      finalStepId: recovered?.finalStepId ?? stepId, finalStepOrdinal: recovered?.finalStepOrdinal ?? stepOrdinal,
      recoveryStepId: stepId,
      bridge: input.bridge, ...(input.continueAfterAnalyze ? { continueAfterAnalyze: input.continueAfterAnalyze } : {}),
      ...(input.continueAfterGate ? { continueAfterGate: input.continueAfterGate } : {}),
      ...(input.fetcher ? { fetcher: input.fetcher } : {}), ...(isOwnershipLost ? { isOwnershipLost } : {}) })
    if (disposition.status === "completed" || disposition.status === "waiting_for_user" || disposition.status === "waiting_for_scheduled_gate_choice"
      || disposition.status === "waiting_for_external_user"
      || disposition.status === "waiting_for_dependency") input.onWebAccepted()
    return disposition
  }
  const recovered = input.recoveredCandidate, owner = input.owner, resumeGate = input.continueAfterGate
  if (recovered && resumeGate && input.rootAttemptCount === owner.rootAttemptCount && recovered.recoverySource.rootAttemptCount === input.rootAttemptCount
    && recovered.recoverySource.owner.userId === owner.userId && recovered.recoverySource.owner.sessionId === owner.sessionId
    && recovered.recoverySource.owner.turnId === owner.turnId && recovered.recoverySource.owner.rootTaskId === owner.rootTaskId) {
    input.gate[SCHEDULED_PIPELINE_EXISTING_AUDIT_RESUME] = async ({ identity, candidateText, signal, stepId, isOwnershipLost }): Promise<ScheduledPipelineExistingAuditResumeDisposition> => {
      if (identity.kind !== "turn" || identity.taskId !== owner.rootTaskId || identity.rootTaskId !== owner.rootTaskId
        || identity.userId !== owner.userId || identity.sessionId !== owner.sessionId || identity.turnId !== owner.turnId
        || identity.ownerId !== owner.turnLeaseOwnerId || identity.leaseVersion !== owner.turnLeaseVersion
        || candidateText !== recovered.candidateText) return { status: "not_applicable" }
      try {
        const result = await resumeGate({ owner, executionOwner: identity, mode: "resume_audit",
          finalStepId: recovered.finalStepId, recoveryStepId: stepId, signal })
        if (result.status === "waiting_for_dependency" && result.waitId.trim() === result.waitId
          && result.waitId.length > 0 && result.waitId.length <= 128) {
          input.onWebAccepted()
          return { status: result.status, waitId: result.waitId }
        }
        if (result.status === "completed") { input.onWebAccepted(); return { status: "completed" } }
        return { status: "not_applicable" }
      } catch (error: unknown) {
        if (isTurnStateRefreshRetryError(error) || isSessionPauseRequestedError(error) || signalWasInterrupted(signal)
          || signal.aborted || isOwnershipLost?.(error, signal)) throw error
        throw new TurnStateRefreshRetryError()
      }
    }
  }
  return input.gate
}
