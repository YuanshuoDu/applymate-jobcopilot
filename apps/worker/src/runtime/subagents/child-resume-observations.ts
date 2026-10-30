import { Buffer } from "node:buffer"
import { canonicalJson, redactSensitiveText } from "@jobcopilot/shared"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import type { ContextSeedBlock } from "../context/step-context-builder.js"
import type { SubagentLease } from "./types.js"
import { dateValue, DurableSubagentWaitError, object as waitObject, safeSubagentWaitJson, waitResult, type DurableSubagentWaitResult } from "./durable-subagent-wait-store.js"
import { markCanonicalSubagentWaitTargetIds } from "./subagent-wait-structural-ids.js"

type Row = Record<string, unknown>
type ToolCall = { readonly stepId: string; readonly toolName: string; readonly input: unknown }
const MAX_TOOL_OUTPUT_BYTES = 6 * 1024
const MAX_TOOL_INPUT_BYTES = 1024
const MAX_RESTORED_OBSERVATIONS = 256
const MAX_RESTORED_OBSERVATION_BYTES = 256 * 1024
const TERMINAL_WAIT_TASK_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled", "closed", "passed", "skipped"])
const VALID_WAIT_TASK_STATUSES = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user", ...TERMINAL_WAIT_TASK_STATUSES])

export type DurableWaitResume = Readonly<{
  waitId: string; stepId: string; attempt: number; ordinal: number; toolCallId: string; sourceItemId: string; input: unknown; output: unknown; continuationStepId?: string; continuationOrdinal?: number
}>

function text(row: Row, key: string): string {
  const value = row[key]
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`child_resume_invalid_${key}`)
  return value
}
export function integer(row: Row, key: string, minimum = 0): number {
  const value = typeof row[key] === "number" ? row[key] : Number(row[key])
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`child_resume_invalid_${key}`)
  return value
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function waitTask(value: Row | null): value is Row & { readonly taskId: string } {
  return !!value && typeof value.taskId === "string"
}
function canonicalToolCallId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256
}
function exactKeys(value: Row, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
}
function sensitiveKey(key: string): boolean {
  return /api.?key|secret|password|(?:access|refresh).?token|authorization/i.test(key)
}
function safeJson(value: unknown, path = new Set<object>(), depth = 0): RepositoryJsonValue {
  if (value === null) return null
  if (typeof value === "string") return redactSensitiveText(value)
  if (typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (!value || typeof value !== "object" || depth > 32 || path.has(value)) return "[TRUNCATED]"
  path.add(value)
  try {
    if (Array.isArray(value)) return value.map(child => safeJson(child, path, depth + 1))
    const result: { [key: string]: RepositoryJsonValue } = {}
    for (const key of Object.keys(value).sort()) if (!sensitiveKey(key)) result[key] = safeJson((value as Record<string, unknown>)[key], path, depth + 1)
    return result
  } finally { path.delete(value) }
}
function utf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0
  let prefix = ""
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8")
    if (bytes + characterBytes > maxBytes) break
    prefix += character
    bytes += characterBytes
  }
  return prefix
}
function boundedJson(value: unknown, maxBytes: number): RepositoryJsonValue {
  const normalized = safeJson(value)
  const encoded = JSON.stringify(normalized)
  if (Buffer.byteLength(encoded, "utf8") <= maxBytes) return normalized
  const marker: { truncated: boolean; byteLength: number; preview: string } = { truncated: true, byteLength: Buffer.byteLength(encoded, "utf8"), preview: "" }
  let previewBudget = Math.max(0, maxBytes - Buffer.byteLength(JSON.stringify(marker), "utf8") - 1)
  while (previewBudget >= 0) {
    marker.preview = utf8Prefix(encoded, previewBudget)
    if (Buffer.byteLength(JSON.stringify(marker), "utf8") <= maxBytes) return marker
    previewBudget -= 32
  }
  return { truncated: true, byteLength: marker.byteLength, preview: "" }
}
function errorCode(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("child_resume_invalid_errorCode")
  return value
}

export function buildChildResumeObservations(rows: readonly Row[], lease: SubagentLease, currentAttemptOrdinal?: number): readonly ContextSeedBlock[] {
  const calls = new Map<string, ToolCall>()
  const results = new Set<string>()
  const pending: Array<{ readonly id: string; readonly stepId: string; readonly callId: string; readonly output: unknown; readonly status: string }> = []
  for (const row of rows) {
    const attempt = integer(row, "attempt", 1)
    if (text(row, "sessionId") !== lease.sessionId || text(row, "turnId") !== lease.turnId || text(row, "taskId") !== lease.id
      || text(row, "rootTaskId") !== lease.rootTaskId || attempt > lease.attemptCount
      || attempt === lease.attemptCount && (currentAttemptOrdinal === undefined || integer(row, "ordinal") > currentAttemptOrdinal)) {
      throw new Error("child_resume_item_lineage")
    }
    const stepId = text(row, "stepId")
    const content = object(row.content)
    if (!content || (row.type !== "tool_call" && row.type !== "tool_result")) continue
    if (typeof row.status !== "string" || !["started", "streaming", "completed", "failed", "interrupted"].includes(row.status)) throw new Error("child_resume_invalid_item_status")
    const callId = canonicalToolCallId(content.toolCallId) ? content.toolCallId : null
    if (!callId) continue
    if (row.type === "tool_call") {
      const toolName = typeof content.toolName === "string" && content.toolName.trim() ? content.toolName : null
      if (!toolName) throw new Error("child_resume_invalid_tool_call")
      const previous = calls.get(callId)
      if (!previous) calls.set(callId, { stepId, toolName, input: content.input ?? {} })
      else if (previous.stepId !== stepId || previous.toolName !== toolName || canonicalJson(previous.input) !== canonicalJson(content.input ?? {})) throw new Error("child_resume_tool_call_conflict")
    } else if (row.status === "completed") {
      if (results.has(callId)) throw new Error("child_resume_tool_result_conflict")
      results.add(callId)
      pending.push({ id: text(row, "id"), stepId, callId, output: content.output ?? null, status: errorCode(content.errorCode) === null ? "completed" : "failed" })
    }
  }
  const seen = new Set<string>()
  if (pending.length > MAX_RESTORED_OBSERVATIONS) throw new Error("child_resume_observation_limit")
  const restored = pending.flatMap(item => {
    const call = calls.get(item.callId)
    if (!call || call.stepId !== item.stepId || seen.has(item.callId)) return []
    seen.add(item.callId)
    return [{ id: `child-resume:${item.id}`, content: { toolCallId: item.callId, toolName: call.toolName, input: boundedJson(call.input, MAX_TOOL_INPUT_BYTES), status: item.status,
      output: boundedJson(item.output, MAX_TOOL_OUTPUT_BYTES), errorCode: item.status === "completed" ? null : "tool_execution_failed" } }]
  })
  if (Buffer.byteLength(JSON.stringify(restored), "utf8") > MAX_RESTORED_OBSERVATION_BYTES) throw new Error("child_resume_observation_limit")
  return restored
}

export function countChildResumeToolCalls(rows: readonly Row[], lease: SubagentLease, currentAttemptOrdinal?: number): number {
  let count = 0
  for (const row of rows) {
    if (row.type !== "tool_call") continue
    const attempt = integer(row, "attempt", 1)
    if (text(row, "sessionId") !== lease.sessionId || text(row, "turnId") !== lease.turnId || text(row, "taskId") !== lease.id
      || text(row, "rootTaskId") !== lease.rootTaskId || attempt > lease.attemptCount
      || attempt === lease.attemptCount && (currentAttemptOrdinal === undefined || integer(row, "ordinal") > currentAttemptOrdinal)) throw new Error("child_resume_item_lineage")
    const content = object(row.content)
    if (!content || typeof content.toolCallId !== "string" || !content.toolCallId.trim()) throw new Error("child_resume_invalid_tool_call")
    count += 1
  }
  return count
}

export function mergeDurableWaitObservation(observations: readonly ContextSeedBlock[], wait: DurableWaitResume): readonly ContextSeedBlock[] {
  if (!wait.waitId.trim() || !wait.stepId.trim() || !canonicalToolCallId(wait.toolCallId) || !wait.sourceItemId.trim()
    || !Number.isSafeInteger(wait.attempt) || !Number.isSafeInteger(wait.ordinal) || wait.attempt < 1 || wait.ordinal < 0) {
    throw new Error("child_resume_wait_lineage")
  }
  const input = object(wait.input)
  const output = object(wait.output)
  const inputIds = inputIdsOf(wait.input)
  const outputIds = output && Array.isArray(output.taskIds) && output.taskIds.length <= 8 ? strictIds(output.taskIds) : undefined
  const matchedIds = output && Array.isArray(output.matchedTaskIds) && output.matchedTaskIds.length <= 8 ? strictIds(output.matchedTaskIds) : undefined
  const tasks = output && Array.isArray(output.tasks) && output.tasks.length <= 8 ? output.tasks.map(object) : []
  const taskIds = strictIds(tasks.map(task => task?.taskId))
  const validTasks = tasks.every(task => !!task && exactKeys(task, ["taskId", "status", "role", "result", "failureReason"])
    && typeof task.status === "string" && VALID_WAIT_TASK_STATUSES.has(task.status) && typeof task.role === "string" && !!task.role.trim()
    && (task.failureReason === null || typeof task.failureReason === "string"))
  const terminalIds = tasks.flatMap(task => task && typeof task.taskId === "string" && typeof task.status === "string"
    && TERMINAL_WAIT_TASK_STATUSES.has(task.status) ? [task.taskId] : [])
  if (!input || !output || !exactKeys(output, ["waitId", "status", "taskIds", "deadlineAt", "matchedTaskIds", "tasks"])
    || output.waitId !== wait.waitId || !["ready", "timed_out"].includes(String(output.status))
    || typeof output.deadlineAt !== "string" || !Number.isFinite(Date.parse(output.deadlineAt))
    || !outputIds || outputIds.length !== inputIds.length || !sameIds(outputIds, inputIds)
    || !matchedIds || matchedIds.some(id => !inputIds.includes(id)) || !sameIds(terminalIds, matchedIds) || !taskIds || !sameIds(taskIds, inputIds)
    || tasks.length !== inputIds.length || !validTasks
    || output.status === "ready" && (input.mode === "all" ? !sameIds(matchedIds, inputIds) : matchedIds.length === 0)) {
    throw new Error("child_resume_invalid_wait_result")
  }
  const rawOutputIds = output.taskIds as string[], rawMatchedIds = output.matchedTaskIds as string[]
  const taskById = new Map<string, Row & { taskId: string }>()
  for (const task of tasks) if (waitTask(task)) taskById.set(task.taskId, task)
  const alignedInput = { taskIds: inputIds, matchedTaskIds: matchedIds, tasks: inputIds.map(taskId => ({ taskId })) }
  const alignedOutput = { taskIds: rawOutputIds, matchedTaskIds: rawMatchedIds, tasks: rawOutputIds.map(id => taskById.get(id)!) }
  if (!markCanonicalSubagentWaitTargetIds({ targetTaskIds: inputIds }, alignedInput, inputIds)
    || !markCanonicalSubagentWaitTargetIds({ targetTaskIds: rawOutputIds }, alignedOutput, rawOutputIds)) throw new Error("child_resume_invalid_wait_result")
  const sourceObservationId = `child-resume:${wait.sourceItemId}`
  const sourceMatches = observations.filter(item => item.id === sourceObservationId)
  const matching = observations.filter(item => object(item.content)?.toolCallId === wait.toolCallId)
  const redactedCallId = redactSensitiveText(wait.toolCallId)
  const sourceCallId = sourceMatches.length === 1 ? object(sourceMatches[0]?.content)?.toolCallId : undefined
  if (sourceMatches.length > 1 || matching.length > 1 || matching.some(item => item.id !== sourceObservationId)
    || sourceMatches.length === 1 && sourceCallId !== wait.toolCallId && sourceCallId !== redactedCallId) {
    throw new Error("child_resume_wait_tool_call_conflict")
  }
  const item = {
    id: sourceObservationId,
    content: { toolCallId: wait.toolCallId, toolName: "wait_subagents",
      input: safeSubagentWaitJson(wait.input, MAX_TOOL_INPUT_BYTES) as RepositoryJsonValue, status: "completed",
      output: safeSubagentWaitJson(wait.output, MAX_TOOL_OUTPUT_BYTES) as RepositoryJsonValue, errorCode: null },
  }
  return [...observations.filter(observation => observation.id !== sourceObservationId
    && object(observation.content)?.toolCallId !== wait.toolCallId), item]
}

function inputIdsOf(value: unknown): string[] {
  const input = object(value)
  if (!input || !exactKeys(input, ["idempotencyKey", "taskIds", "mode", "timeoutMs"])
    || typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey !== input.idempotencyKey.trim() || input.idempotencyKey.length > 256
    || !Array.isArray(input.taskIds) || input.taskIds.length < 1 || input.taskIds.length > 8
    || !input.taskIds.every(id => typeof id === "string" && id.length <= 256 && id.trim() && id === id.trim())
    || new Set(input.taskIds).size !== input.taskIds.length
    || !(input.mode === "any" || input.mode === "all") || !Number.isSafeInteger(input.timeoutMs)
    || Number(input.timeoutMs) < 1 || Number(input.timeoutMs) > 30_000) throw new Error("child_resume_invalid_wait_input")
  return input.taskIds as string[]
}

export function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && new Set(right).size === right.length && left.every(id => right.includes(id))
}

function strictIds(value: unknown): string[] | undefined {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!Array.isArray(parsed)) return undefined
  const ids: string[] = []
  for (const id of parsed) {
    if (typeof id !== "string" || !id.trim() || id !== id.trim() || id.length > 256) return undefined
    ids.push(id)
  }
  return new Set(ids).size === ids.length ? ids : undefined
}

export function resolveDurableWaitOutcome(wait: Row, ids: readonly string[], currentMatched: readonly string[], now: Date): DurableSubagentWaitResult {
  const stored = waitObject(waitObject(wait.result).outcome)
  const rowMatched = strictIds(wait.matchedTaskIds), storedMatched = strictIds(stored.matchedTaskIds)
  const storedIds = strictIds(stored.taskIds)
  const deadline = dateValue(wait.deadlineAt, "deadlineAt")
  const outcome = waitResult(wait)
  const modeIsValid = wait.mode === "any" || wait.mode === "all"
  const matchedIsValid = !!rowMatched && !!storedMatched && sameIds(rowMatched, storedMatched)
    && rowMatched.every(id => ids.includes(id) && currentMatched.includes(id))
  const readyIsValid = wait.status !== "ready" || (!!rowMatched && (wait.mode === "any" ? rowMatched.length > 0 : rowMatched.length === ids.length))
  const timeoutIsValid = wait.status !== "timed_out" || now >= deadline
  if (stored.waitId !== wait.id || stored.status !== wait.status || !storedIds || !sameIds(storedIds, ids)
    || dateValue(stored.deadlineAt, "outcome.deadlineAt").getTime() !== deadline.getTime()
    || !modeIsValid || !matchedIsValid || !readyIsValid || !timeoutIsValid
    || outcome.status !== wait.status || !sameIds(outcome.taskIds, ids) || outcome.tasks.length !== ids.length
    || !sameIds(outcome.tasks.map(task => task.taskId), ids) || !sameIds(outcome.matchedTaskIds, rowMatched ?? [])) {
    throw new DurableSubagentWaitError("wait_scope_error", "Persisted child wait result is invalid")
  }
  return outcome
}
