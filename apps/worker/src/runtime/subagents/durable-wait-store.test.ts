import { describe, expect, it, vi } from "vitest"

import { createPgDurableWaitPort, DurableWaitStoreError, type DurableWaitResolveInput } from "./durable-wait-store.js"
import type { DurableWaitPort } from "../tools/coordination-types.js"

type Row = Record<string, unknown>
type Response = { rows: Row[]; rowCount?: number }
const now = new Date("2026-09-09T12:00:00.000Z")
const base: Parameters<DurableWaitPort["wait"]>[0] = {
  userId: "user-a", sessionId: "session-a", turnId: "turn-a", stepId: "step-a", taskId: "parent-a", rootTaskId: "root-a",
  targetTaskIds: ["child-a", "child-b"], mode: "all", timeoutMs: 10_000, idempotencyKey: "wait-key",
}

function parent(status = "running"): Row { return { id: "parent-a", rootTaskId: "root-a", turnId: "turn-a", sessionId: "session-a", status, userId: "user-a" } }
function turn(status = "in_progress"): Row { return { id: "turn-a", sessionId: "session-a", userId: "user-a", rootTaskId: "root-a", status } }
function step(taskId = "parent-a"): Row { return { id: "step-a", taskId } }
function targets(statuses: readonly string[], rootTaskId = "root-a"): Row[] { return statuses.map((status, index) => ({ id: `child-${String.fromCharCode(97 + index)}`, rootTaskId, turnId: "turn-a", sessionId: "session-a", status, userId: "user-a" })) }
function waitRow(status: string, matchedTaskIds: readonly string[] = [], options: { mode?: "any" | "all"; targetTaskIds?: readonly string[] } = {}): Row {
  const createdAt = new Date(now); const deadlineAt = new Date(now.getTime() + base.timeoutMs)
  const targetTaskIds = options.targetTaskIds ?? base.targetTaskIds
  const mode = options.mode ?? base.mode
  return { id: "wait-a", userId: "user-a", sessionId: "session-a", turnId: "turn-a", parentTaskId: "parent-a", stepId: "step-a", idempotencyKey: base.idempotencyKey,
    targetTaskIds: [...targetTaskIds], mode, status, deadlineAt, matchedTaskIds: [...matchedTaskIds], createdAt,
    result: { request: { targetTaskIds: [...targetTaskIds], mode, timeoutMs: base.timeoutMs } } }
}
function fixture(responses: Response[]) {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, params: readonly unknown[] = []): Promise<Response> => {
      calls.push({ sql, params })
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim()) || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      const response = responses.shift()
      if (!response) throw new Error(`Unexpected query: ${sql}`)
      return response
    }),
    release: vi.fn(),
  }
  return { calls, pool: { connect: vi.fn(async () => client) } }
}
function validation(targetRows: Row[], existing?: Row): Response[] {
  return [{ rows: [parent()] }, { rows: [turn()] }, { rows: [step()] }, { rows: targetRows }, ...(existing ? [{ rows: [existing] }] : [])]
}
function inserted(row: Row): Response { return { rows: [row] } }

describe("durable PostgreSQL wait port", () => {
  it("registers a first wait as waiting and sets the tenant inside the transaction", async () => {
    vi.setSystemTime(now)
    const row = waitRow("waiting")
    const test = fixture([...validation(targets(["running", "queued"])), { rows: [] }, inserted(row)])
    const result = await createPgDurableWaitPort(test.pool as never).wait(base)

    expect(result).toMatchObject({ waitId: "wait-a", status: "waiting", matchedTaskIds: [] })
    expect(test.calls.some(call => call.sql.includes("set_config('app.user_id'"))).toBe(true)
    expect(test.calls.some(call => call.sql.includes("ON CONFLICT"))).toBe(true)
    vi.useRealTimers()
  })

  it.each([
    ["any", ["completed", "running"], "ready", ["child-a"]],
    ["all", ["completed", "failed"], "ready", ["child-a", "child-b"]],
  ] as const)("computes %s readiness before registration", async (mode, statuses, expectedStatus, matched) => {
    vi.setSystemTime(now)
    const input = { ...base, mode, targetTaskIds: ["child-a", "child-b"] as const }
    const test = fixture([...validation(targets(statuses)), { rows: [] }, inserted(waitRow(expectedStatus, matched, { mode }))])
    await expect(createPgDurableWaitPort(test.pool as never).wait(input)).resolves.toMatchObject({ status: expectedStatus, matchedTaskIds: matched })
    vi.useRealTimers()
  })

  it("resolves a still-running wait as timed_out after its deadline", async () => {
    const test = fixture([
      { rows: [waitRow("waiting")] },
      { rows: targets(["running", "queued"]) },
      { rows: [waitRow("timed_out")] },
    ])
    const input: DurableWaitResolveInput = { userId: base.userId, sessionId: base.sessionId, waitId: "wait-a", now: new Date(now.getTime() + base.timeoutMs + 1) }
    await expect(createPgDurableWaitPort(test.pool as never).resolve(input)).resolves.toMatchObject({ status: "timed_out", matchedTaskIds: [] })
    expect(test.calls.some(call => call.sql.includes("FOR UPDATE SKIP LOCKED"))).toBe(true)
  })

  it("replays the same payload and rejects an idempotency conflict", async () => {
    const existing = waitRow("waiting")
    const replayTest = fixture([...validation(targets(["running", "queued"])), { rows: [existing] }])
    await expect(createPgDurableWaitPort(replayTest.pool as never).wait(base)).resolves.toMatchObject({ waitId: "wait-a", status: "waiting" })

    const conflict = fixture([...validation(targets(["running", "queued"])), { rows: [existing] }])
    await expect(createPgDurableWaitPort(conflict.pool as never).wait({ ...base, mode: "any" })).rejects.toMatchObject({ code: "wait_conflict" })
  })

  it("rejects duplicate, self, foreign target and cross-tree targets", async () => {
    await expect(createPgDurableWaitPort(fixture([]).pool as never).wait({ ...base, targetTaskIds: ["child-a", "child-a"] })).rejects.toMatchObject({ code: "wait_invalid" })
    await expect(createPgDurableWaitPort(fixture([]).pool as never).wait({ ...base, targetTaskIds: ["parent-a"] })).rejects.toMatchObject({ code: "wait_invalid" })

    const missing = fixture([...validation([])])
    await expect(createPgDurableWaitPort(missing.pool as never).wait(base)).rejects.toMatchObject({ code: "wait_scope_error" })
    const foreign = fixture([...validation(targets(["running", "queued"], "other-root"))])
    await expect(createPgDurableWaitPort(foreign.pool as never).wait(base)).rejects.toMatchObject({ code: "wait_scope_error" })
  })

  it("returns ready without consuming it and fences foreign resolution", async () => {
    const ready = waitRow("ready", ["child-a"])
    const readyTest = fixture([{ rows: [] }, { rows: [ready] }])
    await expect(createPgDurableWaitPort(readyTest.pool as never).resolve({ userId: base.userId, sessionId: base.sessionId, waitId: "wait-a" })).resolves.toMatchObject({ status: "ready", matchedTaskIds: ["child-a"] })
    expect(readyTest.calls.some(call => call.sql.includes("FOR UPDATE SKIP LOCKED"))).toBe(true)

    const foreignTest = fixture([{ rows: [] }, { rows: [] }])
    await expect(createPgDurableWaitPort(foreignTest.pool as never).resolve({ userId: "other-user", sessionId: base.sessionId, waitId: "wait-a" })).resolves.toBeNull()
    expect(foreignTest.calls.every(call => !call.sql.includes("UPDATE \"agent_wait_conditions\""))).toBe(true)
  })

  it("cancels only waits in the scoped task or its root tree", async () => {
    const test = fixture([{ rows: [{ id: "parent-a", rootTaskId: "root-a" }] }, { rows: [], rowCount: 1 }])
    await expect(createPgDurableWaitPort(test.pool as never).cancel?.({ userId: base.userId, sessionId: base.sessionId, taskId: "parent-a", reason: "interrupted" })).resolves.toBeUndefined()
    const update = test.calls.find(call => call.sql.includes("UPDATE \"agent_wait_conditions\""))
    expect(update?.sql).toContain('"status" IN (\'waiting\', \'ready\')')
    expect(update?.params).toContain("interrupted")

    const foreign = fixture([{ rows: [] }])
    await expect(createPgDurableWaitPort(foreign.pool as never).cancel?.({ userId: base.userId, sessionId: base.sessionId, taskId: "foreign", reason: "closed" })).rejects.toMatchObject({ code: "wait_scope_error" })
  })
})
