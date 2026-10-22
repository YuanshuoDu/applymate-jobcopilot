import type { StepContext, StepContextSnapshot } from "../context/step-context-builder.js"
import { parseTaskGraphDenialCheckpoint, type TaskGraphDenialCheckpoint } from "./task-graph-terminal-assessment.js"
import type { TaskGraphDenialProgress } from "./turn-execution-types.js"
import { completionRecoverySnapshot } from "./turn-execution-completion-gate.js"

export function taskGraphDenialProgressFor(
  checkpointInput: TaskGraphDenialCheckpoint,
  context: Pick<StepContext, "taskGraphRevision" | "inputThroughSequence" | "consumedInputIds">,
  prior?: TaskGraphDenialProgress,
): TaskGraphDenialProgress | undefined {
  const checkpoint = parseCheckpoint(checkpointInput, checkpointInput?.taskId)
  if (!checkpoint) return undefined
  if (context.taskGraphRevision !== checkpoint.graphRevision || !validCheckpoint(context)) return undefined
  const priorInputEpoch = isTaskGraphDenialProgressValid(prior, checkpoint.taskId)
    && prior.inputThroughSequence === context.inputThroughSequence && validIds(prior.consumedInputIds) ? prior : undefined
  const sameFence = !!priorInputEpoch && sameAcceptedInputFence(priorInputEpoch.consumedInputIds, context.consumedInputIds)
  const same = sameFence && priorInputEpoch.graphRevision === checkpoint.graphRevision
    && priorInputEpoch.verificationDigest === checkpoint.verificationDigest
  const consumedInputIds = priorInputEpoch && context.consumedInputIds.length === 0
    ? [...priorInputEpoch.consumedInputIds] : [...context.consumedInputIds]
  return {
    taskId: checkpoint.taskId, graphRevision: checkpoint.graphRevision, verificationDigest: checkpoint.verificationDigest,
    inputThroughSequence: context.inputThroughSequence, consumedInputIds,
    count: same ? 2 : 1,
  }
}

export function taskGraphDenialProgressMatches(
  progress: TaskGraphDenialProgress | undefined,
  checkpointInput: TaskGraphDenialCheckpoint | null,
  context: Pick<StepContext, "taskGraphRevision" | "inputThroughSequence" | "consumedInputIds">,
  expectedTaskId: string,
): boolean {
  const checkpoint = checkpointInput && parseCheckpoint(checkpointInput, expectedTaskId)
  return isTaskGraphDenialProgressValid(progress, expectedTaskId) && !!checkpoint && progress.count === 2
    && progress.taskId === expectedTaskId && checkpoint.taskId === expectedTaskId
    && progress.graphRevision === checkpoint.graphRevision && progress.graphRevision === context.taskGraphRevision
    && progress.verificationDigest === checkpoint.verificationDigest
    && progress.inputThroughSequence === context.inputThroughSequence
    && validCheckpoint(context) && validIds(progress.consumedInputIds)
    && sameAcceptedInputFence(progress.consumedInputIds, context.consumedInputIds)
}

export function isTaskGraphDenialProgressValid(
  progress: TaskGraphDenialProgress | undefined,
  expectedTaskId: string,
): progress is TaskGraphDenialProgress {
  if (!progress || !exactProgress(progress) || progress.taskId !== expectedTaskId
    || (progress.count !== 1 && progress.count !== 2) || !Number.isSafeInteger(progress.graphRevision)
    || progress.graphRevision < 1 || typeof progress.verificationDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(progress.verificationDigest) || typeof progress.inputThroughSequence !== "bigint"
    || progress.inputThroughSequence < 0n || !validIds(progress.consumedInputIds)) return false
  return !!parseCheckpoint({ schemaVersion: "agent-harness.v2.task-graph-denial-checkpoint.v1", taskId: progress.taskId,
    graphRevision: progress.graphRevision, verificationDigest: progress.verificationDigest }, expectedTaskId)
}

function parseCheckpoint(value: unknown, expectedTaskId: string) {
  try { return parseTaskGraphDenialCheckpoint(value, expectedTaskId) } catch { return null }
}

function exactProgress(value: TaskGraphDenialProgress): boolean {
  try {
    const keys = Reflect.ownKeys(value)
    const expected = ["taskId", "graphRevision", "verificationDigest", "inputThroughSequence", "consumedInputIds", "count"]
    return (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
      && keys.length === expected.length && keys.every(key => typeof key === "string" && expected.includes(key))
      && expected.every(key => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return !!descriptor?.enumerable && "value" in descriptor })
  } catch { return false }
}

export function createTaskGraphDenialProgressTracker(initial?: TaskGraphDenialProgress): {
  clear(): void
  record(checkpoint: TaskGraphDenialCheckpoint | null | undefined, context: Pick<StepContext, "taskGraphRevision" | "inputThroughSequence" | "consumedInputIds">): void
  replan(snapshot: StepContextSnapshot, stepId: string, feedback: string, checkpoint: TaskGraphDenialCheckpoint | null | undefined, context: Pick<StepContext, "taskGraphRevision" | "inputThroughSequence" | "consumedInputIds">): StepContextSnapshot
  shouldStop(context: Pick<StepContext, "taskGraphRevision" | "inputThroughSequence" | "consumedInputIds">, expectedTaskId: string, read?: () => Promise<TaskGraphDenialCheckpoint | null>): Promise<boolean>
} {
  let current = initial
  return {
    clear() { current = undefined },
    record(checkpoint, context) {
      current = checkpoint ? taskGraphDenialProgressFor(checkpoint, context, current) : undefined
    },
    replan(snapshot, stepId, feedback, checkpoint, context) {
      current = checkpoint ? taskGraphDenialProgressFor(checkpoint, context, current) : undefined
      return completionRecoverySnapshot(snapshot, stepId, feedback)
    },
    async shouldStop(context, expectedTaskId, read) {
      if (!current) return false
      if (current.count !== 2) return false
      if (!read) { current = undefined; return false }
      const latest = await read()
      if (taskGraphDenialProgressMatches(current, latest, context, expectedTaskId)) return true
      current = undefined
      return false
    },
  }
}

function validCheckpoint(context: Pick<StepContext, "inputThroughSequence" | "consumedInputIds">): boolean {
  return typeof context.inputThroughSequence === "bigint" && context.inputThroughSequence >= 0n
    && Array.isArray(context.consumedInputIds) && context.consumedInputIds.every(id => typeof id === "string" && id.length > 0)
    && new Set(context.consumedInputIds).size === context.consumedInputIds.length
}

function validIds(ids: readonly string[]): boolean {
  return Array.isArray(ids) && ids.every(id => typeof id === "string" && id.trim() === id && id.length > 0 && id.length <= 96 && !/[\u0000-\u001f\u007f]/.test(id))
    && new Set(ids).size === ids.length
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function sameAcceptedInputFence(previousIds: readonly string[], currentIds: readonly string[]): boolean {
  // With the cursor fixed by the caller, an empty Step claim adds no accepted input.
  return currentIds.length === 0 || sameIds(previousIds, currentIds)
}
