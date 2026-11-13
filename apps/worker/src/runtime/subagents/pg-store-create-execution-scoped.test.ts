import { describe, expect, it, vi } from "vitest"
import { createSubagentWithSpawnFromLease } from "./pg-store-create-execution-scoped.js"
import { normalizeSubagentPolicy, type AtomicSubagentSpawnFromLeaseInput, type PgSubagentPool } from "./types.js"
import { SELECT_TASK } from "./pg-store-persistence.js"

const fence = { id: "parent-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", ownerId: "owner-1", attemptCount: 2 }
const parentPolicy = normalizeSubagentPolicy({ maxConcurrency: 2, maxDepth: 2, maxFanOut: 1, maxAttempts: 2 })
const input: AtomicSubagentSpawnFromLeaseInput = {
  userId: fence.userId, sessionId: fence.sessionId, turnId: fence.turnId, parentTaskId: fence.id,
  role: "scout", taskType: "research", goal: "inspect", policy: normalizeSubagentPolicy(),
  spawnIdempotencyKey: "spawn-1", parentExecutionFence: fence,
}

type FixtureOptions = {
  parent?: Record<string, unknown>
  root?: Record<string, unknown>
  live?: boolean
  existing?: { taskId: string }
  replayTask?: Record<string, unknown>
  activeChildren?: number
  missingSession?: boolean
  missingTurn?: boolean
  turnRootTaskId?: string
}

function fixture(options: FixtureOptions = {}) {
  const calls: Array<[string, unknown[]?]> = []
  const parent = {
    id: fence.id, userId: fence.userId, sessionId: fence.sessionId, turnId: fence.turnId, rootTaskId: fence.rootTaskId,
    parentTaskId: "root-1", path: "/root-1/parent-1", depth: 1, role: "scout", taskType: "research",
    status: "running", goal: "inspect", constraints: [], successCriteria: [], allowedActions: ["jobs.search"],
    context: {}, expectedOutputSchema: {}, result: null, failureReason: null, attemptCount: fence.attemptCount,
    maxAttempts: parentPolicy.maxAttempts, leaseOwner: fence.ownerId, leaseExpiresAt: new Date("2099-01-01T00:00:00Z"),
    interruptRequestedAt: null, budgetSnapshot: { subagentPolicy: parentPolicy }, toolPolicySnapshot: {}, modelProfileSnapshot: {},
    ...options.parent,
  }
  const root = {
    id: fence.rootTaskId, rootTaskId: fence.rootTaskId, turnId: fence.turnId, parentTaskId: null,
    status: "running", interruptRequestedAt: null, ...options.root,
  }
  let inserted: Record<string, unknown> | null = null
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      if (sql.startsWith('SELECT "id", "status" FROM "agent_sessions"')) return {
        rows: options.missingSession ? [] : [{ id: fence.sessionId, status: "running" }], rowCount: options.missingSession ? 0 : 1,
      }
      if (sql.includes('FROM "agent_turns"')) return {
        rows: options.missingTurn ? [] : [{ id: fence.turnId, rootTaskId: options.turnRootTaskId ?? fence.rootTaskId }],
        rowCount: options.missingTurn ? 0 : 1,
      }
      if (sql.startsWith('SELECT "rootTaskId"')) return { rows: [{ rootTaskId: parent.rootTaskId, turnId: parent.turnId }], rowCount: 1 }
      if (sql.includes('SELECT "id", "rootTaskId", "turnId", "parentTaskId"')) return { rows: [root], rowCount: 1 }
      if (sql === SELECT_TASK) {
        const replay = options.replayTask ?? (inserted ? {
          ...inserted, userId: fence.userId, status: "queued", attemptCount: 0, leaseOwner: null,
          leaseExpiresAt: null, interruptRequestedAt: null, result: null, failureReason: null,
        } : null)
        return { rows: replay ? [replay] : [], rowCount: replay ? 1 : 0 }
      }
      if (sql.startsWith('SELECT root."id"')) return { rows: [root], rowCount: 1 }
      if (sql.includes('SELECT task.*, session."userId"')) return { rows: [parent], rowCount: 1 }
      if (sql.includes("> clock_timestamp()")) return { rows: [{ leaseLive: options.live ?? true }], rowCount: 1 }
      if (sql.startsWith('SELECT "payload" FROM "agent_outbox"')) return {
        rows: options.existing ? [{ payload: options.existing }] : [], rowCount: options.existing ? 1 : 0,
      }
      if (sql.startsWith('SELECT session."id" FROM "agent_sessions"')) return { rows: [{ id: fence.sessionId }], rowCount: 1 }
      if (sql.includes('SELECT root."allowedActions"')) return { rows: [], rowCount: 0 }
      if (sql.startsWith('SELECT "id", "rootTaskId", "path"')) return { rows: [parent], rowCount: 1 }
      if (sql.includes("COUNT(*)")) return { rows: [{ count: options.activeChildren ?? 0 }], rowCount: 1 }
      if (sql.startsWith('INSERT INTO "sub_agent_tasks"')) {
        const values = params ?? []
        inserted = {
          id: values[0], sessionId: values[1], turnId: values[2], rootTaskId: values[3], parentTaskId: values[4],
          path: values[5], depth: values[6], role: values[7], taskType: values[8], goal: values[9],
          constraints: JSON.parse(String(values[10])), successCriteria: JSON.parse(String(values[11])),
          allowedActions: JSON.parse(String(values[12])), context: JSON.parse(String(values[13])),
          expectedOutputSchema: JSON.parse(String(values[14])), modelProfileSnapshot: JSON.parse(String(values[15])),
          toolPolicySnapshot: JSON.parse(String(values[16])), budgetSnapshot: JSON.parse(String(values[17])),
          maxAttempts: values[18],
        }
        return { rows: [{ id: values[0] }], rowCount: 1 }
      }
      if (sql.startsWith('INSERT INTO "agent_outbox"')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
  return { calls, inserted: () => inserted, pool: { connect: async () => client } as unknown as PgSubagentPool }
}

describe("lease-scoped atomic subagent creation", () => {
  it("locks Session, Turn, Root and parent before atomically creating a child and both outboxes", async () => {
    const state = fixture()
    const result = await createSubagentWithSpawnFromLease(state.pool, input)
    expect(result).toMatchObject({ duplicate: false, task: { userId: fence.userId, rootTaskId: fence.rootTaskId, parentTaskId: fence.id, depth: 2 } })
    expect(state.inserted()?.budgetSnapshot).toEqual({ subagentPolicy: { ...parentPolicy, maxDepth: 2 } })
    expect(state.inserted()?.path).toMatch(/^\/root-1\/parent-1\/subagent-/)
    const names = state.calls.map(([sql]) => sql)
    const session = names.findIndex(sql => sql.startsWith('SELECT "id", "status" FROM "agent_sessions"'))
    const turn = names.findIndex(sql => sql.includes('FROM "agent_turns"'))
    const root = names.findIndex(sql => sql.includes('SELECT "id", "rootTaskId", "turnId", "parentTaskId"'))
    const parent = names.findIndex(sql => sql.includes('SELECT task.*, session."userId"'))
    const replay = names.findIndex(sql => sql.startsWith('SELECT "payload" FROM "agent_outbox"'))
    const insert = names.findIndex(sql => sql.startsWith('INSERT INTO "sub_agent_tasks"'))
    expect(session).toBeLessThan(turn)
    expect(turn).toBeLessThan(root)
    expect(root).toBeLessThan(parent)
    expect(parent).toBeLessThan(replay)
    expect(replay).toBeLessThan(insert)
    expect(names.filter(sql => sql.startsWith('INSERT INTO "agent_outbox"'))).toHaveLength(2)
    expect(names).toContain("COMMIT")
  })

  it("replays only a child bound to the current parent execution scope", async () => {
    const replayTask = {
      id: "child-existing", userId: fence.userId, sessionId: fence.sessionId, turnId: fence.turnId,
      rootTaskId: fence.rootTaskId, parentTaskId: fence.id, path: "/root-1/parent-1/child-existing", depth: 2,
      role: "scout", taskType: "research", status: "queued", goal: "inspect", attemptCount: 0,
      maxAttempts: 2, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null,
      budgetSnapshot: {}, toolPolicySnapshot: {},
    }
    const state = fixture({ existing: { taskId: "child-existing" }, replayTask })
    await expect(createSubagentWithSpawnFromLease(state.pool, input)).resolves.toEqual({ task: expect.objectContaining({ id: "child-existing" }), duplicate: true })
    expect(state.calls.some(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
    expect(state.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  it.each([
    ["reclaimed owner", { parent: { leaseOwner: "new-owner" } }],
    ["stale attempt", { parent: { attemptCount: 3 } }],
    ["terminal parent", { parent: { status: "completed" } }],
    ["interrupted parent", { parent: { interruptRequestedAt: new Date() } }],
    ["expired parent", { live: false }],
  ])("rejects a %s before idempotent replay", async (_label, options) => {
    const state = fixture({ ...options, existing: { taskId: "child-existing" } })
    await expect(createSubagentWithSpawnFromLease(state.pool, input)).rejects.toMatchObject({ code: "lost" })
    expect(state.calls.some(([sql]) => sql.startsWith('SELECT "payload" FROM "agent_outbox"'))).toBe(false)
    expect(state.calls.some(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
    expect(state.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
    expect(state.calls.map(([sql]) => sql)).toContain("ROLLBACK")
  })

  it("rejects a Turn bound to another root before replay", async () => {
    const state = fixture({ turnRootTaskId: "other-root", existing: { taskId: "child-existing" } })
    await expect(createSubagentWithSpawnFromLease(state.pool, input)).rejects.toMatchObject({ code: "lost" })
    expect(state.calls.some(([sql]) => sql.startsWith('SELECT "payload" FROM "agent_outbox"'))).toBe(false)
  })

  it("rejects a replay key bound to another child branch", async () => {
    const state = fixture({
      existing: { taskId: "other-child" },
      replayTask: {
        id: "other-child", userId: fence.userId, sessionId: fence.sessionId, turnId: fence.turnId,
        rootTaskId: fence.rootTaskId, parentTaskId: "another-parent", path: "/root-1/another-parent/child",
        depth: 2, role: "scout", taskType: "research", status: "queued", goal: "inspect",
        attemptCount: 0, maxAttempts: 2, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null,
      },
    })
    await expect(createSubagentWithSpawnFromLease(state.pool, input)).rejects.toMatchObject({ code: "lost" })
    expect(state.calls.some(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
    expect(state.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  it("maps unavailable session and Turn scope to a lost execution fence", async () => {
    await expect(createSubagentWithSpawnFromLease(fixture({ missingSession: true }).pool, input)).rejects.toMatchObject({ code: "lost" })
    await expect(createSubagentWithSpawnFromLease(fixture({ missingTurn: true }).pool, input)).rejects.toMatchObject({ code: "lost" })
  })
})
