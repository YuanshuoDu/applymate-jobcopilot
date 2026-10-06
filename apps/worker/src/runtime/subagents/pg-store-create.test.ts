import { describe, expect, it, vi } from "vitest"

import { createSubagentTask } from "./pg-store-create.js"
import { normalizeSubagentPolicy } from "./types.js"
import type { Queryable } from "./pg-store-persistence.js"

describe("pg-store task creation helpers", () => {
  it("inherits parent route and action bounds without relocking an already locked session", async () => {
    const calls: Array<[string, unknown[]?]> = []
    const parent = {
      id: "parent-1", rootTaskId: "root-1", path: "/root-1/parent-1", depth: 1, status: "running",
      allowedActions: ["jobs.search"], modelProfileSnapshot: { provider: "fixture", model: "parent" },
      budgetSnapshot: {}, toolPolicySnapshot: { tools: ["jobs"] },
    }
    const row = {
      id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "parent-1",
      path: "/root-1/parent-1/child-1", depth: 2, role: "analyst", taskType: "research", status: "queued", goal: "inspect",
      constraints: [], successCriteria: [], allowedActions: ["jobs.search"], context: {}, expectedOutputSchema: {}, result: null,
      failureReason: null, attemptCount: 0, maxAttempts: 3, nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null,
      interruptRequestedAt: null, modelProfileSnapshot: parent.modelProfileSnapshot, budgetSnapshot: {}, toolPolicySnapshot: parent.toolPolicySnapshot,
    }
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push([sql, params])
        if (sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE")) return { rows: [{ id: "turn-1" }], rowCount: 1 }
        if (sql.includes('SELECT session."id" FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
        if (sql.includes('SELECT "rootTaskId", "turnId"')) return { rows: [{ rootTaskId: "root-1", turnId: "turn-1" }], rowCount: 1 }
        if (sql.includes('FROM "sub_agent_tasks" AS root')) return { rows: [{ id: "root-1", turnId: "turn-1", status: "running", interruptRequestedAt: null }], rowCount: 1 }
        if (sql.includes('FROM "sub_agent_tasks"') && sql.includes('FOR UPDATE')) return { rows: [parent], rowCount: 1 }
        if (sql.includes("COUNT(*)")) return { rows: [{ count: 0 }], rowCount: 1 }
        if (sql.startsWith('INSERT INTO "sub_agent_tasks"')) return { rows: [{ id: "child-1" }], rowCount: 1 }
        if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [row], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }),
    } as unknown as Queryable

    const created = await createSubagentTask(client, {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "parent-1",
      role: "analyst", taskType: "research", goal: "inspect", allowedActions: [],
      modelProfileSnapshot: { provider: "fixture", model: "override" }, policy: normalizeSubagentPolicy(),
    }, true)

    expect(created).toMatchObject({ id: "child-1", rootTaskId: "root-1", depth: 2, status: "queued" })
    expect(calls.some(([sql]) => sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE"))).toBe(false)
    const parentIndex = calls.findIndex(([sql]) => sql.includes('FROM "sub_agent_tasks" WHERE') && sql.includes("FOR UPDATE"))
    const rootIndex = calls.findIndex(([sql]) => sql.includes('FROM "sub_agent_tasks" AS root'))
    const insertIndex = calls.findIndex(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))
    expect(parentIndex).toBeGreaterThanOrEqual(0)
    expect(rootIndex).toBeLessThan(parentIndex)
    expect(parentIndex).toBeLessThan(insertIndex)
    expect(calls[insertIndex]?.[1]).toEqual(expect.arrayContaining([
      JSON.stringify(["jobs.search"]), JSON.stringify(parent.modelProfileSnapshot), JSON.stringify(parent.toolPolicySnapshot),
      JSON.stringify({ subagentPolicy: normalizeSubagentPolicy() }),
    ]))
  })

  it("rejects child creation when the locked root has an interrupt request", async () => {
    const calls: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql)
        if (sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE")) return { rows: [{ id: "turn-1" }], rowCount: 1 }
        if (sql.includes('SELECT session."id" FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
        if (sql.includes('SELECT "rootTaskId", "turnId"')) return { rows: [{ rootTaskId: "root-1", turnId: "turn-1" }], rowCount: 1 }
        if (sql.includes('FROM "sub_agent_tasks" AS root')) return { rows: [{ id: "root-1", turnId: "turn-1", status: "running", interruptRequestedAt: new Date() }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }),
    } as unknown as Queryable
    await expect(createSubagentTask(client, {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "parent-1",
      role: "analyst", taskType: "research", goal: "inspect", policy: normalizeSubagentPolicy(),
    }, true)).rejects.toThrow("Root task is unavailable")
    expect(calls.some(sql => sql.includes("FOR UPDATE") && sql.includes('FROM "sub_agent_tasks" WHERE'))).toBe(false)
    expect(calls.some(sql => sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
  })
})
