import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import type { ExecutionOwnerFence } from "../execution-owner.js"
import { NoProgressError } from "../progress.js"
import type { AtomicTurnNoProgressInput } from "./turn-engine-types.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"
import type { TaskGraphDenialCheckpoint } from "./task-graph-terminal-assessment.js"

type CheckpointReader = NonNullable<AtomicTurnNoProgressInput["readTaskGraphDenialCheckpoint"]>

export async function matchedTaskGraphDenialCheckpoint<TContext>(
  shouldStop: (context: TContext, expectedTaskId: string, read?: CheckpointReader) => Promise<boolean>,
  context: TContext, expectedTaskId: string, read?: CheckpointReader,
): Promise<TaskGraphDenialCheckpoint | null> {
  if (!read) return null
  let latest: TaskGraphDenialCheckpoint | null = null
  const matched = await shouldStop(context, expectedTaskId, async () => { latest = await read(); return latest })
  return matched ? latest : null
}

export function withTaskGraphDenialCheckpoint(
  options: TurnExecutionOptions, checkpoint: TaskGraphDenialCheckpoint, read?: CheckpointReader,
): TurnExecutionOptions {
  const store = options.store, recordFinalResponse = store.recordFinalResponse
  if (!read || !recordFinalResponse) return options
  return { ...options, store: { ...store, recordFinalResponse(input) {
    if (!input.noProgress) return recordFinalResponse.call(store, input)
    const noProgress: AtomicTurnNoProgressInput = { ...input.noProgress, taskGraphDenialCheckpoint: checkpoint, readTaskGraphDenialCheckpoint: read }
    return recordFinalResponse.call(store, { ...input, noProgress })
  } } }
}

export function isTaskGraphTerminalDenial(error: NoProgressError): boolean {
  return error.reasonCode === "repeated_signature" && error.observation.signature === "task_graph_terminal_denial"
    && error.observation.stateFingerprint === error.observation.signature
}

export function validDenial(value: AtomicTurnNoProgressInput): boolean {
  return !!value && typeof value === "object" && typeof value.stepId === "string" && value.stepId.length > 0
    && typeof value.finalItemId === "string" && value.finalItemId.length > 0 && typeof value.inputThroughSequence === "bigint"
    && value.inputThroughSequence >= 0n && Array.isArray(value.consumedInputIds)
    && value.consumedInputIds.every(id => typeof id === "string" && id.length > 0)
    && new Set(value.consumedInputIds).size === value.consumedInputIds.length
    && Number.isSafeInteger(value.stepCount) && value.stepCount >= 0 && Number.isSafeInteger(value.toolCallCount) && value.toolCallCount >= 0
    && value.reasonCode === "repeated_signature" && value.signature === "task_graph_terminal_denial"
    && value.stateFingerprint === value.signature && value.signature.length <= 256
    && typeof value.stateFingerprint === "string" && value.stateFingerprint.length > 0 && value.stateFingerprint.length <= 256
}

export function sameCheckpoint(left: TaskGraphDenialCheckpoint, right: TaskGraphDenialCheckpoint | null): boolean {
  return !!right && left.taskId === right.taskId && left.graphRevision === right.graphRevision
    && left.verificationDigest === right.verificationDigest
}

export function terminalEntries(owner: ExecutionOwnerFence, denial: AtomicTurnNoProgressInput, final: RepositoryJsonValue) {
  const prefix = `turn:${owner.turnId}:event:`
  return [
    { suffix: `step-failed:${denial.stepId}`, type: "step.completed", itemId: null, correlationId: denial.stepId, causationId: null,
      payload: { stepId: denial.stepId, status: "failed", errorCode: "no_progress", taskId: owner.taskId } },
    { suffix: "turn-no-progress", type: "turn.no_progress", itemId: null, correlationId: owner.turnId, causationId: null,
      payload: { reasonCode: denial.reasonCode, signature: denial.signature, stateFingerprint: denial.stateFingerprint, taskId: owner.taskId } },
    { suffix: `item-started:${denial.finalItemId}`, type: "item.started", itemId: denial.finalItemId, correlationId: denial.stepId, causationId: null,
      payload: { itemId: denial.finalItemId, type: "agent_message", phase: "final_answer" } },
    { suffix: `final-completed:${denial.finalItemId}:1`, type: "item.completed", itemId: denial.finalItemId, correlationId: denial.finalItemId, causationId: null,
      payload: { itemId: denial.finalItemId, status: "completed", content: denial.finalContent } },
    { suffix: "turn-failed:no_progress", type: "turn.failed", itemId: denial.finalItemId, correlationId: owner.turnId, causationId: null,
      payload: { turnId: owner.turnId, taskId: owner.taskId, errorCode: "no_progress", finalItemId: denial.finalItemId, final } },
  ] as const
}
