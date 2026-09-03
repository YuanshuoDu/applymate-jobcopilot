import type { SubagentExecutionResult } from "./types.js"

export function normalizeLegacySubagentResult(value: unknown): SubagentExecutionResult {
  if (!isRecord(value)) return { status: "completed", result: { legacy: true, value } }
  const status = value.status
  if (status === "waiting" || status === "waiting_for_user" || status === "completed" || status === "failed") {
    return { status, result: value.result ?? value.output, failureReason: typeof value.failureReason === "string" ? value.failureReason : undefined }
  }
  if (status === "success" || value.ok === true) return { status: "completed", result: value.result ?? value.output ?? value, }
  if (status === "error" || value.ok === false) return { status: "failed", failureReason: typeof value.error === "string" ? value.error : "Legacy subagent failed", result: value.result }
  return { status: "completed", result: { legacy: true, value } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
