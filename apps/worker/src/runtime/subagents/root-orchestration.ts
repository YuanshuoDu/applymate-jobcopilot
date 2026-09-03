import type { DurableWaitPort } from "../tools/coordination-types.js"
import { AgentTreeManager } from "./manager.js"
import { roleContract, type MigratedRole } from "./role-contracts.js"
import type { SubagentTaskRecord, SubagentTaskSpec } from "./types.js"

export type RootRoleSpawnInput = {
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
  readonly parentTaskId: string
  readonly rootTaskId?: string | null
  readonly scoutGoal: string
  readonly analystGoal: string
  readonly context?: unknown
}

export type RootTaskDispatcher = (task: SubagentTaskRecord) => Promise<void>

export type ScoutAnalystSpawnResult = {
  readonly tasks: readonly [SubagentTaskRecord, SubagentTaskRecord]
  readonly wait: {
    readonly waitId: string
    readonly status: "waiting" | "ready" | "timed_out" | "interrupted" | "closed"
    readonly deadlineAt: string
    readonly matchedTaskIds: readonly string[]
  }
}

/** Spawns and dispatches both read-only roles concurrently before durable wait. */
export async function spawnScoutAnalystAndWait(
  manager: AgentTreeManager,
  waitPort: DurableWaitPort,
  input: RootRoleSpawnInput,
  dispatch: RootTaskDispatcher,
  options: { readonly stepId: string; readonly timeoutMs: number; readonly idempotencyKey: string },
): Promise<ScoutAnalystSpawnResult> {
  if (!input.parentTaskId.trim()) throw new Error("Root orchestration requires the runtime-owned parent task")
  const [scout, analyst] = await Promise.all([
    manager.spawn(roleSpec(input, "scout", input.scoutGoal)),
    manager.spawn(roleSpec(input, "analyst", input.analystGoal)),
  ])
  if (scout.rootTaskId !== analyst.rootTaskId) throw new Error("Scout and Analyst must share one root task")
  await Promise.all([dispatch(scout), dispatch(analyst)])
  const wait = await waitPort.wait({
    userId: input.userId, sessionId: input.sessionId, turnId: input.turnId, stepId: options.stepId,
    taskId: input.parentTaskId, rootTaskId: scout.rootTaskId,
    targetTaskIds: [scout.id, analyst.id], mode: "all", timeoutMs: options.timeoutMs, idempotencyKey: options.idempotencyKey,
  })
  return { tasks: [scout, analyst], wait }
}

function roleSpec(input: RootRoleSpawnInput, role: MigratedRole, goal: string): SubagentTaskSpec {
  const contract = roleContract(role)
  return {
    userId: input.userId, sessionId: input.sessionId, turnId: input.turnId, parentTaskId: input.parentTaskId,
    role, taskType: `${role}.read`, goal, context: input.context,
    allowedActions: contract.allowedTools, toolPolicySnapshot: { role, allowedTools: contract.allowedTools, capabilities: contract.capabilities },
    successCriteria: ["Return structured result with real IDs and evidence", "Do not perform drafts, submissions, browser actions, or external writes"],
  }
}
