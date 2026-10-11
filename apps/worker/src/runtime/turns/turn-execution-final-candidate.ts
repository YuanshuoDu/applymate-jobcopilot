import type { TurnUsage } from "../budget.js"
import type { TurnExecutionEventWriter } from "./turn-execution-events.js"
import { NATIVE_SEMANTIC_NO_PROGRESS, NATIVE_SEMANTIC_REJECTION, RESET_NATIVE_SEMANTIC_PROGRESS, executionId, type TurnExecutionOptions } from "./turn-execution-types.js"
import { assertCompletionAllowed, steeringReconciliationGateRecovery, taskGraphGateRecovery } from "./turn-execution-completion-gate.js"
import { canEmitTurnCompleted, canPersistFinalResponse, totalTurnUsage, updateExecutionStep } from "./turn-engine-helpers.js"
import { finalizeTurn, serializeFinalResponse } from "../finalizer.js"
import { verifyCandidateFinal, snapshotEvidence } from "../verifier.js"
import { TurnEngineError, toRepositoryJson, type AtomicTurnCompletionResult, type TurnEngineResult, type TurnEngineStep } from "./turn-engine-types.js"
import type { ModelStepResult } from "./turn-engine-model.js"
import { publishFinalResponse } from "./turn-execution-events.js"
import type { StepContextSnapshot } from "../context/step-context-builder.js"
import { nativeSemanticNoProgressError } from "../native-semantic-progress.js"
import { STEERING_RECONCILIATION_BLOCKER } from "../subagents/steering-reconciliation-contract.js"
import { tagTaskGraphRepairRecovery } from "./completion-recovery-context.js"
import { TASK_GRAPH_FINAL_SUMMARY_BINDING, type TaskGraphFinalSummaryBinding } from "../subagents/task-graph-final-summary-binding.js"
import { formatTaskGraphFinalSummary } from "../subagents/task-graph-final-summary-format.js"

export type FinalCandidateOutcome =
  | Readonly<{ kind: "replan"; feedback: string }>
  | Readonly<{ kind: "wait"; result: TurnEngineResult }>
  | Readonly<{ kind: "completed"; result: TurnEngineResult }>

async function finishStep(options: TurnExecutionOptions, writer: TurnExecutionEventWriter, step: TurnEngineStep, output: ModelStepResult, now: () => Date, onStepClosed: (kind?: "native_semantic_receipt") => void, rejection?: import("./native-semantic-rejection-ledger.js").NativeSemanticRejectionIdentity): Promise<number | undefined> {
  if (rejection) {
    const complete = options.store.completeNativeSemanticRejectionStep
    if (options.nativeSemanticProgressMode !== "durable_v1" || options.identity.kind !== "turn" || !complete) {
      throw new TurnEngineError("persistence_conflict", "Native semantic rejection receipt storage is unavailable")
    }
    const result = await complete({ executionIdentity: options.identity, stepId: step.id, finishReason: output.finishReason, errorCode: null,
      inputTokens: output.usage?.inputTokens ?? 0, outputTokens: output.usage?.outputTokens ?? 0,
      estimatedCostUsd: output.usage?.estimatedCostUsd ?? 0, now: now(), identity: rejection })
    onStepClosed("native_semantic_receipt")
    if (typeof result.inputThroughSequence !== "bigint" || result.inputThroughSequence < 0n
      || !Number.isSafeInteger(result.distinctStepCount) || result.distinctStepCount < 1 || result.distinctStepCount > 3) {
      throw new TurnEngineError("persistence_conflict", "Native semantic rejection receipt is invalid")
    }
    await writer.append("step.completed", step.id, null, { stepId: step.id, status: "completed", taskId: options.identity.taskId }, `step-completed:${step.id}`)
    return result.distinctStepCount
  }
  await Promise.all([
    updateExecutionStep(options, { stepId: step.id, status: "completed", finishReason: output.finishReason, errorCode: null,
      inputTokens: output.usage?.inputTokens ?? 0, outputTokens: output.usage?.outputTokens ?? 0,
      estimatedCostUsd: output.usage?.estimatedCostUsd ?? 0, now: now() }),
    writer.append("step.completed", step.id, null, { stepId: step.id, status: "completed", taskId: options.identity.taskId }, `step-completed:${step.id}`),
  ])
  onStepClosed()
  return undefined
}

export async function completeTurnCandidate(input: Readonly<{
  options: TurnExecutionOptions
  writer: TurnExecutionEventWriter
  step: TurnEngineStep
  output: ModelStepResult
  snapshot: StepContextSnapshot
  stepCount: number
  toolCallCount: number
  usage: TurnUsage
  signal: AbortSignal
  now: () => Date
  onStepClosed: (kind?: "native_semantic_receipt") => void
}>): Promise<FinalCandidateOutcome> {
  const { options, writer, step, output, snapshot, signal, now } = input
  const verification = verifyCandidateFinal({ goal: options.goal, candidate: { text: output.text, finishReason: output.finishReason },
    evidence: snapshotEvidence(snapshot), expectedEvidence: options.expectedEvidence, businessChecks: options.businessChecks })
  if (!verification.ok) {
    options.completionGate?.[RESET_NATIVE_SEMANTIC_PROGRESS]?.()
    await writer.append("final.rejected", step.id, null, { code: verification.code, blocker: verification.blocker, feedback: verification.feedback, taskId: options.identity.taskId }, `final-rejected:${step.id}`)
    throw new TurnEngineError(verification.code, verification.blocker)
  }
  const gate = await assertCompletionAllowed(options, writer, step, signal, now, output.text)
  if (gate && "waitId" in gate) {
    await updateExecutionStep(options, { stepId: step.id, status: "waiting_for_tool", finishReason: output.finishReason, errorCode: null,
      inputTokens: output.usage?.inputTokens ?? 0, outputTokens: output.usage?.outputTokens ?? 0,
      estimatedCostUsd: output.usage?.estimatedCostUsd ?? 0, now: now() })
    await writer.append("step.completed", step.id, null, { stepId: step.id, status: "waiting_for_dependency", taskId: options.identity.taskId }, `step-completed:${step.id}`)
    input.onStepClosed()
    return { kind: "wait", result: { status: "waiting_for_dependency", waitId: gate.waitId, stepCount: input.stepCount, toolCallCount: input.toolCallCount } }
  }
  if (gate && "feedback" in gate) {
    const rejection = gate[NATIVE_SEMANTIC_REJECTION]
    const distinctStepCount = await finishStep(options, writer, step, output, now, input.onStepClosed, rejection)
    if (distinctStepCount === 3) throw nativeSemanticNoProgressError()
    if (gate[NATIVE_SEMANTIC_NO_PROGRESS] === true) throw nativeSemanticNoProgressError()
    return { kind: "replan", feedback: gate.feedback }
  }
  await finishStep(options, writer, step, output, now, input.onStepClosed)
  const summaryBinding = gate as TaskGraphFinalSummaryBinding | undefined
  const finalResponse = finalizeTurn({ goal: options.goal, verification, terminalReason: "goal_satisfied", response: output.text,
    ...(summaryBinding ? { summaryOverride: formatTaskGraphFinalSummary(summaryBinding.summary) } : {}),
    usage: totalTurnUsage(options.resume?.usage, input.usage), stepCount: input.stepCount, toolCallCount: input.toolCallCount })
  if (canPersistFinalResponse(options)) {
    if (!options.store.recordFinalResponse) throw new TurnEngineError("persistence_conflict", "Atomic Turn completion is unavailable")
    const finalItemId = options.idFactory?.(executionId(options.identity, `item:final:${step.id}`)) ?? executionId(options.identity, `item:final:${step.id}`)
    let terminal: void | AtomicTurnCompletionResult
    try {
      terminal = await options.store.recordFinalResponse({ identity: options.identity, response: serializeFinalResponse(finalResponse), now: now(),
        terminal: { stepId: step.id, finalItemId, finalContent: toRepositoryJson({ text: finalResponse.response, final: toRepositoryJson(finalResponse) }),
          stepCount: input.stepCount, toolCallCount: input.toolCallCount, usage: finalResponse.usage,
          ...(summaryBinding ? { [TASK_GRAPH_FINAL_SUMMARY_BINDING]: summaryBinding } : {}) } })
    } catch (error: unknown) {
      const reconciliation = steeringReconciliationGateRecovery(error)
      if (reconciliation) {
        options.completionGate?.[RESET_NATIVE_SEMANTIC_PROGRESS]?.()
        await writer.append("final.rejected", step.id, null,
          { code: STEERING_RECONCILIATION_BLOCKER, blocker: STEERING_RECONCILIATION_BLOCKER, feedback: reconciliation.feedback, taskId: options.identity.taskId },
          `final-rejected:${step.id}:steering-reconciliation-race`)
        return { kind: "replan", feedback: reconciliation.feedback }
      }
      const recovery = taskGraphGateRecovery(error)
      if (!recovery) throw error
      const stampedRecovery = error && typeof error === "object" ? Reflect.get(error, "recoveryFeedback") : undefined
      const recoveryFeedback = typeof stampedRecovery === "string" && stampedRecovery.length <= 2_048
        ? stampedRecovery
        : tagTaskGraphRepairRecovery(recovery.feedback, null)
      await writer.append("final.rejected", step.id, null, { code: "business_precondition_failed", blocker: "task_graph_verification_unverified", feedback: recovery.feedback, taskId: options.identity.taskId }, `final-rejected:${step.id}:task-graph-race`)
      return { kind: "replan", feedback: recoveryFeedback }
    }
    if (!terminal) throw new TurnEngineError("persistence_conflict", "Atomic Turn completion returned no receipt")
    for (const event of terminal.events) await Promise.resolve(options.subscribe?.(event)).catch(() => undefined)
    return { kind: "completed", result: { status: "completed", stepCount: input.stepCount, toolCallCount: input.toolCallCount, finalItemId: terminal.finalItemId, finalText: output.text } }
  }
  const finalItem = await publishFinalResponse(writer, options, step, finalResponse, now)
  if (canEmitTurnCompleted(options)) await writer.append("turn.completed", step.id, finalItem.id,
    { turnId: options.identity.turnId, taskId: options.identity.taskId, finalItemId: finalItem.id, usage: finalResponse.usage }, "turn-completed")
  return { kind: "completed", result: { status: "completed", stepCount: input.stepCount, toolCallCount: input.toolCallCount, finalItemId: finalItem.id, finalText: output.text } }
}

function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null }
/** Extracts only a response whose final item and serialized terminal response agree exactly. */
export function persistedFinalCandidate(finalContent: unknown, response: unknown): string | null {
  const content = record(finalContent), final = content && record(content.final)
  if (!content || typeof content.text !== "string" || !final || final.response !== content.text || typeof response !== "string") return null
  try {
    const serialized = record(JSON.parse(response) as unknown)
    return serialized?.response === content.text ? content.text : null
  } catch { return null }
}
