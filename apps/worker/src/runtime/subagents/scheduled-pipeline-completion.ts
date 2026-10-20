import { signalWasInterrupted } from "../interrupt/registry.js"
import { isSessionPauseRequestedError } from "../session-gate.js"
import { TurnStateRefreshRetryError, isTurnStateRefreshRetryError } from "../turns/turn-execution-question.js"
import { SCHEDULED_PIPELINE_COMPLETION, type ScheduledPipelineCompletionDisposition, type TurnEngineCompletionGate } from "../turns/turn-execution-types.js"
import { postScheduledPipelineContinuation } from "./scheduled-pipeline-handoff.js"
import type { ScheduledAutomationPipelineBridgeResult, ScheduledAutomationPipelineBridgeScope } from "./scheduled-automation-pipeline-bridge.js"
import type { ScheduledPipelineCandidateIdentity } from "./scheduled-pipeline-candidate-store.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"

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
    if (continuation.status === "waiting_for_user") return { status: "waiting_for_user", waitId: continuation.waitId, candidateText: input.candidateText }
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
  bridge: (scope: ScheduledAutomationPipelineBridgeScope) => Promise<ScheduledAutomationPipelineBridgeResult>
  fetcher?: typeof fetch
  onWebAccepted(): void
  stageCandidate(input: ScheduledPipelineCandidateIdentity & { candidateText: string }): Promise<void>
  rootAttemptCount: number
}>): TurnEngineCompletionGate | undefined {
  if (!input.gate || !input.owner) return input.gate
  input.gate[SCHEDULED_PIPELINE_COMPLETION] = async ({ identity, candidateText, signal, stepId, stepOrdinal, isOwnershipLost }) => {
    if (identity.kind !== "turn" || identity.taskId !== input.owner!.rootTaskId) throw new Error("scheduled_candidate_owner_invalid")
    const disposition = await completeScheduledPipelineBeforeTerminal({ owner: input.owner!, executionOwner: identity, candidateText, signal,
      stageCandidate: input.stageCandidate, rootAttemptCount: input.rootAttemptCount, finalStepId: stepId, finalStepOrdinal: stepOrdinal,
      bridge: input.bridge, ...(input.fetcher ? { fetcher: input.fetcher } : {}), ...(isOwnershipLost ? { isOwnershipLost } : {}) })
    if (disposition.status === "completed" || disposition.status === "waiting_for_user") input.onWebAccepted()
    return disposition
  }
  return input.gate
}
