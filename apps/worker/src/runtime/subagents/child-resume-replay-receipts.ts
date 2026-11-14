import { canonicalJson, redactSensitiveText } from "@jobcopilot/shared"
import type { ChildToolReplayReceipt, ChildWaitReplayReceipt } from "../turns/turn-execution-options.js"
import type { DurableWaitResume } from "./child-resume-observations.js"
import type { SubagentLease } from "./types.js"

type Row = Record<string, unknown>
type Item = Readonly<{ id: string; revision?: number; stepId: string; attempt: number; ordinal: number; content: Row }>
type ToolCall = Item & Readonly<{ toolName: string; input: unknown; inputPresent: boolean; status: string }>
export type ChildResumeReplayPair = Readonly<{
  resultItemId: string; stepId: string; attempt: number; ordinal: number; toolCallId: string; toolName: string
  input: unknown; output: unknown; status: "completed" | "failed"; errorCode: string | null
  callItem: Readonly<{ id: string; revision?: number }>; resultItem: Readonly<{ id: string; revision?: number }>
}>
export type ChildResumeReplayReceiptSet = Readonly<{
  pairs: readonly ChildResumeReplayPair[]
  childToolReplayReceipts: readonly ChildToolReplayReceipt[]
  childWaitReplayReceipts: readonly ChildWaitReplayReceipt[]
}>

const ITEM_STATUSES = new Set(["started", "streaming", "completed", "failed", "interrupted"])

/** Pair persisted child items once and mint receipts only from complete owner-scoped evidence. */
export function buildChildResumeReplayReceipts(
  rows: readonly Row[], lease: SubagentLease, currentAttemptOrdinal?: number, durableWaits: readonly DurableWaitResume[] = [],
): ChildResumeReplayReceiptSet {
  const calls = new Map<string, ToolCall>(), results = new Map<string, Item>(), ids = new Set<string>()
  for (const row of rows) {
    const attempt = integer(row, "attempt", 1), stepId = text(row, "stepId"), ordinal = integer(row, "ordinal", 0)
    if (text(row, "sessionId") !== lease.sessionId || text(row, "turnId") !== lease.turnId || text(row, "taskId") !== lease.id
      || text(row, "rootTaskId") !== lease.rootTaskId || attempt > lease.attemptCount
      || attempt === lease.attemptCount && currentAttemptOrdinal !== undefined && ordinal > currentAttemptOrdinal) throw new Error("child_resume_item_lineage")
    const content = object(row.content)
    if (!content || row.type !== "tool_call" && row.type !== "tool_result") continue
    if (typeof row.status !== "string" || !ITEM_STATUSES.has(row.status)) throw new Error("child_resume_invalid_item_status")
    if (!canonicalToolCallId(content.toolCallId)) continue
    const callId = content.toolCallId
    const pairKey = JSON.stringify([attempt, callId])
    const id = text(row, "id"), revision = validRevision(row.revision) ? row.revision : undefined
    const item = { id, ...(revision === undefined ? {} : { revision }), stepId, attempt, ordinal, content }
    if (ids.has(id)) throw new Error("child_resume_tool_item_conflict")
    ids.add(id)
    if (row.type === "tool_call") {
      const previous = calls.get(pairKey)
      if (typeof content.toolName !== "string" || !content.toolName.trim() || previous) {
        throw new Error(previous?.toolName === "wait_subagents" || content.toolName === "wait_subagents"
          ? "child_resume_wait_tool_call_conflict" : "child_resume_tool_call_conflict")
      }
      calls.set(pairKey, { ...item, toolName: content.toolName, input: content.input ?? {}, inputPresent: Object.hasOwn(content, "input"), status: row.status })
    } else if (row.status === "completed") {
      if (results.has(pairKey)) throw new Error("child_resume_tool_result_conflict")
      results.set(pairKey, item)
    }
  }
  const pairs: ChildResumeReplayPair[] = [], childToolReplayReceipts: ChildToolReplayReceipt[] = []
  const childWaitReplayReceipts: ChildWaitReplayReceipt[] = []
  for (const [pairKey, result] of results) {
    const call = calls.get(pairKey)
    if (!call) continue
    if (call.stepId !== result.stepId || call.ordinal !== result.ordinal) throw new Error(call.toolName === "wait_subagents"
      ? "child_resume_wait_tool_call_conflict" : "child_resume_tool_call_conflict")
    const callId = String(call.content.toolCallId)
    const error = errorCode(result.content.errorCode), status = error === null ? "completed" : "failed"
    const output = result.content.output ?? null, input = call.input
    const pair: ChildResumeReplayPair = {
      resultItemId: result.id, stepId: result.stepId, attempt: result.attempt, ordinal: result.ordinal,
      toolCallId: callId, toolName: call.toolName, input, output, status, errorCode: error,
      callItem: { id: call.id, ...(call.revision === undefined ? {} : { revision: call.revision }) },
      resultItem: { id: result.id, ...(result.revision === undefined ? {} : { revision: result.revision }) },
    }
    pairs.push(pair)
    if (!receiptScopeValid(lease) || call.status !== "completed" || !call.inputPresent
      || !Object.hasOwn(result.content, "output") || !Object.hasOwn(result.content, "errorCode")
      || !validRevision(call.revision) || !validRevision(result.revision) || call.id === result.id) continue
    if (call.toolName === "wait_subagents") {
      const waits = durableWaits.filter(wait => wait.toolCallId === callId && wait.attempt === call.attempt && wait.stepId === call.stepId && wait.ordinal === call.ordinal)
      if (waits.length > 1) throw new Error("child_resume_wait_tool_call_conflict")
      if (waits.length === 1 && validWaitPair(waits[0]!, call, result, lease, pair)) {
        const wait = waits[0]!
        childWaitReplayReceipts.push(Object.freeze({ ...receipt(lease, pair, wait.output), waitId: wait.waitId, source: Object.freeze({
          attempt: wait.attempt, stepId: wait.stepId, ordinal: wait.ordinal, toolCallId: wait.toolCallId, sourceItemId: wait.sourceItemId,
          callItem: Object.freeze({ id: call.id, revision: call.revision }), resultItem: Object.freeze({ id: result.id, revision: result.revision }),
          input: wait.input, persistedResult: Object.freeze({ status: "completed", output, errorCode: null }),
          ...(wait.continuationStepId ? { continuationStepId: wait.continuationStepId } : {}),
          ...(wait.continuationOrdinal !== undefined ? { continuationOrdinal: wait.continuationOrdinal } : {}),
        }) }))
      }
      continue
    }
    childToolReplayReceipts.push(Object.freeze(receipt(lease, pair, output)))
  }
  return { pairs, childToolReplayReceipts, childWaitReplayReceipts }
}

function receipt(lease: SubagentLease, pair: ChildResumeReplayPair, output: unknown): ChildToolReplayReceipt {
  return Object.freeze({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId!, rootTaskId: lease.rootTaskId,
    taskId: lease.id, attempt: pair.attempt, stepId: pair.stepId, toolCallId: pair.toolCallId, toolName: pair.toolName,
    input: pair.input, callItem: Object.freeze({ id: pair.callItem.id, revision: pair.callItem.revision! }),
    resultItem: Object.freeze({ id: pair.resultItem.id, revision: pair.resultItem.revision! }),
    result: Object.freeze({ status: pair.status, output, errorCode: pair.errorCode }) })
}

function validWaitPair(wait: DurableWaitResume, call: ToolCall, result: Item, lease: SubagentLease, pair: ChildResumeReplayPair): boolean {
  if (!validText(wait.waitId) || wait.stepId !== pair.stepId || wait.attempt !== pair.attempt || wait.ordinal !== pair.ordinal
    || wait.toolCallId !== pair.toolCallId || wait.sourceItemId !== result.id || call.toolName !== "wait_subagents"
    || pair.status !== "completed" || pair.errorCode !== null || !validOrdinal(wait.ordinal)
    || !validText(wait.continuationStepId) || !validOrdinal(wait.continuationOrdinal) || wait.continuationOrdinal! <= wait.ordinal) return false
  const rawInput = object(call.input), safeInput = object(wait.input), rawResult = object(pair.output), resolved = object(wait.output)
  if (!rawInput || !safeInput || !rawResult || !resolved || !exactKeys(rawInput, ["idempotencyKey", "taskIds", "mode", "timeoutMs"])
    || !exactKeys(safeInput, ["idempotencyKey", "taskIds", "mode", "timeoutMs"])
    || typeof rawInput.idempotencyKey !== "string" || typeof safeInput.idempotencyKey !== "string"
    || redactSensitiveText(rawInput.idempotencyKey) !== safeInput.idempotencyKey || !sameJson(rawInput.taskIds, safeInput.taskIds)
    || rawInput.mode !== safeInput.mode || rawInput.timeoutMs !== safeInput.timeoutMs
    || rawResult.status !== "waiting" || rawResult.waitId !== wait.waitId || resolved.waitId !== wait.waitId
    || !["ready", "timed_out"].includes(String(resolved.status)) || !sameJson(rawResult.taskIds, rawInput.taskIds)
    || !sameJson(resolved.taskIds, rawInput.taskIds) || !sameJson(rawResult.deadlineAt, resolved.deadlineAt)
    || !Array.isArray(rawResult.matchedTaskIds) || rawResult.matchedTaskIds.length !== 0) return false
  return true
}

function receiptScopeValid(lease: SubagentLease): boolean {
  return [lease.userId, lease.sessionId, lease.turnId, lease.rootTaskId, lease.id].every(validText)
    && Number.isSafeInteger(lease.attemptCount) && lease.attemptCount > 0
}
function validOrdinal(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 }
function validRevision(value: unknown): value is number { return validOrdinal(value) }
function validText(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 256 }
function canonicalToolCallId(value: unknown): value is string { return validText(value) }
function text(row: Row, key: string): string {
  const value = row[key]; if (typeof value !== "string" || !value.trim()) throw new Error(`child_resume_invalid_${key}`); return value
}
function integer(row: Row, key: string, minimum: number): number {
  const value = typeof row[key] === "number" ? row[key] : Number(row[key]); if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`child_resume_invalid_${key}`); return value
}
function object(value: unknown): Row | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null }
function errorCode(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (!validErrorCode(value)) throw new Error("child_resume_invalid_errorCode")
  return value
}
function validErrorCode(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) }
function exactKeys(value: Row, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(), keys = [...expected].sort()
  return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}
function sameJson(left: unknown, right: unknown): boolean { try { return canonicalJson(left) === canonicalJson(right) } catch { return false } }
