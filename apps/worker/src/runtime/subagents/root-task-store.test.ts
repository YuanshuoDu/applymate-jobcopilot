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

function fakePool(existing: Record<string, unknown> | null = null, updateCount = 1, sessionStatus = "running", sessionUserId = "user-1") {
  const calls: string[] = []
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push(sql)
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_sessions"')) return sessionStatus === "missing" || ["aborted", "archived"].includes(sessionStatus) || sessionUserId !== "user-1" ? { rows: [], rowCount: 0 } : { rows: [{ id: "session-1" }], rowCount: 1 }
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

function completionPool(descendants: Array<Record<string, unknown>>, owned = true, hasTaskGraphProposal = false) {
  const calls: string[] = []
  const client = {
    query: vi.fn(async (sql: string) => {
      calls.push(sql)
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
      if (sql.includes('SELECT "id", "rootTaskId" FROM "agent_turns"')) return owned ? { rows: [{ id: "turn-1", rootTaskId: "root-turn-1" }], rowCount: 1 } : { rows: [], rowCount: 0 }
      if (sql.includes('SELECT task."id", task."status"')) return { rows: descendants, rowCount: descendants.length }
      if (sql.includes('SELECT 1 FROM "agent_events" AS event') && sql.includes("'proposal'")) {
        return hasTaskGraphProposal ? { rows: [{}], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn(async () => client) } as never, calls, client }
}

function terminalPool(root: Record<string, unknown> | null) {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values })
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes('task."id" = task."rootTaskId"')) return { rows: root ? [root] : [], rowCount: root ? 1 : 0 }
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
    expect(fake.calls.findIndex(sql => sql.includes('FROM "agent_sessions"'))).toBeLessThan(fake.calls.findIndex(sql => sql.includes('FROM "agent_turns"')))
  })

  it.each(["running", "paused", "waiting_for_user"])("keeps %s sessions compatible with root admission", async (sessionStatus) => {
    await expect(createPgRootTaskStore(fakePool(null, 1, sessionStatus).pool).ensure({ lease, goal: "Find jobs" })).resolves.toBeDefined()
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
    const serialized = fake.client.query.mock.calls.find(([sql]) => sql.includes('UPDATE "sub_agent_tasks" SET'))?.[1]?.[1]
    expect(serialized).toBe(JSON.stringify({ status: "completed", stepCount: 1, toolCallCount: 0, finalItemId: null, waitId: null }))
  })

  it("atomically persists only a bounded validated discovery shortlist under structuredResult", async () => {
    const fake = fakePool()
    const shortlist = { schemaVersion: 1 as const, status: "partial" as const, items: [{ jobId: "job-1", score: 8.5, evidenceIds: ["read:job:job-1"] }], failures: ["scout_result_partial" as const] }
    await createPgRootTaskStore(fake.pool).finish({
      lease, rootTaskId: "root-turn-1", result: { status: "completed", stepCount: 2, toolCallCount: 1 },
      metadata: { interactiveDiscoveryShortlist: shortlist },
    })
    const update = fake.client.query.mock.calls.find(([sql]) => sql.includes('UPDATE "sub_agent_tasks" SET'))
    const saved = JSON.parse(String(update?.[1]?.[1])) as unknown
    expect(saved).toEqual({
      status: "completed", stepCount: 2, toolCallCount: 1, finalItemId: null, waitId: null,
      structuredResult: { interactiveDiscoveryShortlist: shortlist },
    })
  })

  it.each([
    { schemaVersion: 1, status: "completed", items: [], failures: [] },
    { schemaVersion: 1, status: "failed", items: [{ jobId: "job-1", score: 8, evidenceIds: ["read:job:job-1"] }], failures: ["no_common_candidates"] },
    { schemaVersion: 1, status: "completed", items: [{ jobId: "job-1", score: 8, evidenceIds: ["read:job:job-1"], url: "https://model.test" }], failures: [] },
  ])("rejects invalid or model-shaped discovery metadata before root settlement", async shortlist => {
    const fake = fakePool()
    await expect(createPgRootTaskStore(fake.pool).finish({
      lease, rootTaskId: "root-turn-1", result: { status: "completed", stepCount: 1, toolCallCount: 0 },
      metadata: { interactiveDiscoveryShortlist: shortlist as never },
    })).rejects.toThrow("root_terminal_discovery_shortlist_invalid")
    expect(fake.client.query.mock.calls.some(([sql]) => sql.includes('UPDATE "sub_agent_tasks" SET'))).toBe(false)
  })

  it("requires a failed shortlist marker for terminal discovery failure", async () => {
    const fake = fakePool()
    await expect(createPgRootTaskStore(fake.pool).finish({
      lease, rootTaskId: "root-turn-1", result: { status: "failed", errorCode: "turn_failed", stepCount: 1, toolCallCount: 0 },
      metadata: { interactiveDiscoveryShortlist: { schemaVersion: 1, status: "partial", items: [{ jobId: "job-1", score: 8, evidenceIds: ["read:job:job-1"] }], failures: ["scout_result_partial"] } },
    })).rejects.toThrow("root_terminal_discovery_status_mismatch")
  })

  it("preserves a verified shortlist as partial when the root fails after ranking", async () => {
    const fake = fakePool()
    const shortlist = { schemaVersion: 1 as const, status: "partial" as const, items: [{ jobId: "job-1", score: 8, evidenceIds: ["read:job:job-1"] }], failures: ["discovery_runtime_failed" as const] }
    await createPgRootTaskStore(fake.pool).finish({
      lease, rootTaskId: "root-turn-1", result: { status: "failed", errorCode: "turn_failed", stepCount: 2, toolCallCount: 1 },
      metadata: { interactiveDiscoveryShortlist: shortlist },
    })
    const update = fake.client.query.mock.calls.find(([sql]) => sql.includes('UPDATE "sub_agent_tasks" SET'))
    expect(JSON.parse(String(update?.[1]?.[1]))).toMatchObject({
      status: "failed", structuredResult: { interactiveDiscoveryShortlist: shortlist },
    })
  })

  it("accepts an already-committed matching root receipt without rewriting terminal identity", async () => {
    const calls: string[] = []
    const result = { status: "completed" as const, stepCount: 2, toolCallCount: 1, finalItemId: "final-item" }
    const client = { query: vi.fn(async (sql: string) => {
      calls.push(sql)
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: lease.sessionId }], rowCount: 1 }
      if (sql.includes('FROM "agent_turns"') && sql.includes("status")) return sql.includes(`"status" = 'completed'`)
        ? { rows: [{ id: lease.turnId }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
      if (sql.includes('FROM "sub_agent_tasks"') && sql.includes('"status", "result"')) return { rows: [{ status: "completed", result, failureReason: null }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const pool = { connect: vi.fn(async () => client) } as never

    await expect(createPgRootTaskStore(pool).finish({ lease, rootTaskId: "root-turn-1", result })).resolves.toBeUndefined()

    expect(calls.findIndex(sql => sql.includes('FROM "agent_sessions"'))).toBeLessThan(calls.findIndex(sql => sql.includes('FROM "agent_turns"')))
    expect(calls.findIndex(sql => sql.includes('FROM "agent_turns"') && sql.includes(`"status" = 'completed'`))).toBeLessThan(calls.findIndex(sql => sql.includes('FROM "sub_agent_tasks"') && sql.includes('"status", "result"')))
    expect(calls.some(sql => sql.includes('UPDATE "sub_agent_tasks"'))).toBe(false)
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
        if (sql.includes('SELECT "id" FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
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
    await createPgRootTaskStore(fake.pool).finish({ lease, rootTaskId: "root-turn-1", result: { status: "waiting_for_dependency", stepCount: 1, toolCallCount: 0, waitId: "wait-1" } })
    expect(fake.calls.some(sql => sql.includes('"leaseOwner" = NULL') && sql.includes('"leaseExpiresAt" = NULL'))).toBe(true)
    const taskUpdate = fake.client.query.mock.calls.find(([sql]) => sql.includes('UPDATE "sub_agent_tasks" SET'))?.[0] ?? ""
    expect(taskUpdate).toContain("THEN $4::timestamp(3) ELSE NULL::timestamp(3) END")
    expect(taskUpdate).toContain('"updatedAt" = $4::timestamp(3)')
    expect(fake.client.query.mock.calls.some(([, values]) => String(values?.[1]).includes('"waitId":"wait-1"'))).toBe(true)
  })

  it.each([
    ["completed", "completed", null],
    ["waiting", "waiting_for_dependency", "wait-1"],
  ] as const)("reconciles a persisted %s root without rebinding it", async (rootStatus, turnStatus, waitId) => {
    const fake = terminalPool(row({ status: rootStatus, result: { status: turnStatus, stepCount: 2, toolCallCount: 1, waitId } }))
    const result = await createPgRootTaskStore(fake.pool).reconcileTerminal!({ lease, now: new Date("2026-09-07T00:00:10.000Z") })

    expect(result).toEqual({ rootTaskId: "root-turn-1", result: { status: turnStatus, ...(waitId ? { waitId } : {}) } })
    const query = fake.calls.find(call => call.sql.includes('FROM "sub_agent_tasks" AS task'))?.sql ?? ""
    expect(query).toContain('session."userId" = $3')
    expect(query).toContain('turn."leaseOwnerId" = $4')
    expect(query).toContain('turn."leaseVersion" = $5')
    expect(query).toContain('turn."status" = \'in_progress\'')
  })

  it("reconciles a persisted failed result with its bounded failure code", async () => {
    const fake = terminalPool(row({ status: "failed", result: { status: "failed", stepCount: 1, toolCallCount: 2 }, failureReason: "provider_error" }))
    await expect(createPgRootTaskStore(fake.pool).reconcileTerminal!({ lease })).resolves.toEqual({ rootTaskId: "root-turn-1", result: { status: "failed", summary: "provider_error" } })
  })

  it("returns no terminal root when the leased turn has none", async () => {
    const fake = terminalPool(null)
    await expect(createPgRootTaskStore(fake.pool).reconcileTerminal!({ lease })).resolves.toBeNull()
  })

  it("fails closed when a terminal root result is malformed", async () => {
    const fake = terminalPool(row({ status: "completed", result: { status: "failed", stepCount: 1, toolCallCount: 0 } }))
    await expect(createPgRootTaskStore(fake.pool).reconcileTerminal!({ lease })).rejects.toThrow("root_terminal_status_mismatch")
  })

  it.each(["queued", "running", "waiting"]) ("blocks completion while a %s child remains", async (childStatus) => {
    const fake = completionPool([{ id: "child-1", sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: "root-turn-1", userId: lease.userId, status: childStatus }])
    await expect(createPgRootTaskStore(fake.pool).checkCompletion!({ lease, rootTaskId: "root-turn-1" })).resolves.toMatchObject({ ok: false, blocker: "child_tasks_pending" })
    expect(fake.calls.some(sql => sql.includes("FOR UPDATE"))).toBe(true)
  })

  it("allows completion when every descendant is terminal", async () => {
    const fake = completionPool(["completed", "failed", "interrupted", "cancelled", "closed"].map((status, index) => ({ id: `child-${index}`, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: "root-turn-1", userId: lease.userId, status })))
    await expect(createPgRootTaskStore(fake.pool).checkCompletion!({ lease, rootTaskId: "root-turn-1" })).resolves.toEqual({ ok: true })
  })

  it("checks durable graph proof on the caller transaction without opening a nested transaction", async () => {
    const fake = completionPool([])
    const store = createPgRootTaskStore(fake.pool)
    await expect(store.checkCompletion!({ lease, rootTaskId: "root-turn-1", taskGraphVerification: true, client: fake.client as never })).resolves.toEqual({ ok: true })
    expect(fake.calls).not.toContain("BEGIN")
    expect(fake.calls).not.toContain("COMMIT")
    expect(fake.client.query.mock.calls.some(([sql]) => sql.includes('FROM "agent_items" AS item'))).toBe(true)
    expect(fake.client.query.mock.calls.some(([sql]) => sql.includes("payload"))).toBe(true)
  })

  it("surfaces the recoverable TaskGraph blocker before a pending descendant blocker", async () => {
    const fake = completionPool([{
      id: "child-1", sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: "root-turn-1", userId: lease.userId, status: "waiting",
    }], true, true)
    const store = createPgRootTaskStore(fake.pool)

    await expect(store.checkCompletion!({ lease, rootTaskId: "root-turn-1", taskGraphVerification: true, client: fake.client as never }))
      .resolves.toMatchObject({ ok: false, blocker: "task_graph_verification_unverified" })
    expect(fake.calls.some(sql => sql.includes("'proposal'"))).toBe(true)
  })

  it("keeps the generic pending-descendant blocker when TaskGraph verification has no graph to block", async () => {
    const fake = completionPool([{
      id: "child-1", sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: "root-turn-1", userId: lease.userId, status: "waiting",
    }])
    const store = createPgRootTaskStore(fake.pool)

    await expect(store.checkCompletion!({ lease, rootTaskId: "root-turn-1", taskGraphVerification: true, client: fake.client as never }))
      .resolves.toMatchObject({ ok: false, blocker: "child_tasks_pending" })
  })

  it.each(["queued", "retrying", "running", "waiting_for_user"])("keeps the child blocker ahead of TaskGraph recovery for %s descendants", async (status) => {
    const fake = completionPool([{
      id: "child-1", sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: "root-turn-1", userId: lease.userId, status,
    }], true, true)
    const store = createPgRootTaskStore(fake.pool)

    await expect(store.checkCompletion!({ lease, rootTaskId: "root-turn-1", taskGraphVerification: true, client: fake.client as never }))
      .resolves.toMatchObject({ ok: false, blocker: "child_tasks_pending" })
  })

  it("fails closed for a stale owner or foreign descendant row", async () => {
    const stale = completionPool([], false)
    await expect(createPgRootTaskStore(stale.pool).checkCompletion!({ lease, rootTaskId: "root-turn-1" })).rejects.toThrow("root_turn_fenced")
    const foreign = completionPool([{ id: "child-1", sessionId: "other-session", turnId: lease.turnId, rootTaskId: "root-turn-1", userId: lease.userId, status: "running" }])
    await expect(createPgRootTaskStore(foreign.pool).checkCompletion!({ lease, rootTaskId: "root-turn-1" })).rejects.toThrow("root_task_fenced")
  })

  it.each(["missing", "aborted", "archived"])("rejects %s sessions before root writes", async (sessionStatus) => {
    const fake = fakePool(null, 1, sessionStatus)
    await expect(createPgRootTaskStore(fake.pool).ensure({ lease, goal: "Find jobs" })).rejects.toThrow("root_session_fenced")
    expect(fake.calls.some(sql => sql.includes("INSERT INTO"))).toBe(false)
    expect(fake.calls.some(sql => sql.includes('UPDATE "agent_turns"'))).toBe(false)
    expect(fake.calls.some(sql => sql === "ROLLBACK")).toBe(true)
  })

  it("rejects a cross-user session before the Turn lock", async () => {
    const fake = fakePool(null, 1, "running", "user-2")
    await expect(createPgRootTaskStore(fake.pool).ensure({ lease, goal: "Find jobs" })).rejects.toThrow("root_session_fenced")
    expect(fake.calls.some(sql => sql.includes('FROM "agent_turns"'))).toBe(false)
    expect(fake.calls.some(sql => sql.includes("INSERT INTO"))).toBe(false)
    expect(fake.calls.some(sql => sql === "ROLLBACK")).toBe(true)
  })
})
