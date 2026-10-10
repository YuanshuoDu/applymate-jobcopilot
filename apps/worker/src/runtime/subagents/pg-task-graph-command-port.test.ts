import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.js"
import type { TaskGraphNativeCommandInput, TaskGraphScheduleInput } from "./task-graph-command-port.js"
import { taskGraphFingerprint, taskGraphItemId, taskGraphProposalKey, TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"
import type { PgSubagentPool } from "./types.js"

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number }
type QueryCall = { sql: string; values: readonly unknown[] }
type Fence = "session" | "turn" | "parent"

const empty: QueryResult = { rows: [], rowCount: 0 }

function scheduleInput(expectedRevision = 1): TaskGraphScheduleInput {
  return {
    scope: {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
      stepId: "step-1", turnLeaseOwner: "turn-owner", turnLeaseVersion: 3, parentLeaseOwner: "parent-owner", parentAttemptCount: 2,
    },
    proposal: {
      expectedRevision,
      nodes: [{ key: "planned", templateId: "analyst", goal: "Inspect the source", successCriteria: ["Evidence captured"], dependsOn: [] }],
    },
    templates: { analyst: { role: "analyst", taskType: "research", allowedActions: [] } },
  }
}

function fakePool(input: TaskGraphScheduleInput, options: { failFence?: Fence; includeReplay?: boolean; missingGraph?: boolean; persistedPlanReceipt?: boolean } = {}) {
  const calls: QueryCall[] = []
  const itemId = taskGraphItemId(input.scope.parentTaskId)
  const snapshot = {
    schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
    nodes: [{
      key: "planned", templateId: "analyst", goal: "Inspect the source", successCriteria: ["Evidence captured"],
      dependsOn: [], depth: 1, taskId: "child-1",
    }],
  }
  const replayPayload = {
    kind: "proposal",
    fingerprint: taskGraphFingerprint(input.proposal),
    receipt: { revision: 2, nodes: [{ key: "planned", taskId: "child-1", status: "queued" }], readyTaskIds: ["child-1"] },
  }
  const client = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []): Promise<QueryResult> => {
      calls.push({ sql, values })
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return empty
      if (sql.startsWith("SELECT set_config")) return empty
      if (sql.startsWith('SELECT "id" FROM "agent_sessions"')) {
        return options.failFence === "session" ? empty : { rows: [{ id: input.scope.sessionId }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT session."id" FROM "agent_sessions"')) {
        return { rows: [{ id: input.scope.sessionId }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT "id" FROM "agent_turns"')) {
        return options.failFence === "turn" ? empty : { rows: [{ id: input.scope.turnId }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT task.*, session."userId" AS "userId"')) {
        return options.failFence === "parent" ? empty : { rows: [{ id: input.scope.parentTaskId, budgetSnapshot: {} }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT "id" FROM "agent_steps"')) {
        return { rows: [{ id: input.scope.stepId }], rowCount: 1 }
      }
      if (sql.startsWith("WITH wall_clock AS MATERIALIZED")) {
        return { rows: [{ turnLeaseValid: true, parentLeaseValid: true }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT item."id"')) return options.missingGraph
        ? empty
        : { rows: [{ id: itemId, revision: 2, content: snapshot, createdAt: new Date("2026-09-20T12:00:00.000Z") }], rowCount: 1 }
      if (sql.startsWith('SELECT task."id", task."status"')) {
        return { rows: [{ id: "child-1", status: "queued", failureReason: null, result: null }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT event."payload"')) {
        if (values.length === 5 && options.includeReplay !== false) return { rows: [{ payload: replayPayload }], rowCount: 1 }
        return empty
      }
      if (sql.startsWith("SELECT EXISTS (") && sql.includes('FROM "agent_items"')) {
        return { rows: [{ exists: options.missingGraph !== true }], rowCount: 1 }
      }
      if (sql.startsWith("SELECT EXISTS (")) return { rows: [{ exists: options.persistedPlanReceipt === true }], rowCount: 1 }
      return empty
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as PgSubagentPool
  return { pool, calls, client }
}

describe("createPgTaskGraphCommandPort", () => {
  it("keeps a missing graph pristine when no durable proposal receipt exists", async () => {
    const input = scheduleInput()
    const fake = fakePool(input, { missingGraph: true })
    const { stepId: _stepId, ...scope } = input.scope

    await expect(createPgTaskGraphCommandPort(fake.pool).readCurrent(scope)).resolves.toEqual({ revision: 0, nodes: [] })
    expect(fake.calls.some(call => call.sql.startsWith("SELECT EXISTS ("))).toBe(true)
  })

  it("reloads graph state through the caller-owned client without opening another transaction", async () => {
    const input = scheduleInput()
    const fake = fakePool(input, { includeReplay: false })
    const { stepId: _stepId, ...scope } = input.scope
    const port = createPgTaskGraphCommandPort(fake.pool)

    await expect(port.readCurrentWithClient!(fake.client as unknown as pg.PoolClient, scope)).resolves.toMatchObject({ revision: 2 })
    expect(fake.pool.connect).not.toHaveBeenCalled()
    expect(fake.calls.some(call => ["BEGIN", "COMMIT", "ROLLBACK"].includes(call.sql))).toBe(false)
    expect(fake.calls.find(call => call.sql.startsWith("SELECT set_config"))?.values).toEqual([input.scope.userId])
    expect(fake.calls.some(call => call.sql.startsWith('SELECT "id" FROM "agent_sessions"'))).toBe(true)
    expect(fake.calls.some(call => call.sql.startsWith('SELECT item."id"'))).toBe(true)
  })

  it("fails closed when the graph item is missing after a durable proposal receipt", async () => {
    const input = scheduleInput()
    const fake = fakePool(input, { missingGraph: true, persistedPlanReceipt: true })
    const { stepId: _stepId, ...scope } = input.scope

    await expect(createPgTaskGraphCommandPort(fake.pool).readCurrent(scope)).rejects.toMatchObject({
      name: "TaskGraphCommandError", code: "task_graph_state_missing", message: "Persisted TaskGraph state is unavailable",
    })
    const receiptQuery = fake.calls.find(call => call.sql.startsWith("SELECT EXISTS ("))
    expect(receiptQuery?.values).toEqual([input.scope.sessionId, input.scope.turnId, taskGraphItemId(input.scope.parentTaskId), input.scope.userId])
  })

  it("replays the original duplicate receipt when the graph item is missing", async () => {
    const input = scheduleInput()
    const fake = fakePool(input, { missingGraph: true, persistedPlanReceipt: true })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndSchedule(input)).resolves.toEqual({
      status: "duplicate", revision: 2, nodes: [{ key: "planned", taskId: "child-1", status: "queued" }], readyTaskIds: ["child-1"],
    })
    const replay = fake.calls.find(call => call.sql.includes('event."idempotencyKey" = $4'))
    expect(replay?.values).toEqual([
      input.scope.sessionId, input.scope.turnId, taskGraphItemId(input.scope.parentTaskId),
      taskGraphProposalKey(input.scope.parentTaskId, input.proposal.expectedRevision), input.scope.userId,
    ])
    expect(fake.calls.some(call => call.sql.startsWith("SELECT EXISTS ("))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "agent_items"'))).toBe(false)
  })

  it("rejects native replay when an owned event outlives its graph item", async () => {
    const input = scheduleInput()
    const native: TaskGraphNativeCommandInput = {
      scope: input.scope,
      request: { kind: "spawn", idempotencyKey: "native-missing", role: "auditor", taskType: "audit", goal: "Review" },
    }
    const fake = fakePool(input, { missingGraph: true, persistedPlanReceipt: true })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendNativeCoordination!(native)).rejects.toMatchObject({
      name: "TaskGraphCommandError", code: "task_graph_state_missing", message: "Persisted TaskGraph state is unavailable",
    })
    const ownedReceiptCheck = fake.calls.findIndex(call => call.sql.startsWith("SELECT EXISTS (") && call.sql.includes('FROM "agent_events"'))
    const graphItemCheck = fake.calls.findIndex(call => call.sql.startsWith("SELECT EXISTS (") && call.sql.includes('FROM "agent_items"'))
    expect(ownedReceiptCheck).toBeGreaterThan(-1)
    expect(graphItemCheck).toBeGreaterThan(ownedReceiptCheck)
    expect(fake.calls.some(call => call.sql.includes('event."idempotencyKey" = $4'))).toBe(false)
  })

  it("rejects a new proposal against a missing graph that has an older receipt", async () => {
    const input = scheduleInput(0)
    const fake = fakePool(input, { missingGraph: true, persistedPlanReceipt: true, includeReplay: false })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndSchedule(input)).rejects.toMatchObject({
      name: "TaskGraphCommandError", code: "task_graph_state_missing", message: "Persisted TaskGraph state is unavailable",
    })
    const receiptQuery = fake.calls.find(call => call.sql.startsWith("SELECT EXISTS ("))
    expect(receiptQuery?.values).toEqual([input.scope.sessionId, input.scope.turnId, taskGraphItemId(input.scope.parentTaskId), input.scope.userId])
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "agent_items"'))).toBe(false)
  })

  it("treats a pristine missing graph as revision zero for a first proposal", async () => {
    const input = scheduleInput(1)
    const fake = fakePool(input, { missingGraph: true, includeReplay: false })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndSchedule(input)).rejects.toMatchObject({
      name: "TaskGraphCommandError", code: "revision_mismatch", currentRevision: 0,
    })
    expect(fake.calls.some(call => call.sql.startsWith("SELECT EXISTS ("))).toBe(true)
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
  })

  it("returns the original receipt as a duplicate for an idempotent proposal replay", async () => {
    const input = scheduleInput()
    const fake = fakePool(input)
    const port = createPgTaskGraphCommandPort(fake.pool)

    await expect(port.appendAndSchedule(input)).resolves.toEqual({
      status: "duplicate", revision: 2, nodes: [{ key: "planned", taskId: "child-1", status: "queued" }], readyTaskIds: ["child-1"],
    })

    const replay = fake.calls.find(call => call.sql.includes('event."idempotencyKey" = $4'))
    expect(replay?.values).toEqual([
      input.scope.sessionId, input.scope.turnId, taskGraphItemId(input.scope.parentTaskId),
      taskGraphProposalKey(input.scope.parentTaskId, input.proposal.expectedRevision), input.scope.userId,
    ])
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
    expect(fake.client.release).toHaveBeenCalledOnce()
  })

  it("rejects a stale proposal with the current persisted revision", async () => {
    const input = scheduleInput(1)
    const fake = fakePool(input, { includeReplay: false })
    const port = createPgTaskGraphCommandPort(fake.pool)

    await expect(port.appendAndSchedule(input)).rejects.toMatchObject({
      name: "TaskGraphCommandError", code: "revision_mismatch", currentRevision: 2,
    })
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "agent_items"'))).toBe(false)
  })

  it.each([
    { fence: "session" as const, error: "task_graph_session_fenced", query: 'FROM "agent_sessions"', values: ["session-1", "user-1"] },
    { fence: "turn" as const, error: "task_graph_turn_fenced", query: 'FROM "agent_turns"', values: ["turn-1", "session-1", "user-1", "root-1", "turn-owner", 3] },
    { fence: "parent" as const, error: "task_graph_parent_fenced", query: 'FROM "sub_agent_tasks"', values: ["root-1", "session-1", "turn-1", "root-1", "user-1", "parent-owner", 2] },
  ])("rejects a mismatched $fence identity before reading or mutating the graph", async ({ fence, error, query, values }) => {
    const input = scheduleInput()
    const fake = fakePool(input, { failFence: fence })
    const port = createPgTaskGraphCommandPort(fake.pool)

    await expect(port.appendAndSchedule(input)).rejects.toThrow(error)
    const fencedCall = fake.calls.find(call => call.sql.includes(query))
    expect(fencedCall?.values).toEqual(values)
    expect(fake.calls.some(call => call.sql.startsWith('SELECT item."id"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
  })
})
