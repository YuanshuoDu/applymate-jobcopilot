import { describe, expect, it } from "vitest"

import { AgentTreeManager, type SubagentClock } from "./manager.js"
import {
  type SubagentExecutionResult,
  type SubagentJobPayload,
  type SubagentPolicy,
  type SubagentStore,
  type SubagentTaskRecord,
  type SubagentTaskSpec,
} from "./types.js"

class FakeClock implements SubagentClock {
  setInterval(): ReturnType<typeof setInterval> { return {} as ReturnType<typeof setInterval> }
  clearInterval(): void {}
}

class MemoryStore implements SubagentStore {
  readonly records = new Map<string, SubagentTaskRecord>()
  private nextId = 1

  async create(input: SubagentTaskSpec & { policy: SubagentPolicy }): Promise<SubagentTaskRecord> {
    const id = `task-${this.nextId++}`
    const parent = input.parentTaskId ? this.records.get(input.parentTaskId) : undefined
    const task: SubagentTaskRecord = {
      id, userId: input.userId, sessionId: input.sessionId, turnId: input.turnId ?? null,
      rootTaskId: parent?.rootTaskId ?? id, parentTaskId: input.parentTaskId ?? null,
      path: `${parent?.path ?? ""}/${id}`, depth: parent ? parent.depth + 1 : 0,
      role: input.role, taskType: input.taskType, status: "queued", goal: input.goal,
      constraints: input.constraints ?? [], successCriteria: input.successCriteria ?? [],
      allowedActions: input.allowedActions ?? [], context: input.context ?? {}, expectedOutputSchema: input.expectedOutputSchema ?? {},
      result: null, failureReason: null, attemptCount: 0, maxAttempts: input.policy.maxAttempts,
      leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null,
      budgetSnapshot: { subagentPolicy: input.policy }, toolPolicySnapshot: input.toolPolicySnapshot ?? {},
    }
    this.records.set(id, task)
    return task
  }

  async get(taskId: string): Promise<SubagentTaskRecord | null> { return this.records.get(taskId) ?? null }

  async claim(input: { taskId: string; sessionId: string; ownerId: string; policy: SubagentPolicy; now: Date }): Promise<SubagentTaskRecord | null> {
    const task = this.records.get(input.taskId)
    const running = [...this.records.values()].filter(row => row.sessionId === input.sessionId && row.status === "running").length
    if (!task || task.sessionId !== input.sessionId || task.status !== "queued" || running >= input.policy.maxConcurrency) return null
    const claimed = { ...task, status: "running" as const, leaseOwner: input.ownerId, leaseExpiresAt: new Date(input.now.getTime() + 60_000), attemptCount: task.attemptCount + 1 }
    this.records.set(task.id, claimed)
    return claimed
  }

  async heartbeat(input: { taskId: string; sessionId: string; ownerId: string; now: Date }): Promise<"renewed" | "interrupted" | "lost"> {
    const task = this.records.get(input.taskId)
    if (!task || task.sessionId !== input.sessionId || task.leaseOwner !== input.ownerId || task.status !== "running") return "lost"
    if (task.interruptRequestedAt) return "interrupted"
    this.records.set(task.id, { ...task, leaseExpiresAt: new Date(input.now.getTime() + 60_000) })
    return "renewed"
  }

  async finish(input: { taskId: string; sessionId: string; ownerId: string; status: SubagentExecutionResult["status"]; result?: unknown; failureReason?: string; now: Date }): Promise<"completed" | "retrying" | "failed" | "waiting" | "waiting_for_user" | "interrupted" | null> {
    const task = this.records.get(input.taskId)
    if (!task || task.sessionId !== input.sessionId || task.leaseOwner !== input.ownerId || task.status !== "running") return null
    const interrupted = task.interruptRequestedAt !== null
    const retry = input.status === "failed" && !interrupted && task.attemptCount < task.maxAttempts
    const status = interrupted ? "interrupted" : retry ? "queued" : input.status
    this.records.set(task.id, { ...task, status, result: input.result ?? null, failureReason: input.failureReason ?? null, leaseOwner: null, leaseExpiresAt: null })
    if (interrupted) return "interrupted"
    if (retry) return "retrying"
    return status as "completed" | "waiting" | "waiting_for_user" | "failed"
  }

  async close(input: { taskId: string; sessionId: string; now: Date }): Promise<boolean> {
    const task = this.records.get(input.taskId)
    if (!task || task.sessionId !== input.sessionId || ["completed", "failed", "interrupted", "cancelled", "closed"].includes(task.status)) return false
    this.records.set(task.id, { ...task, status: "closed", leaseOwner: null, leaseExpiresAt: null })
    return true
  }

  async interruptTree(input: { sessionId: string; rootTaskId: string; now: Date }): Promise<number> {
    let count = 0
    for (const task of this.records.values()) {
      if (task.sessionId !== input.sessionId || task.rootTaskId !== input.rootTaskId || ["completed", "failed", "interrupted", "cancelled", "closed"].includes(task.status)) continue
      count += 1
      this.records.set(task.id, { ...task, interruptRequestedAt: input.now, status: task.status === "queued" ? "interrupted" : task.status })
    }
    return count
  }

  async recoverExpired(): Promise<SubagentTaskRecord[]> { return [] }
}

function spec(overrides: Partial<SubagentTaskSpec> = {}): SubagentTaskSpec {
  return { userId: "user-1", sessionId: "session-1", role: "scout", taskType: "test", goal: "inspect", ...overrides }
}

function payload(task: SubagentTaskRecord, ownerId = "worker-1"): SubagentJobPayload {
  return { taskId: task.id, sessionId: task.sessionId, rootTaskId: task.rootTaskId, ownerId }
}

describe("AgentTreeManager", () => {
  it("creates a task tree and inherits the parent's restrictive policy", async () => {
    const store = new MemoryStore()
    const manager = new AgentTreeManager(store, { clock: new FakeClock() })
    const parent = await manager.spawn(spec({ policy: { maxDepth: 2, maxFanOut: 2, maxConcurrency: 1, maxAttempts: 1 } }))
    const child = await manager.spawn(spec({ parentTaskId: parent.id, policy: { maxDepth: 8, maxFanOut: 8, maxConcurrency: 8, maxAttempts: 8 } }))
    expect(child.rootTaskId).toBe(parent.id)
    expect(child.depth).toBe(1)
    expect((child.budgetSnapshot as { subagentPolicy: SubagentPolicy }).subagentPolicy).toEqual({ maxDepth: 2, maxFanOut: 2, maxConcurrency: 1, maxAttempts: 1 })
  })

  it("releases the session slot on completion and retries a failed task", async () => {
    const store = new MemoryStore()
    const manager = new AgentTreeManager(store, { clock: new FakeClock() })
    const task = await manager.spawn(spec({ policy: { maxAttempts: 2 } }))
    const first = await manager.run(payload(task), async () => ({ status: "failed", failureReason: "transient" }))
    expect(first.status).toBe("retrying")
    expect(manager.activeCount(task.sessionId)).toBe(0)
    const second = await manager.run(payload(task, "worker-2"), async () => ({ status: "completed", result: { ok: true } }))
    expect(second.status).toBe("completed")
    expect(manager.activeCount(task.sessionId)).toBe(0)
    expect(store.records.get(task.id)?.status).toBe("completed")
  })

  it("propagates root interrupt to in-flight work and leaves no slot leak", async () => {
    const store = new MemoryStore()
    const manager = new AgentTreeManager(store, { clock: new FakeClock() })
    const task = await manager.spawn(spec())
    const running = manager.run(payload(task), async ({ lease }) => new Promise<SubagentExecutionResult>(resolve => {
      lease.signal.addEventListener("abort", () => resolve({ status: "failed" }), { once: true })
    }))
    await new Promise(resolve => setTimeout(resolve, 0))
    await expect(manager.interrupt(task.sessionId, task.rootTaskId)).resolves.toBe(1)
    await expect(running).resolves.toMatchObject({ status: "interrupted" })
    expect(manager.activeCount(task.sessionId)).toBe(0)
  })

  it("closes queued work without executing it", async () => {
    const store = new MemoryStore()
    const manager = new AgentTreeManager(store, { clock: new FakeClock() })
    const task = await manager.spawn(spec())
    await expect(manager.close(task.id, task.sessionId)).resolves.toBe(true)
    await expect(manager.run(payload(task), async () => ({ status: "completed" }))).resolves.toMatchObject({ status: "skipped" })
    expect(store.records.get(task.id)?.status).toBe("closed")
  })
})
