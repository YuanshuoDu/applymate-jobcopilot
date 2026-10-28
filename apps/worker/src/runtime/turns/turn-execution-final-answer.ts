import type { TurnUsage } from "../budget.js"
import type { ScheduledPipelineCandidate } from "../subagents/scheduled-pipeline-candidate-store.js"
import { withScheduledPipelineCandidateModelOutput } from "../subagents/scheduled-pipeline-candidate-store.js"
import { SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY, type ScheduledPipelineRecoveryStepMarker } from "../subagents/scheduled-pipeline-recovery-step.js"
import type { StepContextSnapshot } from "../context/step-context-builder.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import type { ModelStepResult } from "./turn-engine-model.js"
import { TurnEngineError, type TurnEngineStep } from "./turn-engine-types.js"
import type { TurnExecutionEventWriter } from "./turn-execution-events.js"
import { completeTurnCandidate, type FinalCandidateOutcome } from "./turn-execution-final-candidate.js"
import { restoreTurnFinalAnswerEvidence, resolveTurnFinalAnswerMarkers } from "./turn-execution-evidence.js"
import { SCHEDULED_PIPELINE_COMPLETION, type TurnExecutionOptions } from "./turn-execution-types.js"

type FinalCandidateInput = Readonly<{
  options: TurnExecutionOptions
  writer: TurnExecutionEventWriter
  step: TurnEngineStep
  output: ModelStepResult
  bindingMap: Parameters<typeof resolveTurnFinalAnswerMarkers>[1]
  snapshot: StepContextSnapshot
  stepCount: number
  toolCallCount: number
  usage: TurnUsage
  signal: AbortSignal
  now: () => Date
  onStepClosed: (kind?: "native_semantic_receipt") => void
  scheduledCandidate?: Readonly<{
    owner: TurnExecutionOwnerFence
    finalStepId: string
    finalStepOrdinal: number
    finishReason: string
    usage: TurnUsage | null
    sourceReceipt: ScheduledPipelineCandidate["sourceReceipt"]
  }>
}>

export function resolveTurnExecutionFinalAnswer(output: ModelStepResult, bindingMap: FinalCandidateInput["bindingMap"]): {
  output: ModelStepResult
  finalResponseText: string
  answerEvidence?: unknown
} {
  const resolved = resolveTurnFinalAnswerMarkers(output.text, bindingMap)
  return { output, finalResponseText: resolved.text, ...(resolved.answerEvidence ? { answerEvidence: resolved.answerEvidence } : {}) }
}

export async function completeTurnExecutionFinalAnswer(input: FinalCandidateInput): Promise<FinalCandidateOutcome> {
  const { bindingMap, scheduledCandidate, ...completion } = input
  const resolved = resolveTurnExecutionFinalAnswer(input.output, bindingMap)
  const complete = () => completeTurnCandidate({ ...completion, ...resolved })
  const scheduled = scheduledCandidate ?? scheduledModelOutput(input, bindingMap)
  return scheduled ? withScheduledPipelineCandidateModelOutput({ ...scheduled, candidateText: input.output.text }, complete) : complete()
}

export async function replayScheduledFinalAnswer(input: Readonly<{
  options: TurnExecutionOptions
  writer: TurnExecutionEventWriter
  step: TurnEngineStep
  candidate: ScheduledPipelineCandidate
  recoveryMarker: ScheduledPipelineRecoveryStepMarker | undefined
  snapshot: StepContextSnapshot
  stepCount: number
  toolCallCount: number
  usage: TurnUsage
  signal: AbortSignal
  now: () => Date
  inputThroughSequence: bigint
  consumedInputIds: readonly string[]
  onSnapshot: (snapshot: StepContextSnapshot) => void
  onOutput: (output: ModelStepResult) => void
  onStepClosed: (kind?: "native_semantic_receipt") => void
}>): Promise<Readonly<{
  snapshot: StepContextSnapshot
  replayContext: Readonly<{ taskGraphRevision: StepContextSnapshot["taskGraphRevision"]; inputThroughSequence: bigint; consumedInputIds: readonly string[] }>
  outcome: FinalCandidateOutcome
}>> {
  const { options, writer, step, candidate } = input
  if (!input.recoveryMarker) throw new TurnEngineError("persistence_conflict", "Scheduled recovery marker is unavailable")
  if (!isModelFinishReason(candidate.finishReason)) throw new TurnEngineError("persistence_conflict", "Scheduled candidate finish reason is invalid")
  if (options.identity.kind !== "turn" || options.identity.taskId !== options.identity.rootTaskId) throw new TurnEngineError("persistence_conflict", "Scheduled candidate owner is invalid")

  await writer.append("step.started", step.id, null, { stepId: step.id, ordinal: step.ordinal, taskId: options.identity.taskId,
    [SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY]: input.recoveryMarker }, `step-started:${step.id}`)
  const snapshot = options.refreshTaskGraphBeforeStep ? await options.refreshTaskGraphBeforeStep(input.snapshot) : input.snapshot
  input.onSnapshot(snapshot)
  const output: ModelStepResult = { text: candidate.candidateText, reasoningSummary: "", toolCalls: [], provider: "scheduled_recovery",
    model: "recovered", finishReason: candidate.finishReason, usage: null, continuation: null }
  input.onOutput(output)
  const replayContext = { taskGraphRevision: snapshot.taskGraphRevision, inputThroughSequence: input.inputThroughSequence,
    consumedInputIds: input.consumedInputIds }
  const bindingMap = restoreTurnFinalAnswerEvidence(snapshot, candidate.sourceReceipt, { userId: options.identity.userId,
    sessionId: options.identity.sessionId, turnId: options.identity.turnId, taskId: options.identity.taskId, stepId: candidate.finalStepId })
  const outcome = await completeTurnExecutionFinalAnswer({ options, writer, step, output, bindingMap, snapshot,
    stepCount: input.stepCount, toolCallCount: input.toolCallCount, usage: input.usage, signal: input.signal, now: input.now,
    onStepClosed: input.onStepClosed, scheduledCandidate: { owner: options.identity, finalStepId: candidate.finalStepId,
      finalStepOrdinal: candidate.finalStepOrdinal, finishReason: candidate.finishReason, usage: candidate.usage, sourceReceipt: candidate.sourceReceipt } })
  return { snapshot, replayContext, outcome }
}

function scheduledModelOutput(input: FinalCandidateInput, bindingMap: FinalCandidateInput["bindingMap"]): NonNullable<FinalCandidateInput["scheduledCandidate"]> | undefined {
  const { identity, completionGate } = input.options
  if (identity.kind !== "turn" || identity.taskId !== identity.rootTaskId || !completionGate?.[SCHEDULED_PIPELINE_COMPLETION]) return undefined
  return { owner: identity, finalStepId: input.step.id, finalStepOrdinal: input.step.ordinal, finishReason: input.output.finishReason,
    usage: input.output.usage ?? null, sourceReceipt: bindingMap?.sourceReceipt ?? null }
}

function isModelFinishReason(value: string): value is ModelStepResult["finishReason"] {
  return value === "length" || value === "error" || value === "stop" || value === "tool_calls" || value === "content_filter"
}
