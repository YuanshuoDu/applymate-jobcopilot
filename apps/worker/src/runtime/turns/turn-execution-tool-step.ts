import { executeTools } from "./turn-execution-tools.js"
import { type TurnEngineResult, type TurnEngineStep } from "./turn-engine-types.js"
import { updateExecutionStep, assertExecutionAlive } from "./turn-engine-helpers.js"
import type { TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { ModelStepResult } from "./turn-engine-model.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"

type ToolOutcome = Awaited<ReturnType<typeof executeTools>>
type MarkerState = TurnExecutionOptions["steeringMarkerState"]

export type TurnExecutionToolStepResult =
  | Readonly<{ kind: "question_wait"; wait: TurnEngineResult }>
  | Readonly<{ kind: "settled"; wait: TurnEngineResult | null }>

export async function executeTurnToolStep(input: {
  options: TurnExecutionOptions
  executeOptions: TurnExecutionOptions
  writer: TurnExecutionEventWriter
  step: TurnEngineStep
  output: ModelStepResult
  snapshot: TurnExecutionOptions["snapshot"]
  seenCallIds: Set<string>
  signal: AbortSignal
  now: () => Date
  steeringMarkerState: MarkerState
  questionIntentCallId: string | null
  closedSteps: Set<string>
  excludedToolCallIds: Set<string>
  resetContinuation: () => void
  onToolCallsSettled: (persistedToolCallCount: number) => void
  onOutcome: (outcome: ToolOutcome) => void
  runTools?: typeof executeTools
}): Promise<TurnExecutionToolStepResult> {
  let persistedToolCallCount = 0
  let outcome: ToolOutcome
  try {
    outcome = await (input.runTools ?? executeTools)(
      input.executeOptions, input.writer, input.step, input.output, input.snapshot, input.seenCallIds, input.signal,
      input.now, input.steeringMarkerState, () => { persistedToolCallCount += 1 }, input.excludedToolCallIds,
    )
  } finally {
    input.onToolCallsSettled(persistedToolCallCount)
  }
  input.onOutcome(outcome)
  if (input.questionIntentCallId && outcome.wait?.status === "waiting_for_user") {
    input.closedSteps.add(input.step.id)
    return { kind: "question_wait", wait: outcome.wait }
  }
  // Tool results are server-owned context; do not reuse a provider cursor across this boundary.
  input.resetContinuation()
  assertExecutionAlive(input.options, input.signal)
  const wait = outcome.wait
  const stepStatus = wait?.status === "waiting_for_dependency"
    ? "waiting_for_tool"
    : wait?.status === "waiting_for_approval" || wait?.status === "waiting_for_user" ? wait.status : "completed"
  await updateExecutionStep(input.options, {
    stepId: input.step.id, status: stepStatus, finishReason: input.output.finishReason, errorCode: wait?.errorCode ?? null,
    inputTokens: input.output.usage?.inputTokens ?? 0, outputTokens: input.output.usage?.outputTokens ?? 0,
    estimatedCostUsd: input.output.usage?.estimatedCostUsd ?? 0, now: input.now(),
  })
  await input.writer.append(
    "step.completed", input.step.id, null,
    { stepId: input.step.id, status: wait?.status ?? "completed", toolCallCount: input.output.toolCalls.length, taskId: input.options.identity.taskId },
    "step-completed:" + input.step.id,
  )
  input.closedSteps.add(input.step.id)
  if (wait?.status === "waiting_for_user") await input.options.store.waitForUser?.({ identity: input.options.identity, now: input.now() })
  return { kind: "settled", wait }
}