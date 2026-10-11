import { describe, expect, it, vi } from "vitest"

import type { DurableWaitControlInvocation } from "../tools/coordination-types.js"
import { createPgDurableWaitControlReader } from "./durable-wait-control-reader.js"

type Row = Record<string, unknown>
type Reply = { rows: Row[] }
const now = new Date("2026-10-11T12:00:00.000Z")
const base: DurableWaitControlInvocation = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", stepId: "step-1", taskId: "root-1", rootTaskId: "root-1",
  ownerId: "worker-1", leaseVersion: 4, now, targetTaskIds: ["child-1"], mode: "all", timeoutMs: 10_000, idempotencyKey: "wait-key",
}

function fakePool(options: { foreignTarget?: boolean; waitStatus?: string } = {}) {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, params: readonly unknown[] = []): Promise<Reply> => {
      calls.push({ sql, params })
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim()) || sql.includes("set_config")) return { rows: [] }
      if (sql.includes('FROM "agent_sessions"') && sql.includes('SELECT "id"')) return { rows: [{ id: "session-1" }] }
      if (sql.includes('FROM "agent_turns"')) return { rows: [{ rootTaskId: "root-1" }] }
      if (sql.includes('FROM "agent_steps"')) return { rows: [{ taskId: "root-1" }] }
      if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes('WHERE task."id" = $1')) {
        return { rows: [{ id: "root-1", rootTaskId: null, turnId: "turn-1", status: "running" }] }
      }
      if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("ANY($1::text[])")) {
        return { rows: [{ id: "child-1", rootTaskId: options.foreignTarget ? "other-root" : "root-1", turnId: "turn-1" }] }
      }
      if (sql.includes('FROM "agent_wait_conditions"')) return { rows: [{
        id: "wait-00000000-0000-4000-8000-000000000001", idempotencyKey: "wait-key", targetTaskIds: ["child-1"], mode: "all",
        status: options.waitStatus ?? "waiting", request: { targetTaskIds: ["child-1"], mode: "all", timeoutMs: 10_000 },
      }] }
      throw new Error("unexpected_query")
    }),
    release: vi.fn(),
  }
  return { calls, client, pool: { connect: vi.fn(async () => client) } }
}

describe("read-only durable wait control lookup", () => {
  it("uses the injected exact replay matcher inside a fenced read-only snapshot and returns only control", async () => {
    const db = fakePool()
    const matcher = vi.fn((row: Row, input: DurableWaitControlInvocation) => {
      expect(row.result).toEqual({ request: { targetTaskIds: ["child-1"], mode: "all", timeoutMs: 10_000 } })
      const request = row.request
      if (!request || typeof request !== "object" || Array.isArray(request)) return false
      const requestRow = request as Record<string, unknown>
      return row.idempotencyKey === input.idempotencyKey
        && JSON.stringify(requestRow.targetTaskIds) === JSON.stringify(input.targetTaskIds)
        && requestRow.mode === input.mode && requestRow.timeoutMs === input.timeoutMs
    })
    const result = await createPgDurableWaitControlReader(db.pool as never, matcher).readByInvocation(base)

    expect(result).toEqual({ waitId: "wait-00000000-0000-4000-8000-000000000001", status: "waiting" })
    expect(Object.keys(result ?? {}).sort()).toEqual(["status", "waitId"])
    expect(matcher).toHaveBeenCalledTimes(1)
    expect(db.calls[0]?.sql).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    expect(db.calls.some(call => call.sql.includes("set_config('app.user_id', $1, true)") && call.params[0] === base.userId)).toBe(true)
    const waitRead = db.calls.find(call => call.sql.includes('FROM "agent_wait_conditions"'))?.sql ?? ""
    expect(waitRead).toContain(`wait."result"->'request' AS "request"`)
    expect(waitRead).not.toContain('wait."result",')
    expect(db.calls.every(call => !/\bFOR\s+(UPDATE|SHARE)\b/i.test(call.sql))).toBe(true)
    expect(db.client.release).toHaveBeenCalledOnce()
  })

  it("fails closed on a target outside the current root and rejects malformed invocation before scoped reads", async () => {
    const foreign = fakePool({ foreignTarget: true })
    const matcher = vi.fn(() => true)
    await expect(createPgDurableWaitControlReader(foreign.pool as never, matcher).readByInvocation(base)).resolves.toBeNull()
    expect(matcher).not.toHaveBeenCalled()
    expect(foreign.calls.some(call => call.sql.includes('FROM "agent_wait_conditions"'))).toBe(false)

    const malformed = fakePool()
    const extra = { ...base, extra: "untrusted" } as DurableWaitControlInvocation
    await expect(createPgDurableWaitControlReader(malformed.pool as never, matcher).readByInvocation(extra)).resolves.toBeNull()
    expect(malformed.calls.some(call => call.sql.includes('FROM "agent_sessions" AS session'))).toBe(false)
  })

  it("returns an interrupted status only through the same fenced exact-invocation reader", async () => {
    const db = fakePool({ waitStatus: "interrupted" })
    const matcher = vi.fn(() => true)
    await expect(createPgDurableWaitControlReader(db.pool as never, matcher).readByInvocation(base))
      .resolves.toEqual({ waitId: "wait-00000000-0000-4000-8000-000000000001", status: "interrupted" })
    expect(matcher).toHaveBeenCalledOnce()
    expect(db.calls.some(call => call.sql.includes('FROM "agent_wait_conditions"'))).toBe(true)
  })
})
