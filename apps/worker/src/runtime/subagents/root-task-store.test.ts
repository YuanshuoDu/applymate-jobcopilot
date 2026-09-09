import { describe, expect, it, vi } from "vitest"

import { createPgRootTaskStore } from "./root-task-store.js"

const lease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 3,
  leaseStartedAt: new Date("2026-09-07T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-07T00:01:00.000Z"),
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "root-turn-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-turn-1", parentTaskId: null,
    path: "/root-turn-1", depth: 0, role: "orchestrator", taskType: "root", status: "waiting", goal: "Find jobs",
    constraints: [], successCriteria: [], allowedActions: ["jobs.search"], context: {}, expectedOutputSchema: {}, result: null,
    failureReason: null, attemptCount: 1, maxAttempts: 1, leaseOwner: "old-worker", leaseExpiresAt: new Date("2026-09-06T23:59:00.000Z"),
    interruptRequestedAt: null, budgetSnapshot: { limits: { maxSteps: 2 } }, toolPolicySnapshot: { role: "orchestrator" }, ...overrides,
  }
}

function fakePool(existing: Record<string, unknown> | null = null, updateCount = 1) {
  const calls: string[] = []
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push(sql)
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_turns"') && sql.includes('"rootTaskId"')) return { rows: [{ rootTaskId: existing?.id ? "root-turn-1" : null }], rowCount: 1 }
      if (sql.includes("INSERT INTO \"sub_agent_tasks\"")) return { rows: [], rowCount: 1 }
      if (sql.includes('UPDATE "agent_turns"')) return { rows: [], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [existing ?? row()], rowCount: 1 }
      if (sql.includes('SELECT "id" FROM "agent_turns"')) return { rows: [{ id: "turn-1" }], rowCount: 1 }
      if (sql.includes('UPDATE "sub_agent_tasks"')) return { rows: [], rowCount: updateCount }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn(async () => client) } as never, calls, client }
}

describe("createPgRootTaskStore", () => {
  it("creates a scoped root with explicit allowed actions and keeps secrets out", async () => {
    const fake = fakePool()
    const root = await createPgRootTaskStore(fake.pool).ensure({
      lease, goal: "Find jobs", allowedActions: ["jobs.search"], modelProfileSnapshot: { provider: "fixture", model: "fixture" },
      toolPolicySnapshot: { role: "orchestrator" }, budgetSnapshot: { limits: { maxSteps: 2 } },
    })
    expect(root).toMatchObject({ id: "root-turn-1", status: "waiting" })
    const insert = fake.client.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO \"sub_agent_tasks\""))
    expect(insert?.[1]).not.toContain(expect.objectContaining({ apiKey: expect.anything() }))
    expect(insert?.[1]).toContain(JSON.stringify(["jobs.search"]))
  })

  it("rebinds a stale waiting root before resume", async () => {
    const fake = fakePool(row())
    await createPgRootTaskStore(fake.pool).ensure({ lease, goal: "Find jobs", allowedActions: ["jobs.search", "jobs.get"] })
    const update = fake.client.query.mock.calls.find(([sql]) => sql.includes("SET \"status\" = 'running'"))
    expect(update?.[1]).toContain("worker-1")
    expect(update?.[1]).toContain(JSON.stringify(["jobs.search", "jobs.get"]))
  })

  it("rejects a secret bearing snapshot", async () => {
    const fake = fakePool()
    await expect(createPgRootTaskStore(fake.pool).ensure({ lease, goal: "Find jobs", toolPolicySnapshot: { apiKey: "secret" } })).rejects.toThrow("tool_policy_contains_secret")
  })

  it("requires the current turn fence while finishing", async () => {
    const fake = fakePool()
    await createPgRootTaskStore(fake.pool).finish({ lease, rootTaskId: "root-turn-1", result: { status: "completed", stepCount: 1, toolCallCount: 0 } })
    expect(fake.calls.some(sql => sql.includes('"leaseVersion" = $5') && sql.includes('"leaseExpiresAt" > CURRENT_TIMESTAMP'))).toBe(true)
    const taskUpdate = fake.calls.find(sql => sql.includes('UPDATE "sub_agent_tasks" SET'))
    expect(taskUpdate).toContain('"attemptCount" = 1')
    expect(taskUpdate).not.toContain('"leaseExpiresAt" > CURRENT_TIMESTAMP')
  })

  it("finishes when copied root-task expiry is stale but the Turn lease is current", async () => {
    const fake = fakePool(row({ leaseExpiresAt: new Date("2026-09-07T00:00:30.000Z") }))
    await createPgRootTaskStore(fake.pool).finish({ lease, rootTaskId: "root-turn-1", result: { status: "completed", stepCount: 1, toolCallCount: 0 }, now: new Date("2026-09-07T00:02:00.000Z") })
    const taskUpdate = fake.calls.find(sql => sql.includes('UPDATE "sub_agent_tasks" SET'))
    expect(taskUpdate).toBeDefined()
    expect(taskUpdate).not.toContain('"leaseExpiresAt" > CURRENT_TIMESTAMP')
  })

  it("rejects a stale or expired actual Turn owner before root settlement", async () => {
    const calls: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql)
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
        if (sql.includes('SELECT "id" FROM "agent_turns"')) return { rows: [], rowCount: 0 }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn(async () => client) } as never
    await expect(createPgRootTaskStore(pool).finish({ lease, rootTaskId: "root-turn-1", result: { status: "completed", stepCount: 1, toolCallCount: 0 } })).rejects.toThrow("root_turn_fenced")
    expect(calls.some(sql => sql.includes('UPDATE "sub_agent_tasks"'))).toBe(false)
  })

  it("does not rebind a terminal root task", async () => {
    const fake = fakePool(row({ status: "completed" }), 0)
    await expect(createPgRootTaskStore(fake.pool).ensure({ lease, goal: "Find jobs" })).rejects.toThrow("root_task_terminal")
  })

  it("releases the root lease when a turn enters a wait state", async () => {
    const fake = fakePool()
    await createPgRootTaskStore(fake.pool).finish({ lease, rootTaskId: "root-turn-1", result: { status: "waiting_for_dependency", stepCount: 1, toolCallCount: 0 } })
    expect(fake.calls.some(sql => sql.includes('"leaseOwner" = NULL') && sql.includes('"leaseExpiresAt" = NULL'))).toBe(true)
  })
})
