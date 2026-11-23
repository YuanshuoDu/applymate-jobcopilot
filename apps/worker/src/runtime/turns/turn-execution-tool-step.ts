import { executeTools } from "./turn-execution-tools.js"
import { TurnEngineError, type TurnEngineResult, type TurnEngineStep } from "./turn-engine-types.js"
import { updateExecutionStep, assertExecutionAlive } from "./turn-engine-helpers.js"
import type { TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { ModelStepResult } from "./turn-engine-model.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"
import { DEPENDENCY_WAIT_BATCH_REJECTION } from "./dependency-wait-batch-rejection.js"

type ToolOutcome = Awaited<ReturnType<typeof executeTools>>
type MarkerState = TurnExecutionOptions["steeringMarkerState"]
const DEPENDENCY_WAIT_TOOLS = new Set(["agent.wait", "wait_subagents"])

function isRootTurn(options: TurnExecutionOptions): boolean {
  return options.identity.kind === "turn" && options.identity.taskId === options.identity.rootTaskId
}

function isObservedCall(snapshot: TurnExecutionOptions["snapshot"], callId: string): boolean {
  return snapshot.toolObservations.some(observation => observation.content && typeof observation.content === "object"
    && !Array.isArray(observation.content) && (observation.content as Record<string, unknown>).toolCallId === callId)
}

function rejectMixedRootDependencyWait(input: {
  options: TurnExecutionOptions
  executeOptions: TurnExecutionOptions
  output: ModelStepResult
  snapshot: TurnExecutionOptions["snapshot"]
  seenCallIds: ReadonlySet<string>
  excludedToolCallIds: ReadonlySet<string>
  signal: AbortSignal
}): boolean {
  const { output, options, executeOptions } = input
  if (output.toolCalls.length < 2 || !output.toolCalls.some(call => DEPENDENCY_WAIT_TOOLS.has(call.name))) return false
  const rootCandidate = isRootTurn(options) || isRootTurn(executeOptions)
  if (!rootCandidate) return false
  if (!isRootTurn(options) || !isRootTurn(executeOptions) || options.identity !== executeOptions.identity) {
    throw new TurnEngineError("persistence_conflict", "Dependency wait batch execution identity is inconsistent")
  }
  assertExecutionAlive(options, input.signal)
  if (output.toolCalls.some(call => call.name === "agent.ask_user")) {
    throw new TurnEngineError("invalid_output", "Native user question call is not valid for this root model step")
  }
  const callIds = output.toolCalls.map(call => call.id)
  if (callIds.some(id => !id || id.trim() !== id) || new Set(callIds).size !== callIds.length
    || callIds.some(id => input.seenCallIds.has(id) || input.excludedToolCallIds.has(id) || isObservedCall(input.snapshot, id))) {
    throw new TurnEngineError("invalid_output", "Dependency wait batch call IDs are not fresh")
  }
  return true
}

function rejectDependencyWaitBatch(options: TurnExecutionOptions): TurnExecutionOptions {
  return { ...options, dependencyWaitBatchRejected: true, executeTool: async input => ({
    id: input.call.id, toolName: input.call.toolName, toolVersion: input.call.toolVersion,
    status: "failed", errorCode: DEPENDENCY_WAIT_BATCH_REJECTION.code, output: DEPENDENCY_WAIT_BATCH_REJECTION,
  }) }
}

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
    const rejectWaitBatch = rejectMixedRootDependencyWait(input)
    const executeOptions = rejectWaitBatch ? rejectDependencyWaitBatch(input.executeOptions) : input.executeOptions
    outcome = await (input.runTools ?? executeTools)(
      executeOptions, input.writer, input.step, input.output, input.snapshot, input.seenCallIds, input.signal,
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
