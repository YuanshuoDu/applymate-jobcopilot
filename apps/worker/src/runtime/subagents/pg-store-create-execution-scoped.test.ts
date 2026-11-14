import { describe, expect, it, vi } from "vitest"
import { createSubagentWithSpawnFromLease } from "./pg-store-create-execution-scoped.js"
import { NestedScoutBudgetPolicyError, normalizeSubagentPolicy, type AtomicSubagentSpawnFromLeaseInput, type PgSubagentPool } from "./types.js"
import { SELECT_TASK } from "./pg-store-persistence.js"
import { NESTED_SCOUT_PROFILE_MARKER } from "./nested-scout-profile.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"

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
  deadlineLive?: boolean
  rootDeadlineLive?: boolean
  stepLive?: boolean
  existing?: { taskId: string }
  replayTask?: Record<string, unknown>
  activeChildren?: number
  missingSession?: boolean
  missingTurn?: boolean
  omitRootBudgetSnapshot?: boolean
  nested?: boolean
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
    absoluteDeadlineAt: new Date("2099-01-01T00:00:00Z"),
    interruptRequestedAt: null, budgetSnapshot: { subagentPolicy: parentPolicy }, toolPolicySnapshot: {}, modelProfileSnapshot: {},
    ...(options.nested ? {
      role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search", "jobs.get", "jobs.discover", "tool_results.read", "wait_subagents", "scout.delegate", "scout.results"],
      context: { nestedScoutProfile: NESTED_SCOUT_PROFILE_MARKER },
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" },
    } : {}),
    ...options.parent,
  }
  const root: Record<string, unknown> = {
    id: fence.rootTaskId, rootTaskId: fence.rootTaskId, turnId: fence.turnId, parentTaskId: null,
    status: "running", interruptRequestedAt: null, absoluteDeadlineAt: new Date("2099-01-01T00:00:00Z"), budgetSnapshot: {}, ...options.root,
  }
  if (options.omitRootBudgetSnapshot) delete root.budgetSnapshot
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
      if (sql.includes('FROM "agent_events" AS event')) return { rows: [{ type: "item.started", itemId: "task-graph:root-1", taskId: "root-1",
        idempotencyKey: "proposal:0", payload: { kind: "proposal", receipt: { revision: 1,
          nodes: [{ key: "scout", taskId: fence.id, status: "queued" }], readyTaskIds: [fence.id] } } }], rowCount: 1 }
      if (sql.includes('SELECT task.*, session."userId"')) return { rows: [parent], rowCount: 1 }
      if (sql.includes("AS \"leaseLive\"")) return { rows: [{ leaseLive: options.live ?? true,
        deadlineLive: options.deadlineLive ?? true, rootDeadlineLive: options.rootDeadlineLive ?? true }], rowCount: 1 }
      if (sql.includes('FROM "agent_steps" AS step')) return { rows: options.stepLive === false ? [] : [{ id: "step-1" }], rowCount: options.stepLive === false ? 0 : 1 }
      if (sql.startsWith('SELECT "payload" FROM "agent_outbox"')) return {
        rows: options.existing ? [{ payload: options.existing }] : [], rowCount: options.existing ? 1 : 0,
      }
      if (sql.startsWith('SELECT session."id" FROM "agent_sessions"')) return { rows: [{ id: fence.sessionId }], rowCount: 1 }
      if (sql.includes('SELECT root."allowedActions"')) return { rows: [], rowCount: 0 }
      if (sql.startsWith('SELECT "id", "rootTaskId", "parentTaskId", "path"')) return { rows: [parent], rowCount: 1 }
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
          maxAttempts: values[18], absoluteDeadlineAt: new Date(Date.now() + 60 * 60 * 1000),
        }
        return { rows: [{ id: values[0] }], rowCount: 1 }
      }
      if (sql.startsWith('UPDATE "sub_agent_tasks" AS child')) {
        const childDeadline = inserted?.absoluteDeadlineAt as Date
        const parentDeadline = parent.absoluteDeadlineAt as Date | null
        const absoluteDeadlineAt = parentDeadline && parentDeadline < childDeadline ? parentDeadline : childDeadline
        return { rows: [{ absoluteDeadlineAt }], rowCount: 1 }
      }
      if (sql.startsWith('INSERT INTO "agent_outbox"')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
  return { calls, inserted: () => inserted, pool: { connect: async () => client } as unknown as PgSubagentPool }
}

const nestedInput: AtomicSubagentSpawnFromLeaseInput = {
  ...input,
  role: "scout", taskType: "job_discovery", goal: "Search assigned source",
  allowedActions: ["jobs.discover", "tool_results.read"],
  context: { nestedScoutSourceSlice: ["greenhouse"], nestedScoutQueryScope: [
    { source: "greenhouse", targetRoles: ["Software Engineer"], targetLocations: ["Dublin"], maxPageSize: 10 },
  ] },
  expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" },
  parentExecutionFence: { ...fence, step: { stepId: "step-1", toolCallId: "call-1" } },
}

describe("lease-scoped atomic subagent creation", () => {
  it("rejects private nested Scout scope without a source-step fence before replay", async () => {
    const state = fixture({ existing: { taskId: "child-existing" } })
    await expect(createSubagentWithSpawnFromLease(state.pool, {
      ...input, context: { nestedScoutSourceSlice: ["greenhouse"], nestedScoutQueryScope: [] },
    })).rejects.toMatchObject({ code: "lost" })
    expect(state.calls.some(([sql]) => sql.startsWith('SELECT "payload" FROM "agent_outbox"'))).toBe(false)
    expect(state.calls.some(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
  })

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

  it("admits nested Scouts when the locked root snapshot is default or has only shared step/tool limits", async () => {
    for (const budgetSnapshot of [{}, { limits: { maxSteps: 8, maxToolCalls: 16 } }]) {
      const state = fixture({ nested: true, root: { budgetSnapshot } })
      const result = await createSubagentWithSpawnFromLease(state.pool, nestedInput)
      expect(result).toMatchObject({ duplicate: false, task: { role: "scout", taskType: "job_discovery", depth: 2 } })
      const rootLock = state.calls.find(([sql]) => sql.includes('SELECT "id", "rootTaskId", "turnId", "parentTaskId"'))
      expect(rootLock?.[0]).toContain('"budgetSnapshot"')
      expect(rootLock?.[1]).toEqual([fence.rootTaskId, fence.sessionId])
    }
  })

  it.each([
    ["maxInputTokens", 0], ["maxOutputTokens", 0], ["maxCostUsd", 0],
  ] as const)("rejects nested admission with root %s cap before replay or writes", async (key, limit) => {
    const state = fixture({ nested: true, root: { budgetSnapshot: { limits: { [key]: limit } } }, existing: { taskId: "child-existing" } })
    await expect(createSubagentWithSpawnFromLease(state.pool, nestedInput)).rejects.toBeInstanceOf(NestedScoutBudgetPolicyError)
    expect(state.calls.some(([sql]) => sql.startsWith('SELECT "payload" FROM "agent_outbox"'))).toBe(false)
    expect(state.calls.some(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
    expect(state.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  it("uses canonical parsing for malformed cap values and allows an exact no-cap nested replay", async () => {
    const replayTask = {
      id: "child-existing", userId: fence.userId, sessionId: fence.sessionId, turnId: fence.turnId,
      rootTaskId: fence.rootTaskId, parentTaskId: fence.id, path: "/root-1/parent-1/child-existing", depth: 2,
      role: "scout", taskType: "job_discovery", status: "queued", goal: nestedInput.goal, attemptCount: 0,
      maxAttempts: 2, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null,
      budgetSnapshot: {}, toolPolicySnapshot: {},
    }
    const malformed = fixture({ nested: true, root: { budgetSnapshot: { limits: {
      maxInputTokens: "100", maxOutputTokens: -1, maxCostUsd: null,
    } } }, existing: { taskId: "child-existing" }, replayTask })
    await expect(createSubagentWithSpawnFromLease(malformed.pool, nestedInput)).resolves.toMatchObject({ duplicate: true })
    expect(malformed.calls.some(([sql]) => sql.startsWith('SELECT "payload" FROM "agent_outbox"'))).toBe(true)
    expect(malformed.calls.some(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
  })

  it("fails closed when the locked root row has no budget snapshot field", async () => {
    const state = fixture({ nested: true, omitRootBudgetSnapshot: true, existing: { taskId: "child-existing" } })
    await expect(createSubagentWithSpawnFromLease(state.pool, nestedInput)).rejects.toMatchObject({ code: "lost" })
    expect(state.calls.some(([sql]) => sql.startsWith('SELECT "payload" FROM "agent_outbox"'))).toBe(false)
    expect(state.calls.some(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
  })

  it("checks tenant and current-step fences before a root budget denial", async () => {
    const cases: FixtureOptions[] = [
      { missingSession: true, root: { budgetSnapshot: { limits: { maxCostUsd: 0 } } } },
      { stepLive: false, root: { budgetSnapshot: { limits: { maxCostUsd: 0 } } } },
    ]
    for (const options of cases) {
      const state = fixture({ nested: true, ...options })
      await expect(createSubagentWithSpawnFromLease(state.pool, nestedInput)).rejects.toMatchObject({ code: "lost" })
      expect(state.calls.some(([sql]) => sql.startsWith('SELECT "payload" FROM "agent_outbox"'))).toBe(false)
      expect(state.calls.some(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
      if (options.stepLive === false) {
        const step = state.calls.findIndex(([sql]) => sql.includes('FROM "agent_steps" AS step'))
        const root = state.calls.findIndex(([sql]) => sql.includes('SELECT "id", "rootTaskId", "turnId", "parentTaskId"'))
        expect(root).toBeGreaterThan(-1)
        expect(step).toBeGreaterThan(root)
      }
    }
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
    expect(state.calls.some(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks" AS child'))).toBe(false)
  })

  it("checks the exact live Scout delegate call before idempotent replay", async () => {
    const stepInput: AtomicSubagentSpawnFromLeaseInput = {
      ...input, parentExecutionFence: { ...fence, step: { stepId: "step-1", toolCallId: "call-1" } },
    }
    const state = fixture({ existing: { taskId: "child-existing" }, replayTask: {
      id: "child-existing", userId: fence.userId, sessionId: fence.sessionId, turnId: fence.turnId,
      rootTaskId: fence.rootTaskId, parentTaskId: fence.id, depth: 2, path: "/root-1/parent-1/child-existing",
      role: "scout", taskType: "research", status: "queued", goal: "inspect", attemptCount: 0,
      maxAttempts: 2, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null, budgetSnapshot: {},
      toolPolicySnapshot: {}, absoluteDeadlineAt: new Date("2099-01-01T00:00:00Z"),
    } })
    await expect(createSubagentWithSpawnFromLease(state.pool, stepInput)).resolves.toMatchObject({ duplicate: true })
    const stepCheck = state.calls.findIndex(([sql]) => sql.includes('FROM "agent_steps" AS step'))
    const replay = state.calls.findIndex(([sql]) => sql.startsWith('SELECT "payload" FROM "agent_outbox"'))
    expect(stepCheck).toBeGreaterThan(-1)
    expect(stepCheck).toBeLessThan(replay)
    expect(state.calls[stepCheck]?.[0]).toContain(`item."status" = 'started'`)
  })

  it("rejects a stale in-flight call and expired parent deadline before replay or insertion", async () => {
    const stepInput: AtomicSubagentSpawnFromLeaseInput = {
      ...input, parentExecutionFence: { ...fence, step: { stepId: "step-1", toolCallId: "call-1" } },
    }
    for (const options of [{ stepLive: false }, { deadlineLive: false }, { rootDeadlineLive: false }]) {
      const state = fixture({ ...options, existing: { taskId: "child-existing" } })
      await expect(createSubagentWithSpawnFromLease(state.pool, stepInput)).rejects.toMatchObject({ code: "lost" })
      expect(state.calls.some(([sql]) => sql.startsWith('SELECT "payload" FROM "agent_outbox"'))).toBe(false)
      expect(state.calls.some(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
      expect(state.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
    }
  })

  it("sets a DB-created child deadline and clamps it to the parent's deadline", async () => {
    const parentDeadline = new Date(Date.now() + 5 * 60 * 1000)
    const state = fixture({ parent: { absoluteDeadlineAt: parentDeadline } })
    const result = await createSubagentWithSpawnFromLease(state.pool, input)
    if (!result.task) throw new Error("Expected a nested child task")
    expect(result.task.absoluteDeadlineAt).toEqual(parentDeadline)
    const insert = state.calls.find(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))
    expect(insert?.[1]?.[19]).toBe(true)
    expect(state.calls.some(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks" AS child')
      && sql.includes('LEAST(child."absoluteDeadlineAt"'))).toBe(true)
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
