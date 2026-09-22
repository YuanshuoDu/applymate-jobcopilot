import type { PlanCommandExecutionRuntime } from "./plan-command-executor.js"
import type { PlanDispatchCommand } from "./plan-intent-dispatcher.js"

export function graphReady(runtime: PlanCommandExecutionRuntime, command: PlanDispatchCommand): boolean {
  const state = runtime.taskGraphAdapter?.state
  if (!state) return false
  const status = state.statuses[command.localId]
  return state.readyNodeIds.includes(command.localId) || status === "completed" || status === "failed" || status === "cancelled" || status === "waiting"
}
