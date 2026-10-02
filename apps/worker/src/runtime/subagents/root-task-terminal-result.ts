import type { TurnExecutionResult } from "../turns/turn-queue.js"

export type RootTaskTerminalReconciliation = {
  readonly rootTaskId: string
  readonly result: Omit<TurnExecutionResult, "status"> & { readonly status: Exclude<TurnExecutionResult["status"], "queued"> }
}
type Row = Record<string, unknown>
const ROOT_STATUSES = new Set(["completed", "failed", "interrupted", "waiting", "waiting_for_user"])
const TURN_STATUSES = new Set(["completed", "failed", "interrupted", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"])

function object(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {} }
function boundedText(value: unknown, name: string): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > 256) throw new Error(`root_terminal_${name}_invalid`)
  return value
}
function resultCount(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 2_147_483_647) throw new Error(`root_terminal_${name}_invalid`)
  return Number(value)
}

export function parseTerminalRootResult(value: unknown): RootTaskTerminalReconciliation {
  const row = object(value), payload = object(row.result)
  const rootTaskId = boundedText(row.id, "id"), rootStatus = boundedText(row.status, "status"), turnStatus = boundedText(payload.status, "result")
  if (!rootTaskId || !rootStatus || !ROOT_STATUSES.has(rootStatus) || !turnStatus || !TURN_STATUSES.has(turnStatus)) throw new Error("root_terminal_result_invalid")
  const expectedRootStatus = turnStatus === "waiting_for_dependency" ? "waiting" : turnStatus === "waiting_for_approval" ? "waiting_for_user" : turnStatus
  if (expectedRootStatus !== rootStatus) throw new Error("root_terminal_status_mismatch")
  resultCount(payload.stepCount, "step_count")
  resultCount(payload.toolCallCount, "tool_call_count")
  const waitId = boundedText(payload.waitId, "wait_id")
  if (turnStatus === "waiting_for_dependency" && !waitId) throw new Error("root_terminal_wait_id_missing")
  const summary = boundedText(row.failureReason, "failure_reason")
  return { rootTaskId, result: { status: turnStatus as RootTaskTerminalReconciliation["result"]["status"], ...(summary ? { summary } : {}), ...(waitId ? { waitId } : {}) } }
}
