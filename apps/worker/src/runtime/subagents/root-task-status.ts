import type { TurnEngineResult } from "../turns/turn-engine-types.js"
import type { SubagentTaskStatus } from "./types.js"

export function rootTaskStatusFromTurnResult(result: TurnEngineResult): Extract<SubagentTaskStatus, "completed" | "failed" | "interrupted" | "waiting" | "waiting_for_user"> {
  if (result.status === "completed") return "completed"
  if (result.status === "interrupted") return "interrupted"
  if (result.status === "waiting_for_user" || result.status === "waiting_for_approval") return "waiting_for_user"
  if (result.status === "waiting_for_dependency") return "waiting"
  return "failed"
}
