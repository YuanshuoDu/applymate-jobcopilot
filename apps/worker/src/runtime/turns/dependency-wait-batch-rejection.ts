import { isDeepStrictEqual } from "node:util"
import type { TurnEngineToolResult } from "./turn-engine-types.js"

type Row = Record<string, unknown>

export const DEPENDENCY_WAIT_BATCH_REJECTION = Object.freeze({
  code: "dependency_wait_requires_sole_call",
  message: "Issue the dependency wait as the only tool call in a model response.",
})
export const DEPENDENCY_WAIT_BATCH_REJECTION_MARKER = "agent-harness.v2.dependency-wait-batch-rejection.v1"
export const DEPENDENCY_WAIT_BATCH_REJECTION_ITEM_KEY = "dependencyWaitBatchRejection"

function object(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {} }
function has(row: Row, key: string): boolean { return Object.prototype.hasOwnProperty.call(row, key) }
function exactKeys(row: Row, keys: readonly string[]): boolean {
  return Object.keys(row).length === keys.length && keys.every(key => has(row, key))
}
function reject(): never { throw new Error("tool_result_replay_uncertain") }

function validateDurableResult(result: TurnEngineToolResult | undefined, callId: string, toolName: string): void {
  if (!result) return
  if (result.id !== callId || result.toolName !== toolName || result.toolVersion !== "1" || result.status !== "failed"
    || result.errorCode !== DEPENDENCY_WAIT_BATCH_REJECTION.code
    || Object.prototype.hasOwnProperty.call(result, "output") && !isDeepStrictEqual(result.output, DEPENDENCY_WAIT_BATCH_REJECTION)) reject()
}

/** Reconstructs the fixed no-dispatch receipt from a server-marked private call item. */
export function readDependencyWaitBatchRejection(input: {
  callId: string
  callItem: Row
  resultItem?: Row
  durableResult?: TurnEngineToolResult
}): TurnEngineToolResult | undefined {
  const content = object(input.callItem.content)
  if (!has(content, DEPENDENCY_WAIT_BATCH_REJECTION_ITEM_KEY)) return undefined
  const base = ["toolCallId", "toolName", "toolVersion", "input", DEPENDENCY_WAIT_BATCH_REJECTION_ITEM_KEY]
  if (content[DEPENDENCY_WAIT_BATCH_REJECTION_ITEM_KEY] !== DEPENDENCY_WAIT_BATCH_REJECTION_MARKER
    || content.toolCallId !== input.callId || typeof content.toolName !== "string" || !content.toolName.trim()
    || content.toolName === "agent.ask_user" || content.toolVersion !== "1"
    || typeof input.callItem.id !== "string" || !input.callItem.id || typeof input.callItem.stepId !== "string" || !input.callItem.stepId) reject()
  const toolName = content.toolName
  if (input.callItem.status === "started") {
    if (!exactKeys(content, base) || input.durableResult || input.resultItem) reject()
  } else if (input.callItem.status === "interrupted") {
    if (!exactKeys(content, [...base, "status", "errorCode"]) || content.status !== "interrupted"
      || content.errorCode !== "session_pause_requested" || input.durableResult || input.resultItem) reject()
  } else if (input.callItem.status === "completed") {
    if (!exactKeys(content, [...base, "status", "errorCode"]) || content.status !== "failed"
      || content.errorCode !== DEPENDENCY_WAIT_BATCH_REJECTION.code) reject()
  } else reject()
  validateDurableResult(input.durableResult, input.callId, toolName)
  if (input.resultItem) {
    const result = object(input.resultItem.content)
    if (has(result, DEPENDENCY_WAIT_BATCH_REJECTION_ITEM_KEY) || input.resultItem.stepId !== input.callItem.stepId
      || !["started", "completed"].includes(String(input.resultItem.status))
      || !exactKeys(result, ["toolCallId", "output", "errorCode"])
      || result.toolCallId !== input.callId || result.errorCode !== DEPENDENCY_WAIT_BATCH_REJECTION.code
      || !isDeepStrictEqual(result.output, DEPENDENCY_WAIT_BATCH_REJECTION)
      || typeof input.callItem.taskId === "string" && input.resultItem.taskId !== input.callItem.taskId
      || input.resultItem.id === input.callItem.id || input.callItem.status !== "completed") reject()
  }
  return { id: input.callId, toolName, toolVersion: "1", status: "failed",
    output: DEPENDENCY_WAIT_BATCH_REJECTION, errorCode: DEPENDENCY_WAIT_BATCH_REJECTION.code }
}
