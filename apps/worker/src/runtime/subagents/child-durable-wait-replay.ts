import { canonicalJson } from "@jobcopilot/shared"
import type { ContextSeedBlock } from "../context/step-context-builder.js"
import type { ToolExecutionResult } from "../tools/types.js"
import type { TurnEngineToolCall, TurnEngineToolExecutor } from "../turns/turn-engine-types.js"
import { safeSubagentWaitJson } from "./durable-subagent-wait-store.js"
import type { DurableWaitResume } from "./child-resume-observations.js"
import type { SubagentLease } from "./types.js"
export { childWaitResumeCursorIsValid } from "./child-resume-wait-call-contract.js"

type WaitInput = Readonly<{ idempotencyKey: string; taskIds: readonly string[]; mode: "any" | "all"; timeoutMs: number }>
type ContinuationStep = Readonly<{ id: string; ordinal: number }>
const WAIT_TASK_STATUSES = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed", "passed", "skipped"])

export type ChildWaitCallRecovery = Readonly<{
  readonly owner: Readonly<Pick<SubagentLease, "id" | "userId" | "sessionId" | "turnId" | "rootTaskId" | "ownerId" | "attemptCount">>
  readonly stepId: string
  readonly stepOrdinal: number
  readonly stepStatus: "streaming" | "completed"
  readonly call: Readonly<{ id: string; name: "wait_subagents"; arguments: unknown }>
  readonly sourceWaitCallId: string
  readonly sourceInput: unknown
  readonly callItem: Readonly<{ id: string; revision: number; status: "started" | "completed" }>
  readonly callStartedEventId: string
  readonly modelUsage: Readonly<{ inputTokens: number; outputTokens: number; estimatedCostUsd: number }>
  readonly output: unknown
}>

export type ChildWaitClaimRecovery = ChildWaitCallRecovery & Readonly<{
  readonly claimEventId: string
  readonly resultItem?: Readonly<{ id: string; revision: number; status: "started" | "completed" }>
}>

export type ChildWaitOrphanRecovery = ChildWaitCallRecovery

export function childWaitClaimEventKey(attempt: number, stepId: string): string {
  return `child-wait-claim:${attempt}:${stepId}`
}

function object(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) return null
    }
    return value as Record<string, unknown>
  } catch { return null }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(), keys = [...expected].sort()
  return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}

function ids(value: unknown, minimum = 1): string[] | null {
  if (!Array.isArray(value) || value.length < minimum || value.length > 8
    || !value.every(id => typeof id === "string" && id.length > 0 && id.length <= 256 && id.trim() === id)
    || new Set(value).size !== value.length) return null
  return value as string[]
}

function parseInput(value: unknown): WaitInput | null {
  const input = object(value)
  if (!input || !exactKeys(input, ["idempotencyKey", "taskIds", "mode", "timeoutMs"])
    || typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey !== input.idempotencyKey.trim()
    || input.idempotencyKey.length > 256 || !(input.mode === "any" || input.mode === "all")
    || !Number.isSafeInteger(input.timeoutMs) || Number(input.timeoutMs) < 1 || Number(input.timeoutMs) > 30_000) return null
  const taskIds = ids(input.taskIds)
  return taskIds ? { idempotencyKey: input.idempotencyKey, taskIds, mode: input.mode, timeoutMs: Number(input.timeoutMs) } : null
}

export function isExactChildWaitInput(value: unknown, waitInput: unknown): boolean {
  const requested = parseInput(value), original = parseInput(waitInput)
  return !!requested && !!original && requested.idempotencyKey === original.idempotencyKey
    && requested.mode === original.mode && requested.timeoutMs === original.timeoutMs && sameIds(requested.taskIds, original.taskIds)
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(id => right.includes(id))
}

function validOutput(wait: DurableWaitResume, input: WaitInput): boolean {
  const output = object(wait.output)
  if (!output || !exactKeys(output, ["waitId", "status", "taskIds", "deadlineAt", "matchedTaskIds", "tasks"])
    || output.waitId !== wait.waitId || !(output.status === "ready" || output.status === "timed_out")
    || typeof output.deadlineAt !== "string" || !Number.isFinite(Date.parse(output.deadlineAt))) return false
  const taskIds = ids(output.taskIds), matched = ids(output.matchedTaskIds, 0)
  const tasks = Array.isArray(output.tasks) ? output.tasks.map(object) : null
  if (!taskIds || !matched || !sameIds(taskIds, input.taskIds) || matched.some(id => !input.taskIds.includes(id))
    || !tasks || tasks.length !== input.taskIds.length) return false
  const taskRows = tasks.map(task => task && exactKeys(task, ["taskId", "status", "role", "result", "failureReason"])
    && typeof task.taskId === "string" && typeof task.status === "string" && WAIT_TASK_STATUSES.has(task.status)
    && typeof task.role === "string" && !!task.role.trim() && (task.failureReason === null || typeof task.failureReason === "string")
    ? task.taskId : null)
  if (taskRows.some(id => id === null) || !sameIds(taskRows as string[], input.taskIds)) return false
  return output.status !== "ready" || (input.mode === "all" ? sameIds(matched, input.taskIds) : matched.length > 0)
}

function hasRestoredReceipt(wait: DurableWaitResume, observations: readonly ContextSeedBlock[], input: WaitInput): boolean {
  const sourceId = "child-resume:" + wait.sourceItemId
  const matches = observations.filter(item => item.id === sourceId)
  const calls = observations.filter(item => object(item.content)?.toolCallId === wait.toolCallId)
  if (matches.length !== 1 || calls.length !== 1 || matches[0] !== calls[0]) return false
  const content = object(matches[0]?.content), recordedInput = content && parseInput(content.input)
  try {
    return !!content && content.toolCallId === wait.toolCallId && content.toolName === "wait_subagents"
      && content.status === "completed" && content.errorCode === null
      && canonicalJson(content.input) === canonicalJson(safeSubagentWaitJson(wait.input, 1024))
      && canonicalJson(content.output) === canonicalJson(safeSubagentWaitJson(wait.output, 6 * 1024))
      && !!recordedInput && sameIds(recordedInput.taskIds, input.taskIds)
  } catch { return false }
}

function validLeaseIdentity(lease: SubagentLease, attempt: number): boolean {
  return lease.status === "running" && !!lease.turnId && !!lease.parentTaskId && !!lease.ownerId
    && lease.leaseOwner === lease.ownerId && lease.interruptRequestedAt === null && lease.attemptCount === attempt
}

function failedConflict(call: { id: string; toolName: string }): ToolExecutionResult {
  return { id: call.id, toolName: call.toolName, toolVersion: "1", status: "failed", errorCode: "wait_conflict" }
}

/** Child-only single-use replay of a loader-validated wait after continuation acknowledgement. */
export function createChildDurableWaitReplay(
  lease: SubagentLease, wait: DurableWaitResume, observations: readonly ContextSeedBlock[], claim?: ChildWaitClaimRecovery,
): Readonly<{
  acknowledgeContinuation(step: ContinuationStep): void
  childWaitCallStartKey(stepId: string, call: TurnEngineToolCall): string | undefined
  childWaitCallStarted(stepId: string, call: TurnEngineToolCall, eventId: string): void
  execute(input: Parameters<TurnEngineToolExecutor>[0]): ToolExecutionResult | undefined
}> {
  const original = parseInput(wait.input)
  const valid = !!original && Number.isSafeInteger(wait.attempt) && wait.attempt > 0 && validLeaseIdentity(lease, wait.attempt)
    && Number.isSafeInteger(wait.ordinal) && wait.ordinal >= 0 && typeof wait.stepId === "string" && !!wait.stepId.trim()
    && typeof wait.waitId === "string" && !!wait.waitId.trim() && typeof wait.toolCallId === "string" && !!wait.toolCallId.trim()
    && typeof wait.sourceItemId === "string" && !!wait.sourceItemId.trim()
    && hasRestoredReceipt(wait, observations, original!) && validOutput(wait, original!)
    && (!claim || claim.owner.id === lease.id && claim.owner.userId === lease.userId && claim.owner.sessionId === lease.sessionId
      && claim.owner.turnId === lease.turnId && claim.owner.rootTaskId === lease.rootTaskId && claim.owner.ownerId === lease.ownerId
      && claim.owner.attemptCount === lease.attemptCount && claim.call.name === "wait_subagents"
      && claim.call.id.trim().length > 0 && claim.stepId.trim().length > 0 && claim.claimEventId.trim().length > 0
      && claim.sourceWaitCallId === wait.toolCallId && isExactChildWaitInput(claim.call.arguments, wait.input))
  let continuation: ContinuationStep | undefined
  let ambiguousContinuation = false
  let reservedCallId: string | undefined
  let startedCall: { stepId: string; callId: string; eventId: string } | undefined
  let ambiguousStart = false
  let used = false
  return {
    acknowledgeContinuation(step) {
      if (!valid || !Number.isSafeInteger(step.ordinal) || step.ordinal <= wait.ordinal || !step.id.trim()) return
      if (wait.continuationStepId && (step.id !== wait.continuationStepId || step.ordinal !== wait.continuationOrdinal)) { ambiguousContinuation = true; return }
      if (continuation && (continuation.id !== step.id || continuation.ordinal !== step.ordinal)) { ambiguousContinuation = true; return }
      continuation = { id: step.id, ordinal: step.ordinal }
    },
    childWaitCallStartKey(stepId, call) {
      if (!valid || claim || ambiguousContinuation || !continuation || continuation.id !== stepId
        || call.name !== "wait_subagents" || !call.id.trim() || reservedCallId || used
        || !isExactChildWaitInput(call.arguments, wait.input)) return undefined
      reservedCallId = call.id
      return childWaitClaimEventKey(wait.attempt, stepId)
    },
    childWaitCallStarted(stepId, call, eventId) {
      if (!reservedCallId || call.id !== reservedCallId || call.name !== "wait_subagents") return
      if (startedCall || ambiguousStart || !valid || stepId !== continuation?.id || !eventId.trim()
        || !isExactChildWaitInput(call.arguments, wait.input)) { ambiguousStart = true; return }
      startedCall = { stepId, callId: call.id, eventId }
    },
    execute(input) {
      if (input.call.toolName !== "wait_subagents" || input.stepId !== continuation?.id) return undefined
      const ownsReservation = reservedCallId === input.call.id
      if (ownsReservation) {
        if (used) return failedConflict(input.call)
        used = true
      }
      if (!valid || claim || ambiguousContinuation || ambiguousStart || !continuation
        || input.call.toolVersion !== "1" || !input.call.id.trim() || input.signal.aborted
        || input.scope.userId !== lease.userId || input.sessionId !== lease.sessionId || input.turnId !== lease.turnId
        || input.taskId !== lease.id || input.rootTaskId !== lease.rootTaskId) return failedConflict(input.call)
      const requested = parseInput(input.call.input)
      if (!ownsReservation || !startedCall
        || startedCall.callId !== input.call.id || startedCall.stepId !== input.stepId || !requested
        || requested.idempotencyKey !== original!.idempotencyKey || requested.mode !== original!.mode
        || requested.timeoutMs !== original!.timeoutMs || !sameIds(requested.taskIds, original!.taskIds)) return failedConflict(input.call)
      return { id: input.call.id, toolName: input.call.toolName, toolVersion: "1", status: "completed", output: wait.output, errorCode: null }
    },
  }
}

export function childWaitReplayExecutionOptions(
  replay: ReturnType<typeof createChildDurableWaitReplay> | undefined,
  claim: ChildWaitClaimRecovery | undefined,
  orphan?: ChildWaitOrphanRecovery,
): {
  childWaitCallStartKey?: (stepId: string, call: TurnEngineToolCall) => string | undefined
  childWaitCallStarted?: (stepId: string, call: TurnEngineToolCall, eventId: string) => void
  childWaitClaimRecovery?: ChildWaitClaimRecovery
  childWaitOrphanRecovery?: ChildWaitOrphanRecovery
} {
  return {
    ...(replay ? {
      childWaitCallStartKey: (stepId, call) => replay.childWaitCallStartKey(stepId, call),
      childWaitCallStarted: (stepId, call, eventId) => replay.childWaitCallStarted(stepId, call, eventId),
    } : {}),
    ...(claim ? { childWaitClaimRecovery: claim } : {}),
    ...(orphan ? { childWaitOrphanRecovery: orphan } : {}),
  }
}
