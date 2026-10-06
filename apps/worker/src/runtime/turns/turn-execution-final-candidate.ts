import type { TurnUsage } from "../budget.js"
import type { TurnExecutionEventWriter } from "./turn-execution-events.js"
import { NATIVE_SEMANTIC_NO_PROGRESS, RESET_NATIVE_SEMANTIC_PROGRESS, executionId, type TurnExecutionOptions } from "./turn-execution-types.js"
import { assertCompletionAllowed, taskGraphGateRecovery } from "./turn-execution-completion-gate.js"
import { canEmitTurnCompleted, canPersistFinalResponse, totalTurnUsage, updateExecutionStep } from "./turn-engine-helpers.js"
import { finalizeTurn, serializeFinalResponse } from "../finalizer.js"
import { verifyCandidateFinal, snapshotEvidence } from "../verifier.js"
import { TurnEngineError, toRepositoryJson, type AtomicTurnCompletionResult, type TurnEngineResult, type TurnEngineStep } from "./turn-engine-types.js"
import type { ModelStepResult } from "./turn-engine-model.js"
import { publishFinalResponse } from "./turn-execution-events.js"
import type { StepContextSnapshot } from "../context/step-context-builder.js"
import { nativeSemanticNoProgressError } from "../native-semantic-progress.js"

export type FinalCandidateOutcome =
  | Readonly<{ kind: "replan"; feedback: string }>
  | Readonly<{ kind: "wait"; result: TurnEngineResult }>
  | Readonly<{ kind: "completed"; result: TurnEngineResult }>

async function finishStep(options: TurnExecutionOptions, writer: TurnExecutionEventWriter, step: TurnEngineStep, output: ModelStepResult, now: () => Date, onStepClosed: () => void): Promise<void> {
  await Promise.all([
    updateExecutionStep(options, { stepId: step.id, status: "completed", finishReason: output.finishReason, errorCode: null,
      inputTokens: output.usage?.inputTokens ?? 0, outputTokens: output.usage?.outputTokens ?? 0,
      estimatedCostUsd: output.usage?.estimatedCostUsd ?? 0, now: now() }),
    writer.append("step.completed", step.id, null, { stepId: step.id, status: "completed", taskId: options.identity.taskId }, `step-completed:${step.id}`),
  ])
  onStepClosed()
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
  onStepClosed: () => void
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
    await finishStep(options, writer, step, output, now, input.onStepClosed)
    if (gate[NATIVE_SEMANTIC_NO_PROGRESS] === true) throw nativeSemanticNoProgressError()
    return { kind: "replan", feedback: gate.feedback }
  }
  await finishStep(options, writer, step, output, now, input.onStepClosed)
  const finalResponse = finalizeTurn({ goal: options.goal, verification, terminalReason: "goal_satisfied", response: output.text,
    usage: totalTurnUsage(options.resume?.usage, input.usage), stepCount: input.stepCount, toolCallCount: input.toolCallCount })
  if (canPersistFinalResponse(options)) {
    if (!options.store.recordFinalResponse) throw new TurnEngineError("persistence_conflict", "Atomic Turn completion is unavailable")
    const finalItemId = options.idFactory?.(executionId(options.identity, `item:final:${step.id}`)) ?? executionId(options.identity, `item:final:${step.id}`)
    let terminal: void | AtomicTurnCompletionResult
    try {
      terminal = await options.store.recordFinalResponse({ identity: options.identity, response: serializeFinalResponse(finalResponse), now: now(),
        terminal: { stepId: step.id, finalItemId, finalContent: toRepositoryJson({ text: finalResponse.response, final: toRepositoryJson(finalResponse) }),
          stepCount: input.stepCount, toolCallCount: input.toolCallCount, usage: finalResponse.usage } })
    } catch (error: unknown) {
      const recovery = taskGraphGateRecovery(error)
      if (!recovery) throw error
      await writer.append("final.rejected", step.id, null, { code: "business_precondition_failed", blocker: "task_graph_verification_unverified", feedback: recovery.feedback, taskId: options.identity.taskId }, `final-rejected:${step.id}:task-graph-race`)
      return { kind: "replan", feedback: recovery.feedback }
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
