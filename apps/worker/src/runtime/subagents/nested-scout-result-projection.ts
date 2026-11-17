import { isProxy } from "node:util/types"

import { validateRoleResult } from "./role-results.js"

const MAX_CHILDREN = 2
const MAX_CANDIDATES = 20
const MAX_STRING_LENGTH = 256
const WAIT_TASK_BASE_KEYS = ["failureReason", "result", "role", "status", "taskId"] as const
const WAIT_TASK_EXTENDED_KEYS = [
  ...WAIT_TASK_BASE_KEYS,
  "attemptCount", "interruptRequestedAt", "leaseExpiresAt", "maxAttempts",
] as const

export type NestedScoutCandidateProjection = Readonly<{ jobId: string; source: string }>
export type NestedScoutChildProjection = Readonly<{
  taskId: string
  taskStatus: "completed"
  candidates: readonly NestedScoutCandidateProjection[]
}>
export type NestedScoutResultProjection =
  | Readonly<{ availability: "unavailable" }>
  | Readonly<{ availability: "available"; children: readonly NestedScoutChildProjection[] }>

const UNAVAILABLE: NestedScoutResultProjection = Object.freeze({ availability: "unavailable" })

/**
 * Projects only the expected completed direct Scout children from a wait result.
 * Stored child results must retain their completed wrapper and validated Scout
 * payload; text-only, truncated, partial, or foreign results fail closed.
 */
export function projectNestedScoutResults(
  value: unknown,
  expectedChildTaskIds: readonly string[],
): NestedScoutResultProjection {
  try {
    const expectedIds = readExpectedIds(expectedChildTaskIds)
    if (!expectedIds) return UNAVAILABLE

    const taskValues = readTasks(value)
    if (!taskValues || taskValues.length !== expectedIds.length) return UNAVAILABLE

    const expected = new Set(expectedIds)
    const tasksById = new Map<string, Record<string, unknown>>()
    for (const taskValue of taskValues) {
      const task = waitTaskRecord(taskValue)
      if (!task || task.role !== "scout" || task.status !== "completed"
        || typeof task.taskId !== "string" || !expected.has(task.taskId) || tasksById.has(task.taskId)) {
        return UNAVAILABLE
      }
      tasksById.set(task.taskId, task)
    }
    if (tasksById.size !== expectedIds.length) return UNAVAILABLE

    const children: NestedScoutChildProjection[] = []
    let candidateTotal = 0
    for (const taskId of expectedIds) {
      const task = tasksById.get(taskId)
      if (!task) return UNAVAILABLE
      const wrapper = safeRecord(task.result)
      if (!wrapper || wrapper.status !== "completed" || !Object.hasOwn(wrapper, "structuredResult")
        || !safeJsonData(wrapper)) return UNAVAILABLE

      const result = validateRoleResult(wrapper.structuredResult, "scout")
      if (result.status !== "completed") return UNAVAILABLE
      candidateTotal += result.candidates.length
      if (candidateTotal > MAX_CANDIDATES) return UNAVAILABLE

      const candidates = result.candidates.map(candidate => {
        if (!boundedString(candidate.jobId) || !boundedString(candidate.source)) throw new Error("nested_scout_string_out_of_bounds")
        return { jobId: candidate.jobId, source: candidate.source }
      })
      children.push({ taskId, taskStatus: "completed", candidates })
    }

    return { availability: "available", children }
  } catch {
    return UNAVAILABLE
  }
}

function readExpectedIds(value: readonly string[]): string[] | null {
  if (!denseArray(value, MAX_CHILDREN) || value.length < 1) return null
  const ids: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!boundedString(item) || item.trim() !== item || seen.has(item)) return null
    ids.push(item)
    seen.add(item)
  }
  return ids
}

function readTasks(value: unknown): unknown[] | null {
  let tasks = value
  if (!Array.isArray(value)) {
    const envelope = safeRecord(value)
    if (!envelope || !Object.hasOwn(envelope, "tasks")) return null
    tasks = envelope.tasks
  }
  return denseArray(tasks, MAX_CHILDREN) ? tasks : null
}

function waitTaskRecord(value: unknown): Record<string, unknown> | null {
  const row = safeRecord(value)
  if (!row) return null
  const keys = Object.keys(row).sort().join(",")
  const baseKeys = [...WAIT_TASK_BASE_KEYS].sort().join(",")
  const extendedKeys = [...WAIT_TASK_EXTENDED_KEYS].sort().join(",")
  if (keys !== baseKeys && keys !== extendedKeys) return null
  if (keys === extendedKeys && (!isNonNegativeInteger(row.attemptCount) || !isPositiveInteger(row.maxAttempts)
    || !nullableString(row.leaseExpiresAt, MAX_STRING_LENGTH) || !nullableString(row.interruptRequestedAt, MAX_STRING_LENGTH))) return null
  if (!nullableString(row.failureReason, 500)) return null
  return row
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return null
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null
    }
    return value as Record<string, unknown>
  } catch {
    return null
  }
}

function denseArray(value: unknown, maximum: number): value is unknown[] {
  if (!Array.isArray(value) || isProxy(value) || value.length > maximum) return false
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false
    const keys = Reflect.ownKeys(value)
    if (keys.length !== value.length + 1 || !keys.includes("length")) return false
    for (const key of keys) {
      if (key === "length") continue
      if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return false
    }
    return true
  } catch {
    return false
  }
}

function safeJsonData(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object" || isProxy(value) || depth > 32 || seen.has(value)) return false
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (!denseArray(value, 1_000)) return false
      return value.every(item => safeJsonData(item, seen, depth + 1))
    }
    const row = safeRecord(value)
    if (!row || Object.hasOwn(row, "$truncated")) return false
    return Object.values(row).every(item => safeJsonData(item, seen, depth + 1))
  } finally {
    seen.delete(value)
  }
}

function boundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_STRING_LENGTH
}

function nullableString(value: unknown, maximumLength: number): boolean {
  return value === null || (typeof value === "string" && value.length <= maximumLength)
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 1
}
