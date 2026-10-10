import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { redactSensitiveValue } from "@jobcopilot/shared"
import { projectNativeVerificationResult } from "./native-verification-feedback-projection.js"

const WAIT_ID = /^wait-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const TASK_ID = /^subagent-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const WAIT_FIELDS = ["waitId", "status", "taskIds", "deadlineAt", "matchedTaskIds", "tasks"] as const
const TASK_FIELDS = ["taskId", "status", "role", "result", "failureReason"] as const
const WAIT_STATUSES = new Set(["waiting", "ready", "timed_out", "interrupted", "closed"])
const TASK_STATUSES = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"])
const MAX_WAIT_TARGETS = 50

/**
 * Preserves only generated identifiers in validated agent.wait / wait_subagents
 * outputs. Every other value still passes through the shared lifecycle redactor.
 */
export function redactDurableWaitOutput(value: unknown): RepositoryJsonValue {
  try {
    const copied = copyJson(value, new Set<object>())
    const receipt = exactObject(copied, WAIT_FIELDS, ["aggregate"])
    if (typeof receipt.waitId !== "string" || !WAIT_ID.test(receipt.waitId)
      || typeof receipt.status !== "string" || !WAIT_STATUSES.has(receipt.status)
      || typeof receipt.deadlineAt !== "string") throw invalidReceipt()

    const taskIds = readTaskIds(receipt.taskIds, false)
    const matchedTaskIds = readTaskIds(receipt.matchedTaskIds, true)
    if (matchedTaskIds.some(id => !taskIds.includes(id))) throw invalidReceipt()

    const taskRows = readArray(receipt.tasks, 1, MAX_WAIT_TARGETS)
    if (taskRows.length !== taskIds.length) throw invalidReceipt()
    taskRows.forEach((value, index) => {
      const task = exactObject(value, TASK_FIELDS)
      const expectedTaskId = taskIds[index]
      if (typeof task.taskId !== "string" || !TASK_ID.test(task.taskId) || task.taskId !== expectedTaskId
        || typeof task.status !== "string" || !TASK_STATUSES.has(task.status)
        || typeof task.role !== "string" || task.role.length < 1 || task.role.length > 256
        || (task.failureReason !== null && typeof task.failureReason !== "string")) throw invalidReceipt()
    })

    const projected = {
      ...receipt,
      tasks: taskRows.map(value => {
        const task = value as Record<string, RepositoryJsonValue>
        return { ...task, result: projectNativeVerificationResult(task.result) }
      }),
    }
    const redacted = redactSensitiveValue(projected)
    const safe = asRecord(redacted)
    const safeRows = readArray(safe.tasks, 1, MAX_WAIT_TARGETS).map((row, index) => {
      const safeTask = asRecord(row)
      const taskId = taskIds[index]
      if (taskId === undefined) throw invalidReceipt()
      return { ...safeTask, taskId }
    })
    return {
      ...safe,
      waitId: receipt.waitId,
      taskIds,
      matchedTaskIds,
      tasks: safeRows,
    }
  } catch {
    throw invalidReceipt()
  }
}

function readTaskIds(value: RepositoryJsonValue | undefined, allowEmpty: boolean): string[] {
  const ids = readArray(value, allowEmpty ? 0 : 1, MAX_WAIT_TARGETS)
  const result = ids.map(id => {
    if (typeof id !== "string" || !TASK_ID.test(id)) throw invalidReceipt()
    return id
  })
  if (new Set(result).size !== result.length) throw invalidReceipt()
  return result
}

function readArray(value: RepositoryJsonValue | undefined, minLength: number, maxLength: number): RepositoryJsonValue[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < minLength || value.length > maxLength) throw invalidReceipt()
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1 || keys.some(key => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)))) {
    throw invalidReceipt()
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalidReceipt()
  }
  return value
}

function exactObject(
  value: RepositoryJsonValue,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, RepositoryJsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidReceipt()
  const keys = Reflect.ownKeys(value)
  if (keys.length < required.length || keys.length > required.length + optional.length
    || keys.some(key => typeof key !== "string" || (!required.includes(key) && !optional.includes(key)))) throw invalidReceipt()
  for (const key of required) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalidReceipt()
  }
  for (const key of optional) {
    if (!Object.hasOwn(value, key)) continue
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalidReceipt()
  }
  return value as Record<string, RepositoryJsonValue>
}

function asRecord(value: RepositoryJsonValue | undefined): Record<string, RepositoryJsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidReceipt()
  return value as Record<string, RepositoryJsonValue>
}

/** Copies the full JSON shape; depth handling remains the shared redactor's. */
function copyJson(value: unknown, ancestors: Set<object>): RepositoryJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value
    throw invalidReceipt()
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw invalidReceipt()
    const keys = Reflect.ownKeys(value)
    if (keys.length !== value.length + 1 || keys.some(key => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)))) throw invalidReceipt()
    if (ancestors.has(value)) throw invalidReceipt()
    ancestors.add(value)
    try {
      const entries: RepositoryJsonValue[] = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !("value" in descriptor)) throw invalidReceipt()
        entries.push(copyJson(descriptor.value, ancestors))
      }
      return entries
    } finally {
      ancestors.delete(value)
    }
  }
  if (typeof value !== "object" || value === undefined) throw invalidReceipt()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw invalidReceipt()
  if (ancestors.has(value)) throw invalidReceipt()
  ancestors.add(value)
  try {
    const entries: Array<[string, RepositoryJsonValue]> = []
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw invalidReceipt()
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) throw invalidReceipt()
      entries.push([key, copyJson(descriptor.value, ancestors)])
    }
    return Object.fromEntries(entries)
  } finally {
    ancestors.delete(value)
  }
}

function invalidReceipt(): Error {
  return new Error("durable_wait_receipt_invalid")
}
