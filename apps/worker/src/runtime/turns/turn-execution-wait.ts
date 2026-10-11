import type { DurableWaitControl } from "../tools/coordination-types.js"
import { TurnEngineError, type TurnEngineResult } from "./turn-engine-types.js"
import { updateExecutionStep } from "./turn-engine-helpers.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"
import { TurnExecutionEventWriter } from "./turn-execution-events.js"

export type WaitRequest = {
  readonly idempotencyKey: string
  readonly taskIds: readonly string[]
  readonly mode: "any" | "all"
  readonly timeoutMs: number
}
export type RecoveredArchivedWaitControl = DurableWaitControl & {
  readonly stepId: string
  readonly stepStatus: "running" | "waiting_for_tool"
  readonly finishReason: string | null
  readonly errorCode: string | null
  readonly inputTokens: number
  readonly outputTokens: number
  readonly estimatedCostUsd: number
  readonly toolCallCount: number
  readonly stepCompletionRecorded: boolean
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function boundedString(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value }
function normalizedWaitIds(value: unknown, allowEmpty = false): string[] | null {
  if (!Array.isArray(value) || value.length < (allowEmpty ? 0 : 1) || value.length > 8) return null
  const ids: string[] = []
  for (const id of value) {
    if (!boundedString(id, 256)) return null
    ids.push(id)
  }
  if (new Set(ids).size !== ids.length) return null
  return [...ids].sort()
}

/** Parse the closed, schema-validated tool input used by both fresh and restored waits. */
export function parseWaitRequest(value: unknown): WaitRequest | null {
  const row = record(value)
  if (!row || (Object.getPrototypeOf(row) !== Object.prototype && Object.getPrototypeOf(row) !== null)
    || Reflect.ownKeys(row).length !== 4 || Reflect.ownKeys(row).some(key => typeof key !== "string" || !["idempotencyKey", "mode", "taskIds", "timeoutMs"].includes(key))
    || !["idempotencyKey", "mode", "taskIds", "timeoutMs"].every(key => { const descriptor = Object.getOwnPropertyDescriptor(row, key); return !!descriptor?.enumerable && "value" in descriptor })
    || !boundedString(row.idempotencyKey, 256) || (row.mode !== "any" && row.mode !== "all")
    || !Number.isSafeInteger(row.timeoutMs) || Number(row.timeoutMs) < 1 || Number(row.timeoutMs) > 30_000) return null
  const taskIds = normalizedWaitIds(row.taskIds)
  return taskIds ? { idempotencyKey: row.idempotencyKey, taskIds, mode: row.mode, timeoutMs: Number(row.timeoutMs) } : null
}

function parseProjectedWaitInput(value: unknown): { readonly taskIds: readonly string[]; readonly mode: "any" | "all" } | null {
  const row = record(value)
  if (!row || (Object.getPrototypeOf(row) !== Object.prototype && Object.getPrototypeOf(row) !== null)
    || Reflect.ownKeys(row).length !== 2 || Reflect.ownKeys(row).some(key => typeof key !== "string" || !["mode", "taskIds"].includes(key))) return null
  if (!["mode", "taskIds"].every(key => { const descriptor = Object.getOwnPropertyDescriptor(row, key); return !!descriptor?.enumerable && "value" in descriptor })) return null
  if (row.mode !== "any" && row.mode !== "all") return null
  const taskIds = normalizedWaitIds(row.taskIds)
  return taskIds ? { taskIds, mode: row.mode } : null
}

function exactInterruptedOutput(value: unknown, waitId: string, targetTaskIds: readonly string[], mode: "any" | "all"): boolean {
  const output = record(value)
  const expectedKeys = ["matchedTaskIds", "status", "targetTaskIds", "tasks", "waitId"]
  if (!output || (Object.getPrototypeOf(output) !== Object.prototype && Object.getPrototypeOf(output) !== null)
    || Reflect.ownKeys(output).length !== expectedKeys.length || Reflect.ownKeys(output).some(key => typeof key !== "string" || !expectedKeys.includes(key))
    || expectedKeys.some(key => { const descriptor = Object.getOwnPropertyDescriptor(output, key); return !descriptor?.enumerable || !("value" in descriptor) })
    || output.waitId !== waitId || output.status !== "interrupted") return false
  const targets = normalizedWaitIds(output.targetTaskIds), matched = normalizedWaitIds(output.matchedTaskIds, true)
  if (!targets || targets.length !== targetTaskIds.length || targets.some((id, index) => id !== targetTaskIds[index])
    || !Array.isArray(output.targetTaskIds) || output.targetTaskIds.some((id, index) => id !== targets[index])
    || !matched || !Array.isArray(output.matchedTaskIds) || output.matchedTaskIds.some((id, index) => id !== matched[index])
    || matched.some(id => !targets.includes(id))
    || (mode === "any" ? matched.length !== 0 : matched.length >= targets.length)) return false
  const tasks = output.tasks
  if (!Array.isArray(tasks) || tasks.length !== targets.length) return false
  const taskKeys = ["failureReason", "repairReceipt", "result", "role", "status", "taskId", "verificationReport"]
  const requiredTaskKeys = ["failureReason", "result", "role", "status", "taskId"]
  return Array.from({ length: tasks.length }, (_, index) => Object.hasOwn(tasks, index) ? tasks[index] : undefined).every((task, index) => {
    const row = record(task)
    if (!row || (Object.getPrototypeOf(row) !== Object.prototype && Object.getPrototypeOf(row) !== null)) return false
    const keys = Reflect.ownKeys(row)
    return keys.every(key => typeof key === "string" && taskKeys.includes(key))
      && requiredTaskKeys.every(key => { const descriptor = Object.getOwnPropertyDescriptor(row, key); return !!descriptor?.enumerable && "value" in descriptor })
      && keys.every(key => { const descriptor = Object.getOwnPropertyDescriptor(row, key); return !!descriptor?.enumerable && "value" in descriptor })
      && row.taskId === targets[index] && typeof row.status === "string" && row.status.length > 0 && row.status.length <= 256
  })
}

export function hasResolvedWaitOutcome(
  snapshot: TurnExecutionOptions["snapshot"], waitId: string, expectedInput: unknown, expectedStatus?: "interrupted",
): boolean {
  const expected = parseWaitRequest(expectedInput)
  if (!expected) return false
  return snapshot.toolObservations.some(observation => {
    if (observation.id !== `wait-result:${waitId}`) return false
    const content = record(observation.content)
    if (!content || content.toolCallId !== `wait:${waitId}` || content.toolName !== "agent.wait" || content.status !== "completed") return false
    // The server's durable outcome projector intentionally exposes only this safe subset.
    const request = parseProjectedWaitInput(content.input)
    if (!request || request.mode !== expected.mode || request.taskIds.length !== expected.taskIds.length
      || request.taskIds.some((id, index) => id !== expected.taskIds[index])) return false
    const result = record(content.output)
    if (!result || result.waitId !== waitId) return false
    if (result.status === "interrupted") return expectedStatus === "interrupted"
      && content.errorCode === null
      && exactKeys(content, ["errorCode", "input", "output", "status", "toolCallId", "toolName"])
      && exactInterruptedOutput(result, waitId, expected.taskIds, expected.mode)
    if (result.status !== "ready" && result.status !== "timed_out") return false
    if (expectedStatus === "interrupted") return false
    const targetTaskIds = normalizedWaitIds(result.targetTaskIds)
    const matchedTaskIds = Array.isArray(result.matchedTaskIds) ? result.matchedTaskIds : null
    if (!targetTaskIds || targetTaskIds.length !== expected.taskIds.length
      || targetTaskIds.some((id, index) => id !== expected.taskIds[index]) || !matchedTaskIds) return false
    const matched = new Set<string>()
    for (const id of matchedTaskIds) {
      if (!boundedString(id, 256) || !targetTaskIds.includes(id) || matched.has(id)) return false
      matched.add(id)
    }
    if (result.status === "ready" && (matched.size === 0 || (expected.mode === "all" && matched.size !== targetTaskIds.length))) return false
    if (!Array.isArray(result.tasks) || result.tasks.length !== targetTaskIds.length) return false
    const taskIds = new Set<string>()
    for (const task of result.tasks) {
      const row = record(task)
      if (!row || !boundedString(row.taskId, 256) || !targetTaskIds.includes(row.taskId) || taskIds.has(row.taskId)
      || typeof row.status !== "string" || row.status.trim().length === 0 || row.status.length > 256) return false
      taskIds.add(row.taskId)
    }
    return taskIds.size === targetTaskIds.length
  })
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value)
  return (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && keys.length === expected.length && keys.every(key => typeof key === "string" && expected.includes(key))
    && expected.every(key => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return !!descriptor?.enumerable && "value" in descriptor })
}

/** Close the exact persisted Step before returning control to the existing queue handoff. */
export async function handoffRecoveredArchivedWait(
  options: TurnExecutionOptions,
  writer: TurnExecutionEventWriter,
  control: RecoveredArchivedWaitControl,
  counts: { readonly stepCount: number; readonly toolCallCount: number },
  now: () => Date,
): Promise<TurnEngineResult> {
  if (control.stepStatus === "running") await updateExecutionStep(options, {
    stepId: control.stepId, status: "waiting_for_tool", finishReason: control.finishReason, errorCode: control.errorCode,
    inputTokens: control.inputTokens, outputTokens: control.outputTokens, estimatedCostUsd: control.estimatedCostUsd, now: now(),
  })
  if (!control.stepCompletionRecorded) await writer.append("step.completed", control.stepId, null,
    { stepId: control.stepId, status: "waiting_for_dependency", toolCallCount: control.toolCallCount, taskId: options.identity.taskId },
    `step-completed:${control.stepId}`)
  return { status: "waiting_for_dependency", stepCount: counts.stepCount, toolCallCount: counts.toolCallCount, waitId: control.waitId }
}
