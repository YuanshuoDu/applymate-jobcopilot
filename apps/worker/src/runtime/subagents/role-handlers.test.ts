import { describe, expect, it, vi } from "vitest"

import { createRoleQueueHandler, createRoleToolInvoker, type RoleToolCall } from "./role-handlers.js"
import type { AgentTreeManager } from "./manager.js"
import type { SubagentJobPayload, SubagentLease } from "./types.js"

function lease(role: string): SubagentLease {
  return { id: "task-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/task-1", depth: 1, role, taskType: "read", status: "running", goal: "read", constraints: [], successCriteria: [], allowedActions: [], context: {}, expectedOutputSchema: {}, result: null, failureReason: null, attemptCount: 1, maxAttempts: 3, leaseOwner: "worker-1", leaseExpiresAt: new Date(), interruptRequestedAt: null, budgetSnapshot: {}, toolPolicySnapshot: {}, ownerId: "worker-1", signal: new AbortController().signal }
}
const payload: SubagentJobPayload = { taskId: "task-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "worker-1" }
const validResult = { schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "completed", candidates: [], evidence: [], summary: "none" }

describe("migrated subagent queue handlers", () => {
  it("claims through the manager and validates structured role output", async () => {
    const run = vi.fn(async (_payload: SubagentJobPayload, execute: (input: { lease: SubagentLease }) => Promise<unknown>) => execute({ lease: lease("scout") }).then(() => ({ taskId: "task-1", status: "completed" as const })))
    const manager = { run } as unknown as AgentTreeManager
    const handler = createRoleQueueHandler(manager, "scout", async ({ contract }) => { expect(contract.allowedTools).toContain("jobs.search"); return validResult }, async () => undefined)
    await expect(handler(payload)).resolves.toMatchObject({ taskId: "task-1", status: "completed" })
    expect(run).toHaveBeenCalledOnce()
  })

  it("rejects a queue role mismatch before role work runs", async () => {
    const run = vi.fn(async (_payload: SubagentJobPayload, execute: (input: { lease: SubagentLease }) => Promise<unknown>) => execute({ lease: lease("analyst") }).then(() => ({ taskId: "task-1", status: "completed" as const })))
    const work = vi.fn(async () => validResult)
    const handler = createRoleQueueHandler({ run } as unknown as AgentTreeManager, "scout", work, async () => undefined)
    await expect(handler(payload)).rejects.toThrow(/role mismatch/)
    expect(work).not.toHaveBeenCalled()
  })

  it("enforces role allowlists at the tool invocation boundary", async () => {
    const downstream = vi.fn(async () => ({ ok: true }))
    const guarded = createRoleToolInvoker("analyst", downstream)
    const allowed: RoleToolCall = { name: "jobs.get", risk: "read", capabilities: ["read"], input: { jobId: "job-1" }, signal: new AbortController().signal }
    await expect(guarded(allowed)).resolves.toEqual({ ok: true })
    await expect(guarded({ ...allowed, name: "application.submit", risk: "external_write", capabilities: ["external_write"] })).rejects.toThrow()
    expect(downstream).toHaveBeenCalledOnce()
  })
})
