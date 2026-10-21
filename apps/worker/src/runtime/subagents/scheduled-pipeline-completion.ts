import { signalWasInterrupted } from "../interrupt/registry.js"
import { isSessionPauseRequestedError } from "../session-gate.js"
import { TurnStateRefreshRetryError, isTurnStateRefreshRetryError } from "../turns/turn-execution-question.js"
import { SCHEDULED_PIPELINE_COMPLETION, type ScheduledPipelineCompletionDisposition, type TurnEngineCompletionGate } from "../turns/turn-execution-types.js"
import { postScheduledPipelineContinuation, scheduledTaskGraphContinuationKey, type ScheduledPipelineAnalyzeCheckpointProof } from "./scheduled-pipeline-handoff.js"
import type { ScheduledAutomationPipelineAttestation, ScheduledAutomationPipelineBridgeResult, ScheduledAutomationPipelineBridgeScope } from "./scheduled-automation-pipeline-bridge.js"
import type { ScheduledPipelineCandidate, ScheduledPipelineCandidateIdentity } from "./scheduled-pipeline-candidate-store.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { scheduledPrepareChoiceWaitId } from "../turns/turn-question-contract.js"
import { parseScheduledTaskGraphContinuationReceipt, scheduledTaskGraphStableContinuationKey } from "./scheduled-taskgraph-continuation-receipt.js"

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
  signal: AbortSignal
}>
/** Must idempotently append or schedule Prepare under this exact root and replay its durable wait. */
export type ScheduledPipelinePrepareContinuation = (input: ScheduledPipelinePrepareContinuationInput) => Promise<ScheduledPipelinePrepareContinuationResult>

export async function completeScheduledPipelineBeforeTerminal(input: Readonly<{
  owner: ScheduledAutomationPipelineBridgeScope
  executionOwner: TurnExecutionOwnerFence
  candidateText: string
  stageCandidate(input: ScheduledPipelineCandidateIdentity & { candidateText: string }): Promise<void>
  finalStepId: string
  finalStepOrdinal: number
  rootAttemptCount: number
  signal: AbortSignal
  bridge: (scope: ScheduledAutomationPipelineBridgeScope) => Promise<ScheduledAutomationPipelineBridgeResult>
  continueAfterAnalyze?: ScheduledPipelinePrepareContinuation
  recoveredCandidate?: ScheduledPipelineCandidate
  fetcher?: typeof fetch
  isOwnershipLost?: (error: unknown, signal: AbortSignal) => boolean
}>): Promise<ScheduledPipelineCompletionDisposition> {
  try {
    if (input.executionOwner.userId !== input.owner.userId || input.executionOwner.sessionId !== input.owner.sessionId
      || input.executionOwner.turnId !== input.owner.turnId || input.executionOwner.rootTaskId !== input.owner.rootTaskId
      || input.executionOwner.ownerId !== input.owner.turnLeaseOwnerId || input.executionOwner.leaseVersion !== input.owner.turnLeaseVersion
      || input.rootAttemptCount !== input.owner.rootAttemptCount) throw new Error("scheduled_candidate_owner_invalid")
    const evidence = await input.bridge(input.owner)
    if (evidence.status === "blocked") return { status: "blocked", errorCode: `scheduled_pipeline_${evidence.reasonCode}` }
    await input.stageCandidate({ owner: input.executionOwner,
      rootAttemptCount: input.rootAttemptCount,
      finalStepId: input.finalStepId, finalStepOrdinal: input.finalStepOrdinal, candidateText: input.candidateText })
    const continuation = await postScheduledPipelineContinuation({ owner: input.owner, attestation: evidence.attestation }, input.signal, input.fetcher)
    if (continuation.status === "blocked") return { status: "blocked", errorCode: continuation.errorCode }
    if (continuation.status === "waiting_for_user") return { status: "waiting_for_external_user", externalWaitId: continuation.waitId, candidateText: input.candidateText }
    if (continuation.status === "analyze_checkpointed") {
      if (!input.continueAfterAnalyze) return { status: "blocked", errorCode: "scheduled_pipeline_prepare_continuation_unavailable" }
      const prepared = parsePrepareContinuationResult(await input.continueAfterAnalyze({ owner: input.owner, executionOwner: input.executionOwner,
        attestation: evidence.attestation, proof: continuation.proof, candidateText: input.candidateText,
        finalStepId: input.finalStepId, finalStepOrdinal: input.finalStepOrdinal, signal: input.signal }), input.owner,
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
      return { status: "completed", candidateText: input.candidateText }
    }
    return { status: "completed", candidateText: input.candidateText }
  } catch (error: unknown) {
    if (isTurnStateRefreshRetryError(error) || isSessionPauseRequestedError(error) || signalWasInterrupted(input.signal)
      || input.signal.aborted || input.isOwnershipLost?.(error, input.signal)) throw error
    throw new TurnStateRefreshRetryError()
  }
}

export function attachScheduledPipelineCompletion(input: Readonly<{
  gate: TurnEngineCompletionGate | undefined
  owner: ScheduledAutomationPipelineBridgeScope | undefined
  recoveredCandidate?: ScheduledPipelineCandidate
  bridge: (scope: ScheduledAutomationPipelineBridgeScope) => Promise<ScheduledAutomationPipelineBridgeResult>
  continueAfterAnalyze?: ScheduledPipelinePrepareContinuation
  fetcher?: typeof fetch
  onWebAccepted(): void
  stageCandidate(input: ScheduledPipelineCandidateIdentity & { candidateText: string }): Promise<void>
  rootAttemptCount: number
}>): TurnEngineCompletionGate | undefined {
  if (!input.gate || !input.owner) return input.gate
  input.gate[SCHEDULED_PIPELINE_COMPLETION] = async ({ identity, candidateText, signal, stepId, stepOrdinal, isOwnershipLost }) => {
    if (identity.kind !== "turn" || identity.taskId !== input.owner!.rootTaskId) throw new Error("scheduled_candidate_owner_invalid")
    const recovered = input.recoveredCandidate?.candidateText === candidateText ? input.recoveredCandidate : undefined
    const disposition = await completeScheduledPipelineBeforeTerminal({ owner: input.owner!, executionOwner: identity, candidateText, signal,
      stageCandidate: input.stageCandidate, rootAttemptCount: input.rootAttemptCount,
      finalStepId: recovered?.finalStepId ?? stepId, finalStepOrdinal: recovered?.finalStepOrdinal ?? stepOrdinal,
      bridge: input.bridge, ...(input.continueAfterAnalyze ? { continueAfterAnalyze: input.continueAfterAnalyze } : {}),
      ...(input.fetcher ? { fetcher: input.fetcher } : {}), ...(isOwnershipLost ? { isOwnershipLost } : {}) })
    if (disposition.status === "completed" || disposition.status === "waiting_for_user" || disposition.status === "waiting_for_external_user"
      || disposition.status === "waiting_for_dependency") input.onWebAccepted()
    return disposition
  }
  return input.gate
}

function parsePrepareContinuationResult(value: unknown, owner: ScheduledAutomationPipelineBridgeScope,
  attestation: ScheduledAutomationPipelineAttestation, handoff: ScheduledPipelineAnalyzeCheckpointProof,
  finalStepId: string, finalStepOrdinal: number): ScheduledPipelinePrepareContinuationResult | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== "string" || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null
    }
    const result = value as Record<string, unknown>
    if (result.status === "waiting_for_dependency" && keys.length === 2 && keys.includes("waitId")
      && typeof result.waitId === "string" && result.waitId.trim() === result.waitId
      && result.waitId.length > 0 && result.waitId.length <= 128) return { status: "waiting_for_dependency", waitId: result.waitId }
    if (result.status === "waiting_for_choice" && keys.length === 2 && keys.includes("waitId")
      && typeof result.waitId === "string" && result.waitId.trim() === result.waitId
      && result.waitId.length > 0 && result.waitId.length <= 256) return { status: "waiting_for_choice", waitId: result.waitId }
    if (result.status !== "ready" || keys.length !== 3 || !keys.includes("prepareProof") || !keys.includes("choice")) return null
    const choice = strictRecord(result.choice)
    const choiceRequired = choice?.required === true && Object.keys(choice).sort().join(",") === "required,scheduledWaitId,status"
      && choice.status === "answered" && typeof choice.scheduledWaitId === "string" && choice.scheduledWaitId.trim() === choice.scheduledWaitId
      && choice.scheduledWaitId.length > 0 && choice.scheduledWaitId.length <= 256
    const choiceDisabled = choice?.required === false && Object.keys(choice).sort().join(",") === "required"
    if (!choiceRequired && !choiceDisabled) return null
    const proof = strictRecord(result.prepareProof), receipt = parseScheduledTaskGraphContinuationReceipt(proof?.receipt)
    const completion = strictRecord(proof?.completion), wait = strictRecord(completion?.wait)
    const nodes = completion?.nodes
    if (!proof || Object.keys(proof).sort().join(",") !== "completion,receipt,result" || !receipt || !completion || !wait
      || Object.keys(completion).sort().join(",") !== "graphRevision,nodes,schemaVersion,wait"
      || !Number.isSafeInteger(completion.graphRevision) || Number(completion.graphRevision) < receipt.prepareScheduleRevision
      || !Array.isArray(nodes) || nodes.length !== 3 || !Array.isArray(wait.targetTaskIds) || !Array.isArray(wait.matchedTaskIds)
      || Object.keys(wait).sort().join(",") !== "matchedTaskIds,mode,status,targetTaskIds,waitId"
      || wait.status !== "ready" || wait.mode !== "all" || wait.targetTaskIds.length !== 1 || wait.matchedTaskIds.length !== 1
      || wait.targetTaskIds[0] !== nodes[2]?.taskId || wait.matchedTaskIds[0] !== nodes[2]?.taskId
      || typeof wait.waitId !== "string" || wait.waitId.trim() !== wait.waitId || wait.waitId.length < 1 || wait.waitId.length > 128
      || !prepareProofMatches(owner, attestation, handoff, receipt, nodes)
      || choiceRequired && scheduledPrepareChoiceWaitId({ receipt, finalStepId, finalStepOrdinal }) !== choice.scheduledWaitId) return null
    return { status: "ready", prepareProof: result.prepareProof,
      choice: choiceRequired ? { required: true, status: "answered", scheduledWaitId: choice!.scheduledWaitId as string } : { required: false } }
  } catch { return null }
}

function prepareProofMatches(owner: ScheduledAutomationPipelineBridgeScope, attestation: ScheduledAutomationPipelineAttestation,
  handoff: ScheduledPipelineAnalyzeCheckpointProof, receipt: NonNullable<ReturnType<typeof parseScheduledTaskGraphContinuationReceipt>>,
  nodes: unknown[]): boolean {
  const receiptOwner = receipt.owner, scout = strictRecord(nodes[0]), analyst = strictRecord(nodes[1]), prepare = strictRecord(nodes[2])
  return receiptOwner.userId === owner.userId && receiptOwner.sessionId === owner.sessionId && receiptOwner.turnId === owner.turnId
    && receiptOwner.rootTaskId === owner.rootTaskId && receiptOwner.rootAttemptCount === owner.rootAttemptCount
    && receiptOwner.turnLeaseOwnerId === owner.turnLeaseOwnerId && receiptOwner.turnLeaseVersion === owner.turnLeaseVersion
    && receiptOwner.executionId === handoff.executionId && receiptOwner.executionAttemptCount === handoff.executionAttemptCount
    && handoff.continuationKey === scheduledTaskGraphContinuationKey(owner, attestation, handoff.executionId, handoff.executionAttemptCount)
    && receipt.continuationKey === scheduledTaskGraphStableContinuationKey(receipt)
    && receipt.snapshotDigest === attestation.snapshotDigest && receipt.evidenceDigest === attestation.evidenceDigest
    && receipt.checkpointDigest === handoff.checkpointDigest && receipt.analyzeGraphRevision === attestation.graphRevision
    && receipt.prepareScheduleRevision === attestation.graphRevision + 1
    && scout?.taskId === attestation.scout.taskId && scout.role === "scout" && scout.status === "completed"
    && analyst?.taskId === attestation.analyst.taskId && analyst.role === "analyst" && analyst.status === "completed"
    && prepare?.role === "prepare" && prepare.status === "completed"
}

function strictRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  return value as Record<string, unknown>
}
