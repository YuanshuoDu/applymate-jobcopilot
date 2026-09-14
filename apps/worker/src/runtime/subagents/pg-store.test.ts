import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { PgSubagentTaskStore } from "./pg-store.js"
import { normalizeSubagentPolicy, SubagentLimitError, type SubagentPolicy } from "./types.js"

const now = new Date("2026-09-03T00:00:00.000Z")
const policy: SubagentPolicy = normalizeSubagentPolicy({ maxConcurrency: 2, maxAttempts: 2 })

function taskRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "task-1", parentTaskId: null,
    path: "/task-1", depth: 0, role: "scout", taskType: "test", status: "queued", goal: "inspect",
    constraints: [], successCriteria: [], allowedActions: [], context: {}, expectedOutputSchema: {}, result: null,
    failureReason: null, attemptCount: 0, maxAttempts: 2, leaseOwner: null, leaseExpiresAt: null,
    interruptRequestedAt: null, budgetSnapshot: { subagentPolicy: policy }, toolPolicySnapshot: {}, ...overrides,
  }
}

function fakePool(handler: (sql: string, params?: unknown[]) => { rows?: unknown[]; rowCount?: number }) {
  const calls: Array<[string, unknown[]?]> = []
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      return { rows: [], rowCount: 0, ...handler(sql, params) }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as pg.Pool, calls, client }
}

describe("PgSubagentTaskStore", () => {
  it("creates a root task under a locked session and persists an inherited policy", async () => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow()], rowCount: 1 }
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
      if (sql.includes("COUNT(*)")) return { rows: [{ count: 0 }], rowCount: 1 }
      if (sql.startsWith("INSERT INTO")) return { rows: [{ id: "task-1" }], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    const result = await store.create({ userId: "user-1", sessionId: "session-1", role: "scout", taskType: "test", goal: "inspect", policy })
    expect(result).toMatchObject({ id: "task-1", rootTaskId: "task-1", depth: 0, status: "queued" })
    const sessionQuery = fake.calls.find(([sql]) => sql.includes('FROM "agent_sessions"'))?.[0] ?? ""
    expect(sessionQuery).toContain('"status"')
    expect(sessionQuery).toContain("FOR UPDATE")
    const insert = fake.calls.find(([sql]) => sql.startsWith("INSERT INTO"))
    expect(insert?.[1]).toContain(JSON.stringify({ subagentPolicy: policy }))
  })

  it("atomically creates a child with its spawn operation and dispatch outbox", async () => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1", status: "running" }], rowCount: 1 }
      if (sql.includes('FROM "agent_outbox"')) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow()], rowCount: 1 }
      if (sql.startsWith("INSERT INTO \"sub_agent_tasks\"")) return { rows: [{ id: "task-1" }], rowCount: 1 }
      if (sql.startsWith("INSERT INTO \"agent_outbox\"")) return { rows: [], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    const result = await store.createWithSpawn({ userId: "user-1", sessionId: "session-1", role: "scout", taskType: "test", goal: "inspect", policy, spawnIdempotencyKey: "spawn-1" })
    expect(result).toMatchObject({ duplicate: false, task: { id: "task-1", status: "queued" } })
    const writes = fake.calls.filter(([sql]) => sql.startsWith("INSERT INTO \"agent_outbox\""))
    expect(writes).toHaveLength(2)
    const sessionIndex = fake.calls.findIndex(([sql]) => sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE"))
    const taskIndex = fake.calls.findIndex(([sql]) => sql.startsWith("INSERT INTO \"sub_agent_tasks\""))
    const operationIndex = fake.calls.findIndex(([sql]) => sql.startsWith("INSERT INTO \"agent_outbox\"") && sql.includes("'agent.subagent.spawn'"))
    expect(sessionIndex).toBeGreaterThan(-1)
    expect(sessionIndex).toBeLessThan(taskIndex)
    expect(operationIndex).toBeGreaterThan(taskIndex)
    expect(fake.calls.map(([sql]) => sql)).toContain("COMMIT")
  })

  it("replays an existing spawn key before parent fan-out validation", async () => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1", status: "running" }], rowCount: 1 }
      if (sql.includes('FROM "agent_outbox"')) return { rows: [{ payload: { taskId: "task-1" } }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ id: "task-1" })], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    const result = await store.createWithSpawn({ userId: "user-1", sessionId: "session-1", parentTaskId: "parent-1", role: "scout", taskType: "test", goal: "inspect", policy: normalizeSubagentPolicy({ maxFanOut: 1 }), spawnIdempotencyKey: "spawn-1" })
    expect(result).toMatchObject({ duplicate: true, task: { id: "task-1" } })
    expect(fake.calls.some(([sql]) => sql.startsWith("INSERT INTO \"sub_agent_tasks\""))).toBe(false)
    expect(fake.calls.some(([sql]) => sql.startsWith("INSERT INTO \"agent_outbox\""))).toBe(false)
    expect(fake.calls.map(([sql]) => sql)).toContain("COMMIT")
  })

  it("rolls back the task when the atomic dispatch outbox write fails", async () => {
    let taskInserted = false
    const fake = fakePool(sql => {
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1", status: "running" }], rowCount: 1 }
      if (sql.includes('FROM "agent_outbox"')) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow()], rowCount: 1 }
      if (sql.startsWith("INSERT INTO \"sub_agent_tasks\"")) { taskInserted = true; return { rows: [{ id: "task-1" }], rowCount: 1 } }
      if (sql === "ROLLBACK") { taskInserted = false; return {} }
      if (sql.startsWith("INSERT INTO \"agent_outbox\"")) throw new Error("outbox unavailable")
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.createWithSpawn({ userId: "user-1", sessionId: "session-1", role: "scout", taskType: "test", goal: "inspect", policy, spawnIdempotencyKey: "spawn-fail" })).rejects.toThrow("outbox unavailable")
    expect(fake.calls.map(([sql]) => sql)).toContain("ROLLBACK")
    expect(taskInserted).toBe(false)
  })

  it.each(["aborted", "archived"] as const)("rejects child creation for a %s session", async status => {
    const fake = fakePool(sql => sql.includes('FROM "agent_sessions"') ? { rows: [{ id: "session-1", status }], rowCount: 1 } : {})
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.create({ userId: "user-1", sessionId: "session-1", role: "scout", taskType: "test", goal: "inspect", policy })).rejects.toThrow("Session is unavailable")
    expect(fake.calls.some(([sql]) => sql.startsWith("INSERT INTO"))).toBe(false)
  })

  it.each(["running", "paused", "waiting_for_user"] as const)("keeps child creation compatible with a %s session", async status => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1", status }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow()], rowCount: 1 }
      if (sql.startsWith("INSERT INTO")) return { rows: [{ id: "task-1" }], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.create({ userId: "user-1", sessionId: "session-1", role: "scout", taskType: "test", goal: "inspect", policy })).resolves.toMatchObject({ status: "queued" })
    expect(fake.calls.some(([sql]) => sql.startsWith("INSERT INTO"))).toBe(true)
  })

  it("claims with a session lock and a conditional lease update", async () => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ status: "running", leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000) })], rowCount: 1 }
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
      if (sql.includes("COUNT(*)")) return { rows: [{ count: 0 }], rowCount: 1 }
      if (sql.startsWith("UPDATE")) return { rows: [{ id: "task-1" }], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    const result = await store.claim({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", policy, now })
    expect(result).toMatchObject({ status: "running", leaseOwner: "worker-1", attemptCount: 1 })
    const update = fake.calls.find(([sql]) => sql.startsWith("UPDATE"))?.[0] ?? ""
    expect(update).toContain("attemptCount")
    expect(update).toContain('"interruptRequestedAt" IS NULL')
  })

  it.each(["aborted", "archived"] as const)("does not claim a queued child from a %s session", async status => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1", status }], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.claim({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", policy, now })).resolves.toBeNull()
    expect(fake.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false)
  })

  it.each(["running", "paused", "waiting_for_user"] as const)("keeps queued child claims compatible with a %s session", async status => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1", status }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ status: "running", leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000) })], rowCount: 1 }
      if (sql.includes("COUNT(*)")) return { rows: [{ count: 0 }], rowCount: 1 }
      if (sql.startsWith("UPDATE")) return { rows: [{ id: "task-1" }], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.claim({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", policy, now })).resolves.toMatchObject({ status: "running" })
    const update = fake.calls.find(([sql]) => sql.startsWith("UPDATE"))?.[0] ?? ""
    expect(update).toContain('session."status" NOT IN (\'aborted\', \'archived\')')
  })

  it("inherits the parent model route and only permits a requested action subset", async () => {
    const parent = taskRow({ id: "parent-1", rootTaskId: "parent-1", path: "/parent-1", status: "running", allowedActions: ["jobs.search", "persona.read"], modelProfileSnapshot: { provider: "fixture", model: "parent-model" } })
    const fake = fakePool(sql => {
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ id: "child-1", rootTaskId: "parent-1", parentTaskId: "parent-1", modelProfileSnapshot: parent.modelProfileSnapshot, allowedActions: ["jobs.search"] })], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks"') && sql.includes('FOR UPDATE')) return { rows: [parent], rowCount: 1 }
      if (sql.startsWith("INSERT INTO")) return { rows: [{ id: "child-1" }], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    await store.create({ userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "parent-1", role: "analyst", taskType: "research", goal: "inspect", allowedActions: ["jobs.search"], modelProfileSnapshot: { provider: "fixture", model: "override" }, policy })
    const insert = fake.calls.find(([sql]) => sql.startsWith("INSERT INTO"))?.[1] ?? []
    expect(insert[12]).toBe(JSON.stringify(["jobs.search"]))
    expect(insert[15]).toBe(JSON.stringify(parent.modelProfileSnapshot))
    expect(insert[17]).toBe(JSON.stringify({ subagentPolicy: policy }))
  })

  it("inherits all parent actions when the child request is empty and rejects expansion", async () => {
    const parent = taskRow({ id: "parent-1", rootTaskId: "parent-1", path: "/parent-1", status: "running", allowedActions: ["jobs.search"], modelProfileSnapshot: { provider: "fixture", model: "parent-model" } })
    const fake = fakePool(sql => {
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ id: "child-1", rootTaskId: "parent-1", parentTaskId: "parent-1", modelProfileSnapshot: parent.modelProfileSnapshot, allowedActions: ["jobs.search"] })], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks"') && sql.includes('FOR UPDATE')) return { rows: [parent], rowCount: 1 }
      if (sql.startsWith("INSERT INTO")) return { rows: [{ id: "child-1" }], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    await store.create({ userId: "user-1", sessionId: "session-1", parentTaskId: "parent-1", role: "scout", taskType: "research", goal: "inspect", allowedActions: [], policy })
    const insert = fake.calls.find(([sql]) => sql.startsWith("INSERT INTO"))?.[1] ?? []
    expect(insert[12]).toBe(JSON.stringify(["jobs.search"]))
    await expect(store.create({ userId: "user-1", sessionId: "session-1", parentTaskId: "parent-1", role: "scout", taskType: "research", goal: "inspect", allowedActions: ["gmail.send"], policy })).rejects.toThrow("exceed parent")
  })

  it("rejects a child that would exceed the inherited depth or fan-out", async () => {
    const parent = taskRow({ id: "parent-1", rootTaskId: "parent-1", path: "/parent-1", depth: 2, status: "running" })
    const depthFake = fakePool(sql => {
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [parent], rowCount: 1 }
      return {}
    })
    const depthStore = new PgSubagentTaskStore(depthFake.pool)
    await expect(depthStore.create({ userId: "user-1", sessionId: "session-1", parentTaskId: "parent-1", role: "analyst", taskType: "test", goal: "inspect", policy: normalizeSubagentPolicy({ maxDepth: 2 }) })).rejects.toMatchObject({ code: "depth" })

    const fanOutFake = fakePool(sql => {
      if (sql.includes("COUNT(*)")) return { rows: [{ count: 2 }], rowCount: 1 }
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [taskRow({ id: "parent-1", status: "running" })], rowCount: 1 }
      return {}
    })
    const fanOutStore = new PgSubagentTaskStore(fanOutFake.pool)
    await expect(fanOutStore.create({ userId: "user-1", sessionId: "session-1", parentTaskId: "parent-1", role: "analyst", taskType: "test", goal: "inspect", policy: normalizeSubagentPolicy({ maxFanOut: 2 }) })).rejects.toMatchObject({ code: "fan_out" })
  })

  it("returns retrying while putting a transient failure back in queued state", async () => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ status: "running", leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000) })], rowCount: 1 }
      if (sql.startsWith("UPDATE")) return { rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.finish({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, status: "failed", failureReason: "timeout", now })).resolves.toBe("retrying")
    const update = fake.calls.find(([sql]) => sql.startsWith("UPDATE"))
    expect(update?.[0]).toContain('"attemptCount" = $9')
    expect(update?.[0]).toContain('"leaseExpiresAt" > CURRENT_TIMESTAMP')
    expect(update?.[1]).toContain(1)
  })

  it("completes the task and consumes the read mailbox ids in one transaction", async () => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ status: "running", leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000) })], rowCount: 1 }
      if (sql.includes('UPDATE "agent_mailbox_messages"')) return { rows: [{ id: "message-2" }, { id: "message-1" }], rowCount: 2 }
      if (sql.startsWith('UPDATE "sub_agent_tasks"')) return { rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({
      taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, status: "completed", now,
      mailboxMessageIds: ["message-2", "unknown", "message-1", "message-2"],
    })).resolves.toBe("completed")

    const taskUpdateIndex = fake.calls.findIndex(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks"'))
    const mailboxUpdateIndex = fake.calls.findIndex(([sql]) => sql.includes('UPDATE "agent_mailbox_messages"'))
    const mailboxUpdate = fake.calls[mailboxUpdateIndex]
    expect(taskUpdateIndex).toBeGreaterThan(-1)
    expect(mailboxUpdateIndex).toBeGreaterThan(taskUpdateIndex)
    expect(mailboxUpdate?.[0]).toContain('message."consumedAt" IS NULL')
    expect(mailboxUpdate?.[1]).toEqual(["session-1", "task-1", ["message-2", "unknown", "message-1"]])
    expect(fake.calls.map(([sql]) => sql)).toContain("BEGIN")
    expect(fake.calls.map(([sql]) => sql)).toContain("COMMIT")
  })

  it("keeps completion idempotent when mailbox ids are unknown or already consumed", async () => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ status: "running", leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000) })], rowCount: 1 }
      if (sql.includes('UPDATE "agent_mailbox_messages"')) return { rows: [], rowCount: 0 }
      if (sql.startsWith('UPDATE "sub_agent_tasks"')) return { rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, status: "completed", now, mailboxMessageIds: ["unknown", "unknown"] })).resolves.toBe("completed")
    expect(fake.calls.filter(([sql]) => sql.includes('UPDATE "agent_mailbox_messages"'))).toHaveLength(1)
    expect(fake.calls.map(([sql]) => sql)).toContain("COMMIT")
  })

  it.each([
    ["terminal failure", 1],
    ["retrying failure", 2],
  ] as const)("does not consume mailbox ids for a %s", async (_label, maxAttempts) => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ status: "running", leaseOwner: "worker-1", attemptCount: 1, maxAttempts, leaseExpiresAt: new Date(now.getTime() + 60_000) })], rowCount: 1 }
      if (sql.startsWith('UPDATE "sub_agent_tasks"')) return { rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, status: "failed", failureReason: "provider failed", now, mailboxMessageIds: ["message-1"] })).resolves.toBe(maxAttempts === 1 ? "failed" : "retrying")
    expect(fake.calls.some(([sql]) => sql.includes('UPDATE "agent_mailbox_messages"'))).toBe(false)
  })

  it.each([
    ["foreign owner", { leaseOwner: "worker-foreign" }],
    ["wrong attempt", { attemptCount: 2 }],
    ["expired lease", { leaseExpiresAt: new Date(now.getTime() - 1) }],
    ["foreign session", { sessionId: "session-other" }],
  ] as const)("fences a finish from a %s", async (_label, overrides) => {
    const fake = fakePool(sql => sql.includes('FROM "sub_agent_tasks" task') ? { rows: [taskRow({ status: "running", leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000), ...overrides })], rowCount: 1 } : {})
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, status: "completed", now, mailboxMessageIds: ["message-1"] })).resolves.toBeNull()
    expect(fake.calls.some(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.some(([sql]) => sql.includes('UPDATE "agent_mailbox_messages"'))).toBe(false)
  })

  it("rolls back when the task update loses its fence", async () => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ status: "running", leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000) })], rowCount: 1 }
      if (sql.startsWith('UPDATE "sub_agent_tasks"')) return { rowCount: 0 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, status: "completed", now, mailboxMessageIds: ["message-1"] })).resolves.toBeNull()
    expect(fake.calls.map(([sql]) => sql)).toContain("ROLLBACK")
    expect(fake.calls.some(([sql]) => sql.includes('UPDATE "agent_mailbox_messages"'))).toBe(false)
  })

  it("rolls back both writes when mailbox confirmation fails", async () => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ status: "running", leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000) })], rowCount: 1 }
      if (sql.includes('UPDATE "agent_mailbox_messages"')) throw new Error("mailbox unavailable")
      if (sql.startsWith('UPDATE "sub_agent_tasks"')) return { rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, status: "completed", now, mailboxMessageIds: ["message-1"] })).rejects.toThrow("mailbox unavailable")
    expect(fake.calls.map(([sql]) => sql)).toContain("ROLLBACK")
  })

  it("does not report completion when the lease fence update loses a race", async () => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ status: "running", leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000) })], rowCount: 1 }
      if (sql.startsWith("UPDATE")) return { rowCount: 0 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.finish({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, status: "completed", now })).resolves.toBeNull()
  })

  it.each(["aborted", "archived"] as const)("does not finish a child in a %s session", async status => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ status: "running", sessionStatus: status, leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000) })], rowCount: 1 }
      if (sql.startsWith("UPDATE")) return { rowCount: 0 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.finish({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, status: "completed", now })).resolves.toBeNull()
    const update = fake.calls.find(([sql]) => sql.startsWith("UPDATE"))?.[0] ?? ""
    expect(update).toContain('session."status" NOT IN (\'aborted\', \'archived\')')
  })

  it("releases only the fenced running lease and republishes its outbox row", async () => {
    const fake = fakePool(sql => sql.startsWith("UPDATE") ? { rowCount: 1 } : {})
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.release({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, now })).resolves.toBe(true)
    const updates = fake.calls.filter(([sql]) => sql.startsWith("UPDATE"))
    expect(updates).toHaveLength(2)
    expect(updates[0]?.[0]).toContain('"leaseOwner" = $3')
    expect(updates[0]?.[0]).toContain('"status" = \'running\'')
    expect(updates[0]?.[0]).toContain('"attemptCount" = $4')
    expect(updates[0]?.[0]).toContain('"updatedAt" = $5')
    expect(updates[0]?.[0]).toContain('"interruptRequestedAt" IS NULL')
    expect(updates[0]?.[0]).toContain('session."status" NOT IN (\'aborted\', \'archived\')')
    expect(updates[1]?.[0]).toContain("publishedAt")
    expect(updates[1]?.[0]).toContain('"topic" = \'agent.subagent.dispatch\'')
    expect(updates[1]?.[0]).toContain('"idempotencyKey" = $1')
    expect(updates[1]?.[0]).toContain('"aggregateId" = $2')
    expect(updates[1]?.[1]).toEqual(["subagent-dispatch:task-1", "session-1"])
  })

  it.each(["aborted", "archived"] as const)("does not release a child in a %s session", async status => {
    const fake = fakePool(sql => sql.startsWith("UPDATE") ? { rowCount: 0 } : {})
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.release({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, now })).resolves.toBe(false)
    const updates = fake.calls.filter(([sql]) => sql.startsWith("UPDATE"))
    expect(updates).toHaveLength(1)
    expect(updates[0]?.[0]).toContain('session."status" NOT IN (\'aborted\', \'archived\')')
    expect(updates.some(([sql]) => sql.includes('"agent_outbox"'))).toBe(false)
  })

  it("surfaces a durable interrupt during heartbeat instead of renewing", async () => {
    const fake = fakePool(sql => {
      if (sql.startsWith("UPDATE")) return { rows: [{ interruptRequestedAt: now }], rowCount: 1 }
      if (sql.startsWith("SELECT") && sql.includes('FROM "agent_sessions"')) return { rows: [{ status: "running" }], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.heartbeat({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, now })).resolves.toBe("interrupted")
    const update = fake.calls.find(([sql]) => sql.startsWith("UPDATE"))?.[0] ?? ""
    expect(update).toContain('"attemptCount" = $5')
    expect(update).toContain('session."status" NOT IN (\'aborted\', \'archived\')')
  })

  it.each(["aborted", "archived"] as const)("does not renew a child in a %s session", async status => {
    const fake = fakePool(sql => {
      if (sql.startsWith("UPDATE")) return { rowCount: 0 }
      if (sql.startsWith("SELECT") && sql.includes('FROM "agent_sessions"')) return { rows: [{ status }], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.heartbeat({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, now })).resolves.toBe("interrupted")
    expect(fake.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false)
  })

  it("marks the whole root tree for interruption without cancelling terminal tasks", async () => {
    const fake = fakePool(sql => sql.startsWith("UPDATE") ? { rowCount: 3 } : {})
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.interruptTree({ sessionId: "session-1", rootTaskId: "task-1", now })).resolves.toBe(3)
    const update = fake.calls.find(([sql]) => sql.startsWith("UPDATE"))?.[0] ?? ""
    expect(update).toContain('"interruptRequestedAt"')
    expect(update).toContain("'waiting_for_user'")
  })

  it("interrupts only the requested path subtree in a transaction", async () => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) return { rows: [{ id: "session-1", status: "running" }], rowCount: 1 }
      if (sql.startsWith("UPDATE")) return { rowCount: 3 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.interruptSubtree({ sessionId: "session-1", rootTaskId: "root-1", targetPath: "/root-1/child-a", now })).resolves.toBe(3)
    const sessionIndex = fake.calls.findIndex(([sql]) => sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE"))
    const updateIndex = fake.calls.findIndex(([sql]) => sql.startsWith("UPDATE"))
    const update = fake.calls[updateIndex]?.[0] ?? ""
    expect(sessionIndex).toBeGreaterThan(-1)
    expect(sessionIndex).toBeLessThan(updateIndex)
    expect(update).toContain('"rootTaskId" = $2')
    expect(update).toContain('("path" = $3 OR "path" LIKE $3 || \'/%\')')
    expect(update).toContain('"status" IN (\'queued\', \'running\', \'retrying\', \'waiting\', \'waiting_for_user\')')
    expect(fake.calls.map(([sql]) => sql)).toContain("BEGIN")
    expect(fake.calls.map(([sql]) => sql)).toContain("COMMIT")
  })

  it.each(["aborted", "archived"] as const)("does not update tasks for a %s session", async status => {
    const fake = fakePool(sql => sql.includes('FROM "agent_sessions"') ? { rows: [{ id: "session-1", status }], rowCount: 1 } : {})
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.interruptSubtree({ sessionId: "session-1", rootTaskId: "root-1", targetPath: "/root-1/child-a", now })).resolves.toBe(0)
    expect(fake.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false)
    expect(fake.calls.find(([sql]) => sql.includes('FROM "agent_sessions"'))?.[0]).toContain('"status" NOT IN (\'aborted\', \'archived\')')
    expect(fake.calls.map(([sql]) => sql)).toContain("COMMIT")
  })

  it("does not update tasks when the scoped session is missing", async () => {
    const fake = fakePool(sql => sql.includes('FROM "agent_sessions"') ? { rows: [] } : {})
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.interruptSubtree({ sessionId: "missing-session", rootTaskId: "root-1", targetPath: "/root-1/child-a", now })).resolves.toBe(0)
    expect(fake.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false)
  })

  it("reclaims stale leases into queued or terminal states", async () => {
    const fake = fakePool(sql => {
      if (sql.includes("leaseExpiresAt") && sql.includes("FOR UPDATE")) return { rows: [taskRow({ status: "running", sessionStatus: "running", leaseOwner: "dead-worker", leaseExpiresAt: new Date(now.getTime() - 1), attemptCount: 1 })], rowCount: 1 }
      if (sql.startsWith("UPDATE")) return { rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    const result = await store.recoverExpired({ now, limit: 10 })
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe("queued")
    const select = fake.calls.find(([sql]) => sql.includes("leaseExpiresAt") && sql.includes("FOR UPDATE"))?.[0] ?? ""
    expect(select).toContain("LIMIT $2 FOR UPDATE SKIP LOCKED")
  })

  it.each(["aborted", "archived"] as const)("reclaims a stale child from a %s session as interrupted", async status => {
    const fake = fakePool(sql => {
      if (sql.includes("leaseExpiresAt") && sql.includes("FOR UPDATE")) return { rows: [taskRow({ status: "running", sessionStatus: status, leaseOwner: "dead-worker", leaseExpiresAt: new Date(now.getTime() - 1), attemptCount: 1 })], rowCount: 1 }
      if (sql.startsWith("UPDATE")) return { rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    const result = await store.recoverExpired({ now, limit: 10 })
    expect(result[0]?.status).toBe("interrupted")
    const select = fake.calls.find(([sql]) => sql.includes("leaseExpiresAt") && sql.includes("FOR UPDATE"))?.[0] ?? ""
    expect(select).toContain('session."status"')
  })
})
