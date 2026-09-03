import type { SubagentJobPayload, SubagentLease, SubagentExecutionResult } from "./types.js"
import { AgentTreeManager, type SubagentRunOutcome } from "./manager.js"
import { assertMigratedRole, assertRoleActionAllowed, roleContract, type MigratedRole, type RoleContract } from "./scout-analyst-contracts.js"
import { validateRoleResult, type StructuredRoleResult } from "./role-results.js"

export type RoleWorkInput = {
  readonly lease: SubagentLease
  readonly contract: RoleContract
  readonly invoke: RoleToolInvoker
}

export type RoleToolCall = {
  readonly name: string
  readonly risk: import("@jobcopilot/agent-protocol").ToolRisk
  readonly capabilities: readonly import("@jobcopilot/agent-protocol").ToolCapability[]
  readonly input: unknown
  readonly signal: AbortSignal
}

export type RoleToolInvoker = (call: RoleToolCall) => Promise<unknown>

export type RoleWork = {
  readonly scout: (input: RoleWorkInput) => Promise<unknown>
  readonly analyst: (input: RoleWorkInput) => Promise<unknown>
}

export type RoleQueueHandler = (payload: SubagentJobPayload) => Promise<SubagentRunOutcome>

export type MigratedRoleQueueHandlers = Readonly<Record<MigratedRole, RoleQueueHandler>>

/**
 * Queue boundary for migrated read-only roles. The worker claims/fences the
 * lease here; business work is injected so the model/tool runtime stays out
 * of the durable subagent state machine.
 */
export function createRoleQueueHandlers(manager: AgentTreeManager, work: RoleWork, invoke: RoleToolInvoker): MigratedRoleQueueHandlers {
  return {
    scout: createRoleQueueHandler(manager, "scout", work.scout, invoke),
    analyst: createRoleQueueHandler(manager, "analyst", work.analyst, invoke),
  }
}

export function createRoleQueueHandler(manager: AgentTreeManager, role: MigratedRole, execute: (input: RoleWorkInput) => Promise<unknown>, invoke: RoleToolInvoker): RoleQueueHandler {
  return payload => manager.run(payload, async ({ lease }): Promise<SubagentExecutionResult> => {
    if (lease.role !== role) throw new Error(`Queue payload role mismatch: expected ${role}, got ${lease.role}`)
    const result = validateRoleResult(await execute({ lease, contract: roleContract(role), invoke: createRoleToolInvoker(role, invoke) }), role)
    return { status: "completed", result }
  })
}

export function createRoleToolInvoker(role: MigratedRole, invoke: RoleToolInvoker): RoleToolInvoker {
  return async call => { assertRoleActionAllowed(role, call); return invoke(call) }
}

export function assertRolePayload(payload: SubagentJobPayload, expectedRole: MigratedRole, taskRole: string): void {
  assertMigratedRole(taskRole)
  if (taskRole !== expectedRole) throw new Error(`Queue payload role mismatch: expected ${expectedRole}, got ${taskRole}`)
  if (payload.taskId.trim().length === 0 || payload.sessionId.trim().length === 0) throw new Error("Queue payload must include task and session ids")
}

export function isStructuredRoleResult(value: unknown, role: MigratedRole): value is StructuredRoleResult {
  try { validateRoleResult(value, role); return true } catch { return false }
}
