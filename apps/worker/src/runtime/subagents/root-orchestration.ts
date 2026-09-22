import type { DurableWaitPort } from "../tools/coordination-types.js"
import { AgentTreeManager } from "./manager.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { roleContract, type MigratedRole } from "./scout-analyst-contracts.js"
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

/** Spawns both read-only roles concurrently and waits for their durable results. */
export async function spawnScoutAnalystAndWait(
  manager: AgentTreeManager,
  waitPort: DurableWaitPort,
  input: RootRoleSpawnInput,
  dispatch: RootTaskDispatcher,
  options: { readonly stepId: string; readonly timeoutMs: number; readonly idempotencyKey: string },
): Promise<ScoutAnalystSpawnResult> {
  if (!input.parentTaskId.trim()) throw new Error("Root orchestration requires the runtime-owned parent task")
  const atomic = typeof manager.supportsAtomicSpawn === "function" && manager.supportsAtomicSpawn()
  const spawned = await Promise.allSettled([
    spawnRole(manager, input, "scout", input.scoutGoal, atomic, options.idempotencyKey),
    spawnRole(manager, input, "analyst", input.analystGoal, atomic, options.idempotencyKey),
  ])
  const created = spawned.flatMap(result => result.status === "fulfilled" && result.value.created ? [result.value.task] : [])
  const spawnError = spawned.find(result => result.status === "rejected")
  if (spawnError) return failAfterCleanup(manager, input, created, spawnError.reason)
  const [scout, analyst] = spawned.map(result => (result as PromiseFulfilledResult<SpawnedRole>).value.task) as [SubagentTaskRecord, SubagentTaskRecord]
  try {
    if (scout.rootTaskId !== analyst.rootTaskId) throw new Error("Scout and Analyst must share one root task")
    if (!atomic) {
      const dispatched = await Promise.allSettled([dispatch(scout), dispatch(analyst)])
      const dispatchError = dispatched.find(result => result.status === "rejected")
      if (dispatchError) return failAfterCleanup(manager, input, created, dispatchError.reason)
    }
    const wait = await waitPort.wait({
      userId: input.userId, sessionId: input.sessionId, turnId: input.turnId, stepId: options.stepId,
      taskId: input.parentTaskId, rootTaskId: scout.rootTaskId,
      targetTaskIds: [scout.id, analyst.id], mode: "all", timeoutMs: options.timeoutMs, idempotencyKey: options.idempotencyKey,
    })
    return { tasks: [scout, analyst], wait }
  } catch (error: unknown) {
    return failAfterCleanup(manager, input, created, error)
  }
}

type SpawnedRole = { readonly task: SubagentTaskRecord; readonly created: boolean }

async function failAfterCleanup(manager: AgentTreeManager, input: RootRoleSpawnInput, created: readonly SubagentTaskRecord[], error: unknown): Promise<never> {
  await Promise.allSettled(created.map(child => manager.interruptSubtree(input.sessionId, child.rootTaskId, child.path)))
  throw error
}

async function spawnRole(
  manager: AgentTreeManager,
  input: RootRoleSpawnInput,
  role: MigratedRole,
  goal: string,
  atomic: boolean,
  idempotencyKey: string,
): Promise<SpawnedRole> {
  const spec = roleSpec(input, role, goal)
  if (!atomic) return { task: await manager.spawn(spec), created: true }
  const result = await manager.spawnAtomic(spec, `${idempotencyKey}:${role}`)
  if (!result.task) throw new Error(`Atomic ${role} spawn did not return a task`)
  return { task: result.task, created: !result.duplicate }
}

function roleSpec(input: RootRoleSpawnInput, role: MigratedRole, goal: string): SubagentTaskSpec {
  const contract = roleContract(role)
  return {
    userId: input.userId, sessionId: input.sessionId, turnId: input.turnId, parentTaskId: input.parentTaskId,
    role, taskType: `${role}.read`, goal, context: input.context,
    allowedActions: contract.allowedTools, toolPolicySnapshot: { role, allowedTools: contract.allowedTools, capabilities: contract.capabilities },
    expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role },
    successCriteria: ["Return structured result with real IDs and evidence", "Do not perform drafts, submissions, browser actions, or external writes"],
  }
}
