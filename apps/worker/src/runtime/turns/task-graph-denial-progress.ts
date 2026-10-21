import type { StepContext, StepContextSnapshot } from "../context/step-context-builder.js"
import type { TaskGraphDenialCheckpoint } from "./task-graph-terminal-assessment.js"
import type { TaskGraphDenialProgress } from "./turn-execution-types.js"
import { completionRecoverySnapshot } from "./turn-execution-completion-gate.js"

export function taskGraphDenialProgressFor(
  checkpoint: TaskGraphDenialCheckpoint,
  context: Pick<StepContext, "taskGraphRevision" | "inputThroughSequence" | "consumedInputIds">,
  prior?: TaskGraphDenialProgress,
): TaskGraphDenialProgress | undefined {
  if (context.taskGraphRevision !== checkpoint.graphRevision || !validCheckpoint(context)) return undefined
  const priorInputEpoch = prior?.taskId === checkpoint.taskId
    && prior.inputThroughSequence === context.inputThroughSequence && validIds(prior.consumedInputIds) ? prior : undefined
  const sameFence = !!priorInputEpoch && sameIds(priorInputEpoch.consumedInputIds, context.consumedInputIds)
  const same = sameFence && priorInputEpoch.graphRevision === checkpoint.graphRevision
    && priorInputEpoch.verificationDigest === checkpoint.verificationDigest
  return {
    taskId: checkpoint.taskId, graphRevision: checkpoint.graphRevision, verificationDigest: checkpoint.verificationDigest,
    inputThroughSequence: context.inputThroughSequence, consumedInputIds: [...context.consumedInputIds],
    count: same ? 2 : 1,
  }
}

export function taskGraphDenialProgressMatches(
  progress: TaskGraphDenialProgress | undefined,
  checkpoint: TaskGraphDenialCheckpoint | null,
  context: Pick<StepContext, "taskGraphRevision" | "inputThroughSequence" | "consumedInputIds">,
  expectedTaskId: string,
): boolean {
  return !!progress && !!checkpoint && progress.count === 2
    && progress.taskId === expectedTaskId && checkpoint.taskId === expectedTaskId
    && progress.graphRevision === checkpoint.graphRevision && progress.graphRevision === context.taskGraphRevision
    && progress.verificationDigest === checkpoint.verificationDigest
    && progress.inputThroughSequence === context.inputThroughSequence
    && validCheckpoint(context) && validIds(progress.consumedInputIds)
    && sameIds(progress.consumedInputIds, context.consumedInputIds)
}

export function createTaskGraphDenialProgressTracker(initial?: TaskGraphDenialProgress): {
  clear(): void
  record(checkpoint: TaskGraphDenialCheckpoint | undefined, context: Pick<StepContext, "taskGraphRevision" | "inputThroughSequence" | "consumedInputIds">, eligible: boolean): void
  replan(snapshot: StepContextSnapshot, stepId: string, feedback: string, checkpoint: TaskGraphDenialCheckpoint | undefined, context: Pick<StepContext, "taskGraphRevision" | "inputThroughSequence" | "consumedInputIds">, eligible: boolean): StepContextSnapshot
  shouldStop(context: Pick<StepContext, "taskGraphRevision" | "inputThroughSequence" | "consumedInputIds">, expectedTaskId: string, read?: () => Promise<TaskGraphDenialCheckpoint | null>): Promise<boolean>
} {
  let current = initial
  return {
    clear() { current = undefined },
    record(checkpoint, context, eligible) {
      current = eligible && checkpoint ? taskGraphDenialProgressFor(checkpoint, context, current) : undefined
    },
    replan(snapshot, stepId, feedback, checkpoint, context, eligible) {
      current = eligible && checkpoint ? taskGraphDenialProgressFor(checkpoint, context, current) : undefined
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
  return Array.isArray(ids) && ids.every(id => typeof id === "string" && id.length > 0)
    && new Set(ids).size === ids.length
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}
