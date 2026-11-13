import type { TurnExecutionOptions } from "./turn-execution-options.js"
import type { TurnBudgetLedger } from "../budget.js"
import { assertExecutionAlive, updateExecutionStep } from "./turn-engine-helpers.js"
import { publishCommentary, TurnExecutionEventWriter } from "./turn-execution-events.js"
import { executeTools } from "./turn-execution-tools.js"
import type { ModelStepResult } from "./turn-engine-model.js"
import type { TurnEngineResult, TurnEngineStep } from "./turn-engine-types.js"
import type { StepContextSnapshot } from "../context/step-context-builder.js"
import type { SteeringMarkerPayload } from "../context/steering-marker.js"

export type TurnExecutionToolStepResult = Readonly<{
  wait: TurnEngineResult | null
  snapshot: StepContextSnapshot
  steeringMarkerState: { readonly active: readonly SteeringMarkerPayload[] } | undefined
}>

export async function executeTurnExecutionToolStep(input: Readonly<{
  options: TurnExecutionOptions
  executionOptions: TurnExecutionOptions
  writer: TurnExecutionEventWriter
  step: TurnEngineStep
  output: ModelStepResult
  snapshot: StepContextSnapshot
  seenCallIds: Set<string>
  signal: AbortSignal
  now: () => Date
  steeringMarkerState: { readonly active: readonly SteeringMarkerPayload[] } | undefined
  budget: TurnBudgetLedger
  questionIntent: boolean
  commentaryText: string | null
  onToolCallsAccounted: (count: number) => void
  onStepClosed: () => void
}>): Promise<TurnExecutionToolStepResult> {
  const { options, executionOptions, writer, step, output, signal, now, budget } = input
  budget.reserveToolCalls(output.toolCalls.length)
  if (input.commentaryText) await publishCommentary(writer, options, step, input.commentaryText, now)
  let persistedToolCallCount = 0
  let outcome: Awaited<ReturnType<typeof executeTools>>
  try {
    outcome = await executeTools(executionOptions, writer, step, output, input.snapshot, input.seenCallIds,
      signal, now, input.steeringMarkerState, () => { persistedToolCallCount += 1 })
  } finally {
    budget.accountToolCalls(output.toolCalls.length)
    input.onToolCallsAccounted(persistedToolCallCount)
  }
  if (input.questionIntent && outcome.wait?.status === "waiting_for_user") {
    input.onStepClosed()
    return { wait: outcome.wait, snapshot: outcome.snapshot, steeringMarkerState: outcome.steeringMarkerState }
  }
  assertExecutionAlive(options, signal)
  const wait = outcome.wait
  const stepStatus = wait?.status === "waiting_for_dependency"
    ? "waiting_for_tool"
    : wait?.status === "waiting_for_approval" || wait?.status === "waiting_for_user" ? wait.status : "completed"
  await updateExecutionStep(options, {
    stepId: step.id, status: stepStatus, finishReason: output.finishReason, errorCode: wait?.errorCode ?? null,
    inputTokens: output.usage?.inputTokens ?? 0, outputTokens: output.usage?.outputTokens ?? 0,
    estimatedCostUsd: output.usage?.estimatedCostUsd ?? 0, now: now(),
  })
  await writer.append(
    "step.completed", step.id, null,
    { stepId: step.id, status: wait?.status ?? "completed", toolCallCount: output.toolCalls.length, taskId: options.identity.taskId },
    `step-completed:${step.id}`,
  )
  input.onStepClosed()
  if (wait?.status === "waiting_for_user") await options.store.waitForUser?.({ identity: options.identity, now: now() })
  return { wait, snapshot: outcome.snapshot, steeringMarkerState: outcome.steeringMarkerState }
}
