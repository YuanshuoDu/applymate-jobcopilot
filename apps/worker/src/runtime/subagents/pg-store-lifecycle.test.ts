import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { interruptSubtree, interruptTree, interruptTurn, recoverExpired } from "./pg-store-lifecycle.js"
import type { PgSubagentPool } from "./types.js"
import { TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"

function taskRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "task-1", parentTaskId: null,
    path: "/task-1", depth: 0, status: "running", attemptCount: 1, maxAttempts: 3, nextAttemptAt: null,
    leaseOwner: "worker-1", leaseExpiresAt: new Date("2026-09-22T00:00:00Z"), interruptRequestedAt: null,
    failureReason: null, result: null, ...overrides,
  }
}

function fakePool(handler?: (sql: string, params?: unknown[]) => { rows?: unknown[]; rowCount?: number }) {
  const calls: Array<[string, unknown[]?]> = []
  const client = { query: vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push([sql, params])
    const result = handler?.(sql, params) ?? {}
    if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE") && !result.rows?.length) {
      return { rows: [{ id: "session-1", userId: "user-1", status: "running" }], rowCount: 1, ...result }
    }
    if (sql.includes('SELECT task."id", task."status", task."attemptCount"') && !result.rows?.length) {
      const count = sql.includes('task."turnId" = $2') ? 2 : 3
      return { rows: Array.from({ length: count }, (_, index) => ({ id: `task-${index + 1}`, status: index === 0 ? "running" : "waiting", attemptCount: 1 })), rowCount: count, ...result }
    }
    if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("LIMIT $2") && !result.rows?.length) {
      return { rows: [{ id: "task-1", sessionId: "session-1", rootTaskId: "task-1", userId: "user-1" }], rowCount: 1, ...result }
    }
    if (sql.includes('session."status" AS "sessionStatus"') && !result.rows?.length) return { rows: [taskRow({ sessionStatus: "running" })], rowCount: 1, ...result }
    if (sql.includes('SELECT task."turnId"') && !result.rows?.length) return { rows: [taskRow()], rowCount: 1, ...result }
    return { rows: [], rowCount: 1, ...result }
  }), release: vi.fn() }
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as PgSubagentPool, calls, client }
}

describe("subagent PostgreSQL lifecycle helpers", () => {
  it("keeps a running TaskGraph child running and records only its cooperative interrupt request", async () => {
    const now = new Date("2026-09-27T12:00:00.000Z")
    const calls: Array<[string, unknown[]?]> = []
    const statuses = new Map([["running-child", "running"], ["dependent-child", "waiting"]])
    const interruptRequests = new Map<string, Date>()
    const client = { query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: "session-1", userId: "user-1", status: "running" }], rowCount: 1 }
      }
      if (sql.includes('SELECT task."id", task."status", task."attemptCount"')) {
        return { rows: [{ id: "running-child", status: "running", attemptCount: 1 }], rowCount: 1 }
      }
      if (sql.startsWith('UPDATE "sub_agent_tasks"')) {
        interruptRequests.set(String(params?.[0]), params?.[2] as Date)
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as PgSubagentPool

    await expect(interruptTurn(pool, { userId: "user-1", sessionId: "session-1", turnId: "turn-1", now })).resolves.toBe(1)

    expect(statuses.get("running-child")).toBe("running")
    expect(statuses.get("dependent-child")).toBe("waiting")
    expect(interruptRequests.get("running-child")).toBe(now)
    const taskUpdates = calls.filter(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks"'))
    expect(taskUpdates).toHaveLength(1)
    const setClause = taskUpdates[0]![0].slice(taskUpdates[0]![0].indexOf("SET"), taskUpdates[0]![0].indexOf("WHERE"))
    expect(setClause).toContain('"interruptRequestedAt" = COALESCE')
    expect(setClause).not.toContain('"status"')
    expect(calls.some(([sql]) => sql.includes('SELECT item."id"') || sql.includes('event."payload"'))).toBe(false)
    expect(calls.some(([sql]) => sql.includes('INSERT INTO "agent_events"'))).toBe(false)
    expect(calls.some(([sql]) => sql.includes('"agent_outbox"'))).toBe(false)
  })

  it("scopes bulk interruptions and applies row changes after the session lock", async () => {
    const tree = fakePool()
    await expect(interruptTree(tree.pool, { sessionId: "session-1", rootTaskId: "root-1", now: new Date() })).resolves.toBe(3)
    const treeSelect = tree.calls.find(([sql]) => sql.includes('SELECT task."id", task."status", task."attemptCount"'))?.[0] ?? ""
    expect(treeSelect).toContain('task."rootTaskId" = $2')

    const turn = fakePool()
    await expect(interruptTurn(turn.pool, { userId: "user-1", sessionId: "session-1", turnId: "turn-1", now: new Date() })).resolves.toBe(2)
    const turnSelect = turn.calls.find(([sql]) => sql.includes('SELECT task."id", task."status", task."attemptCount"'))?.[0] ?? ""
    expect(turnSelect).toContain('task."turnId" = $2')
    expect(turnSelect).toContain('session."userId" = $3')

    const subtree = fakePool()
    await expect(interruptSubtree(subtree.pool, { sessionId: "session-1", rootTaskId: "root-1", targetPath: "/root-1/child", now: new Date() })).resolves.toBe(3)
    const subtreeSelect = subtree.calls.find(([sql]) => sql.includes('SELECT task."id", task."status", task."attemptCount"'))?.[0] ?? ""
    expect(subtreeSelect).toContain('task."rootTaskId" = $2')
    expect(subtreeSelect).toContain('task."path" LIKE $3 || \'/%\'')
    const lockIndex = subtree.calls.findIndex(([sql]) => sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE"))
    const updateIndex = subtree.calls.findIndex(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks"'))
    expect(lockIndex).toBeGreaterThan(-1)
    expect(lockIndex).toBeLessThan(updateIndex)
  })

  it("does not interrupt a closed session and recovers expired leases under session→task locks", async () => {
    const closed = fakePool(sql => sql.includes('FROM "agent_sessions"') ? { rows: [{ userId: "user-1", status: "archived" }], rowCount: 1 } : {})
    await expect(interruptSubtree(closed.pool, { sessionId: "session-1", rootTaskId: "root-1", targetPath: "/root-1", now: new Date() })).resolves.toBe(0)
    expect(closed.calls.some(([sql]) => sql.includes('SELECT task."id", task."status", task."attemptCount"'))).toBe(false)

    const now = new Date("2026-09-23T12:00:00Z")
    const recovery = fakePool()
    await expect(recoverExpired(recovery.pool, { now, limit: 10 })).resolves.toMatchObject([
      { id: "task-1", status: "queued", leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: expect.any(Date) },
    ])
    const scan = recovery.calls.find(([sql]) => sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("LIMIT $2"))?.[0] ?? ""
    expect(scan).toContain(`session."status" IN ('aborted', 'archived')`)
    expect(scan).toContain(`session."status" NOT IN ('aborted', 'archived')`)
    expect(scan).not.toContain("FOR UPDATE")
    const sessionLock = recovery.calls.findIndex(([sql]) => sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE"))
    const taskLock = recovery.calls.findIndex(([sql]) => sql.includes("FOR UPDATE OF task"))
    expect(sessionLock).toBeGreaterThan(-1)
    expect(taskLock).toBeGreaterThan(sessionLock)
    expect(recovery.calls.map(([sql]) => sql)).toContain("COMMIT")
    await expect(recoverExpired(recovery.pool, { now, limit: 0 })).rejects.toThrow("Recovery limit must be positive")
  })

  it.each(["aborted", "archived"] as const)("records graph recovery after an expired task in a %s session without publishing to its closed stream", async status => {
    const calls: Array<[string, unknown[]?]> = []
    let taskStatus = "running"
    let revision = 1
    let lifecyclePayload: string | null = null
    const snapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{
      key: "child", templateId: "analyst", goal: "Inspect", successCriteria: ["done"], dependsOn: [], depth: 1, taskId: "child-1",
    }] }
    const row = taskRow({ id: "child-1", rootTaskId: "root-1", parentTaskId: "root-1", status: taskStatus, maxAttempts: 3, sessionStatus: status })
    const client = { query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("LIMIT $2")) return { rows: [{ id: "child-1", sessionId: "session-1", rootTaskId: "root-1", userId: "user-1" }], rowCount: 1 }
      if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) return { rows: [{ id: "session-1", userId: "user-1", status }], rowCount: 1 }
      if (sql.includes('SELECT task."turnId"')) return { rows: [{ turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", attemptCount: 1, userId: "user-1" }], rowCount: 1 }
      if (sql.includes("event.\"payload\"->>'kind' = 'proposal'")) return { rows: [{ payload: { kind: "proposal", receipt: {
        revision: 1, nodes: [{ key: "child", taskId: "child-1", status: "queued" }], readyTaskIds: ["child-1"],
      } } }], rowCount: 1 }
      if (sql.includes('SELECT item."id"')) return { rows: [{ id: "graph-item", revision, content: snapshot, createdAt: new Date("2026-09-01T00:00:00.000Z") }], rowCount: 1 }
      if (sql.includes('SELECT task."id", task."status", task."role", task."failureReason"')) return { rows: [{ id: "child-1", status: taskStatus, role: "analyst", failureReason: null, result: null }], rowCount: 1 }
      if (sql.includes('SELECT event."payload"')) return { rows: lifecyclePayload ? [{ payload: JSON.parse(lifecyclePayload) }] : [], rowCount: lifecyclePayload ? 1 : 0 }
      if (sql.includes('session."status" AS "sessionStatus"')) return { rows: [{ ...row, status: taskStatus, sessionStatus: status }], rowCount: 1 }
      if (sql.includes('UPDATE "sub_agent_tasks" SET "status"')) { taskStatus = String(params?.[2]); return { rows: [], rowCount: 1 } }
      if (sql.startsWith('UPDATE "agent_items"')) { revision = Number(params?.[5]); return { rows: [{ stepId: "step-1", status: "streaming", phase: null, startedAt: new Date(), completedAt: null, createdAt: new Date() }], rowCount: 1 } }
      if (sql.includes('UPDATE "agent_sessions" AS session') && sql.includes('RETURNING "eventSequence"')) return { rows: [{ eventSequence: "9" }], rowCount: 1 }
      if (sql.includes('INSERT INTO "agent_events"')) { lifecyclePayload = String(params?.[10]); return { rows: [], rowCount: 1 } }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as PgSubagentPool

    await expect(recoverExpired(pool, { now: new Date("2026-09-23T12:00:00Z"), limit: 10 })).resolves.toMatchObject([
      { id: "child-1", status: "interrupted" },
    ])
    const eventWrite = calls.find(([sql]) => sql.includes('INSERT INTO "agent_events"'))
    expect(eventWrite?.[0]).toContain('"taskId"')
    expect(eventWrite?.[1]?.[4]).toBe("child-1")
    const sequenceWrite = calls.find(([sql]) => sql.includes('UPDATE "agent_sessions" AS session') && sql.includes('RETURNING "eventSequence"'))
    expect(sequenceWrite?.[1]?.[2]).toBe(true)
    expect(calls.some(([sql]) => sql.includes('INSERT INTO "agent_outbox"'))).toBe(false)
    expect(revision).toBe(2)
  })

  it("interrupts graph siblings and clears dispatch work during closed-session recovery", async () => {
    const calls: Array<[string, unknown[]?]> = []
    const statuses = new Map([["child-1", "running"], ["child-2", "waiting"], ["child-3", "running"]])
    const events: Array<Record<string, unknown>> = []
    let revision = 1
    const snapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [
      { key: "first", templateId: "analyst", goal: "Inspect", successCriteria: ["done"], dependsOn: [], depth: 1, taskId: "child-1" },
      { key: "second", templateId: "analyst", goal: "Summarize", successCriteria: ["done"], dependsOn: ["first"], depth: 2, taskId: "child-2" },
      { key: "third", templateId: "analyst", goal: "Review", successCriteria: ["done"], dependsOn: [], depth: 1, taskId: "child-3" },
    ] }
    const client = { query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("LIMIT $2")) return { rows: [{ id: "child-1", sessionId: "session-1", rootTaskId: "root-1", userId: "user-1" }], rowCount: 1 }
      if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) return { rows: [{ id: "session-1", userId: "user-1", status: "aborted" }], rowCount: 1 }
      if (sql.includes('SELECT task."turnId"')) return { rows: [{ turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", attemptCount: 1, userId: "user-1" }], rowCount: 1 }
      if (sql.includes("event.\"payload\"->>'kind' = 'proposal'")) return { rows: [{ payload: { kind: "proposal", receipt: {
        revision: 1,
        nodes: snapshot.nodes.map(node => ({ key: node.key, taskId: node.taskId, status: node.dependsOn.length ? "waiting" : "queued" })),
        readyTaskIds: snapshot.nodes.filter(node => node.dependsOn.length === 0).map(node => node.taskId),
      } } }], rowCount: 1 }
      if (sql.includes('SELECT item."id"')) return { rows: [{ id: "graph-item", revision, content: snapshot, createdAt: new Date("2026-09-01T00:00:00Z") }], rowCount: 1 }
      if (sql.includes('SELECT task."id", task."status", task."role", task."failureReason"')) return {
        rows: [...statuses].map(([id, taskStatus]) => ({ id, status: taskStatus, role: "analyst", failureReason: null, result: null })), rowCount: statuses.size,
      }
      if (sql.includes('SELECT event."payload"')) return { rows: events.map(payload => ({ payload })), rowCount: events.length }
      if (sql.includes('session."status" AS "sessionStatus"')) return {
        rows: [taskRow({ id: "child-1", rootTaskId: "root-1", parentTaskId: "root-1", status: statuses.get("child-1"), sessionStatus: "aborted" })], rowCount: 1,
      }
      if (sql.includes("FOR UPDATE OF task")) return {
        rows: [taskRow({ id: "child-1", rootTaskId: "root-1", parentTaskId: "root-1", status: statuses.get("child-1"), sessionStatus: "aborted" })], rowCount: 1,
      }
      if (sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $3')) { statuses.set(String(params?.[0]), String(params?.[2])); return { rows: [], rowCount: 1 } }
      if (sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = \'interrupted\'')) { statuses.set(String(params?.[0]), "interrupted"); return { rows: [], rowCount: 1 } }
      if (sql.startsWith('UPDATE "agent_items"')) { revision = Number(params?.[5]); return { rows: [{ stepId: "step-1", status: "streaming", phase: null, startedAt: new Date(), completedAt: null, createdAt: new Date() }], rowCount: 1 } }
      if (sql.includes('UPDATE "agent_sessions" AS session') && sql.includes('RETURNING "eventSequence"')) return { rows: [{ eventSequence: "9" }], rowCount: 1 }
      if (sql.includes('INSERT INTO "agent_events"')) { events.push(JSON.parse(String(params?.[10])) as Record<string, unknown>); return { rows: [], rowCount: 1 } }
      if (sql.includes('INSERT INTO "agent_outbox"')) throw new Error("closed session must not enqueue")
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as PgSubagentPool

    await expect(recoverExpired(pool, { now: new Date("2026-09-23T12:00:00Z"), limit: 10 })).resolves.toMatchObject([
      { id: "child-1", status: "interrupted" },
    ])
    expect(statuses.get("child-2")).toBe("interrupted")
    expect(revision).toBe(3)
    expect(events.map(event => event.event && (event.event as Record<string, unknown>).nodeKey)).toEqual(["first", "second"])
    expect(calls.filter(([sql]) => sql.startsWith('DELETE FROM "agent_outbox"'))).toHaveLength(2)
    expect(calls.some(([sql]) => sql.includes('UPDATE "sub_agent_tasks"') && sql.includes("interruptRequestedAt") && sql.includes("'interrupted'"))).toBe(true)
    expect(calls.some(([sql, params]) => sql.includes('UPDATE "sub_agent_tasks"') && sql.includes("interruptRequestedAt")
      && sql.includes("status") && params?.[0] === "child-3")).toBe(true)
    expect(calls.some(([sql]) => sql.includes('INSERT INTO "agent_outbox"'))).toBe(false)
  })
})
