import { TurnEngineError } from "./turn-engine-types.js"
import { isDurableWaitId, prepareDurableWaitOutput } from "../tools/redaction.js"
import { isCanonicalRawSubagentWaitId } from "../subagents/subagent-wait-structural-ids.js"
import type { TurnExecutionIdentity } from "./turn-execution-types.js"

type DependencyWaitReceipt = { readonly waitId: string; readonly deadlineAt: string; readonly matchedTaskIds: readonly string[] }

export function dependencyWaitReceipt(value: unknown, toolName: string, ownerKind: TurnExecutionIdentity["kind"]): DependencyWaitReceipt | null {
  if (toolName !== "agent.wait" && toolName !== "wait_subagents") return null
  let safeValue: unknown
  try { safeValue = prepareDurableWaitOutput(value, toolName, ownerKind).safe }
  catch { throw new TurnEngineError("invalid_output", "Durable wait receipt is invalid") }
  if (!safeValue || typeof safeValue !== "object" || Array.isArray(safeValue)) throw new TurnEngineError("invalid_output", "Durable wait receipt is invalid")
  const record = safeValue as Record<string, unknown>
  if (record.status !== "waiting") return null
  const waitId = record.waitId
  if (!validWaitIdForOwner(toolName, waitId, ownerKind) || typeof record.deadlineAt !== "string" || !record.deadlineAt.trim()
    || !Array.isArray(record.matchedTaskIds) || !record.matchedTaskIds.every(item => typeof item === "string" && item.trim().length > 0)) {
    throw new TurnEngineError("invalid_output", "Durable wait receipt is invalid")
  }
  return { waitId, deadlineAt: record.deadlineAt, matchedTaskIds: record.matchedTaskIds }
}

function validWaitIdForOwner(toolName: string, value: unknown, ownerKind: TurnExecutionIdentity["kind"]): value is string {
  if (ownerKind === "turn") return (toolName === "agent.wait" || toolName === "wait_subagents") && isDurableWaitId(value)
  return ownerKind === "task" && toolName === "wait_subagents" && isCanonicalRawSubagentWaitId(value)
}
