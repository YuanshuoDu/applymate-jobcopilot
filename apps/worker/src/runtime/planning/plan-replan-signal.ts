import { Buffer } from "node:buffer"

import { isPlainJsonObject } from "./goal-plan-contract.js"

const MAX_TASKS = 8
const MAX_TASK_ID_LENGTH = 256
const MAX_FAILURE_REASON_BYTES = 8 * 1024
const FAILURE_STATUSES = new Set(["failed", "interrupted", "cancelled"])
const TASK_KEYS = new Set(["taskId", "status", "role", "result", "failureReason"])
function compareTaskIds(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }

export type ReplanRequiredControl = {
  readonly localId: string
  readonly kind: "replan_required"
  readonly dependsOn: readonly string[]
  readonly reason: "child_failure"
  readonly failedTaskIds: readonly string[]
}

export type JoinFailureInspection =
  | { readonly valid: true; readonly failedTaskIds: readonly string[] }
  | { readonly valid: false }

function row(value: unknown): Record<string, unknown> | null {
  return isPlainJsonObject(value) ? value : null
}

function validTask(value: unknown, expectedTaskIds: readonly string[]): value is Record<string, unknown> {
  const task = row(value)
  if (!task || Object.keys(task).some(key => !TASK_KEYS.has(key)) || (Object.keys(task).length !== 4 && Object.keys(task).length !== 5)) return false
  if (typeof task.taskId !== "string" || task.taskId.trim() !== task.taskId || task.taskId.length === 0 || task.taskId.length > MAX_TASK_ID_LENGTH || !expectedTaskIds.includes(task.taskId)) return false
  if (typeof task.status !== "string" || task.status.trim() !== task.status || task.status.length === 0 || task.status.length > MAX_TASK_ID_LENGTH) return false
  if (!Object.prototype.hasOwnProperty.call(task, "result")) return false
  if (FAILURE_STATUSES.has(task.status) && !Object.prototype.hasOwnProperty.call(task, "failureReason")) return false
  const hasFailureReason = Object.prototype.hasOwnProperty.call(task, "failureReason")
  if (hasFailureReason && task.failureReason !== null && (typeof task.failureReason !== "string" || Buffer.byteLength(task.failureReason, "utf8") > MAX_FAILURE_REASON_BYTES)) return false
  return true
}

/** Inspect only server-shaped terminal child evidence; malformed failure data is invalid. */
export function inspectJoinFailureEvidence(value: unknown, expectedTaskIds: readonly string[]): JoinFailureInspection {
  const output = row(value)
  if (!output || (output.status !== "ready" && output.status !== "timed_out")) return { valid: true, failedTaskIds: [] }
  if (!Array.isArray(output.tasks) || output.tasks.length !== expectedTaskIds.length || output.tasks.length > MAX_TASKS) return { valid: false }
  const seen = new Set<string>()
  const failedTaskIds: string[] = []
  for (const candidate of output.tasks) {
    if (!validTask(candidate, expectedTaskIds)) return { valid: false }
    const taskId = candidate.taskId as string
    if (seen.has(taskId)) return { valid: false }
    seen.add(taskId)
    if (FAILURE_STATUSES.has(candidate.status as string)) failedTaskIds.push(taskId)
  }
  if (seen.size !== expectedTaskIds.length) return { valid: false }
  return { valid: true, failedTaskIds: [...new Set(failedTaskIds)].sort(compareTaskIds) }
}

export function replanRequiredControl(localId: string, dependsOn: readonly string[], failedTaskIds: readonly string[]): ReplanRequiredControl | undefined {
  if (failedTaskIds.length === 0) return undefined
  if (failedTaskIds.length > MAX_TASKS || failedTaskIds.some(taskId => typeof taskId !== "string" || taskId.trim() !== taskId || taskId.length === 0 || taskId.length > MAX_TASK_ID_LENGTH)) return undefined
  const sorted = [...new Set(failedTaskIds)].sort(compareTaskIds)
  return { localId: `${localId}:replan`, kind: "replan_required", dependsOn: [...dependsOn], reason: "child_failure", failedTaskIds: sorted }
}
