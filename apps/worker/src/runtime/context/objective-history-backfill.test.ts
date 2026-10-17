import type pg from "pg"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { isValidRootObjectiveHistoryTerminalReceipt } from "./objective-history-projection.js"

const mockState = vi.hoisted(() => ({
  pending: new Set<string>(),
  outcomes: new Map<string, { kind: string; reason?: string; objectiveDigest?: string; canonicalOriginDigest?: string | null; semanticsVersion?: number }>(),
  snapshots: [] as unknown[],
  terminalSuccess: true,
  verificationErrorCode: null as string | null,
}))

vi.mock("./objective-history-projection.js", () => ({
  OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION: 1,
  isValidRootObjectiveHistoryTerminalReceipt: vi.fn(async () => mockState.terminalSuccess),
  projectRootObjectiveHistoryForBackfill: vi.fn(async (_client: unknown, identity: { turnId: string }, expected?: unknown) => {
    if (expected) mockState.snapshots.push(expected)
    const outcome = mockState.outcomes.get(identity.turnId) ?? {
      kind: "evaluated_indexable", objectiveDigest: "a".repeat(64), canonicalOriginDigest: null, semanticsVersion: 1,
    }
    if (outcome.kind === "evaluated_indexable" || outcome.kind === "evaluated_unindexable") mockState.pending.delete(identity.turnId)
    return outcome
  }),
  updateRootObjectiveHistoryProjection: vi.fn(async (_client: unknown, _identity: unknown, options?: { terminalEventId?: string }) =>
    options?.terminalEventId ? mockState.terminalSuccess : true),
}))

import { backfillObjectiveHistoryProjection } from "./objective-history-backfill.js"

type Candidate = { turnId: string; sessionId: string; userId: string; rootTaskId: string; inputJsonbText: string | null; source: string; goal: string; successCriteriaJsonbText: string | null }
type Response = { rows?: unknown[]; rowCount?: number }

function harness(rows: Candidate[], consistent = true, hasTerminalEvent = false, existingLocatorCount = 0) {
  mockState.pending = new Set(rows.map(row => row.turnId))
  mockState.outcomes.clear()
  const calls: { sql: string; values?: unknown[] }[] = []
  const query = vi.fn(async (sql: string, values?: unknown[]): Promise<Response> => {
    calls.push({ sql, values })
    if (sql.includes('"agent_objective_history_index_readiness"')) return { rowCount: 1 }
    if (sql.includes('pg_advisory_')) return { rows: [{ locked: true }], rowCount: 1 }
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: 1 }
    if (sql.startsWith("SET ") || sql.includes("set_config")) return { rows: [{ set_config: "20000ms" }], rowCount: 1 }
    if (sql.includes('AS "consistent"')) {
      if (mockState.verificationErrorCode) throw Object.assign(new Error("verification aborted"), { code: mockState.verificationErrorCode })
      return { rows: [{ consistent }], rowCount: 1 }
    }
    if (sql.includes('JOIN LATERAL') && sql.includes('terminalEventId')) {
      const cursor = values?.[0], limit = Number(values?.[2] ?? 100)
      const page = Array.from({ length: existingLocatorCount }, (_, index) => candidate(String(index).padStart(3, "0")))
        .filter(row => cursor === null || row.turnId > String(cursor)).slice(0, limit)
        .map(row => ({ ...row, terminalEventId: "persisted-" + row.turnId }))
      return { rows: page, rowCount: page.length }
    }
    if (sql.includes('SELECT turn."id" AS "turnId"')) {
      const limit = Number(values?.[2] ?? 100), cursor = values?.[1]
      const page = rows.filter(row => mockState.pending.has(row.turnId) && (cursor === null || row.turnId > String(cursor))).slice(0, limit)
      return { rows: page, rowCount: page.length }
    }
    if (sql.includes('AS "pending"')) return { rows: [{ pending: mockState.pending.size > 0 }], rowCount: 1 }
    if (sql.includes('FROM "agent_events"')) return { rows: hasTerminalEvent ? [{ id: "terminal-event" }] : [], rowCount: hasTerminalEvent ? 1 : 0 }
    throw new Error("unexpected SQL in backfill harness")
  })
  const client = { query, release: vi.fn() } as unknown as pg.PoolClient
  const pool = { connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">
  return { pool, calls, query }
}

function candidate(turnId: string): Candidate {
  return { turnId, sessionId: "session-1", userId: "user-1", rootTaskId: "root-" + turnId,
    inputJsonbText: '{"goal":"Find roles"}', source: "user", goal: "Find roles", successCriteriaJsonbText: '["Use EU filters"]' }
}

describe("objective history backfill bounds", () => {
  beforeEach(() => {
    mockState.pending.clear(); mockState.outcomes.clear(); mockState.terminalSuccess = true; mockState.verificationErrorCode = null
    mockState.snapshots = []
    vi.mocked(isValidRootObjectiveHistoryTerminalReceipt).mockClear()
  })

  it("caps a transaction at 100 Turns and stops at the fixed invocation batch limit", async () => {
    const h = harness(Array.from({ length: 101 }, (_, index) => candidate(String(index).padStart(3, "0"))))

    const report = await backfillObjectiveHistoryProjection(h.pool, { batchSize: 500, maxBatches: 1 })

    expect(report).toMatchObject({ batches: 1, evaluated: 100, capped: true, ready: false, transactions: 2, workTransactions: 1, verificationBatches: 0 })
    expect(h.calls.find(call => call.sql.includes('SELECT turn."id" AS "turnId"'))?.values?.[2]).toBe(100)
    expect(h.calls.filter(call => call.sql === "BEGIN")).toHaveLength(2)
  })

  it("passes raw JSONB text snapshots unchanged to projection CAS", async () => {
    const row = { ...candidate("raw-json"), inputJsonbText: '{"ignoredNumeric":9007199254740993}' }
    const h = harness([row])

    const report = await backfillObjectiveHistoryProjection(h.pool)

    expect(report).toMatchObject({ conflicts: 0, evaluated: 1, ready: true })
    expect(mockState.snapshots).toEqual([row])
    const candidateQuery = h.calls.find(call => call.sql.includes('SELECT turn."id" AS "turnId"'))?.sql
    expect(candidateQuery).toContain('turn."input"::text AS "inputJsonbText"')
    expect(candidateQuery).toContain('root."successCriteria"::text AS "successCriteriaJsonbText"')
  })

  it("resumes after committed batches and reaches readiness only after consistency passes", async () => {
    const rows = [candidate("a"), candidate("b"), candidate("c")]
    const first = harness(rows)
    await expect(backfillObjectiveHistoryProjection(first.pool, { batchSize: 1, maxBatches: 2 })).resolves.toMatchObject({
      batches: 2, evaluated: 2, capped: true, ready: false,
    })

    const resumed = await backfillObjectiveHistoryProjection(first.pool, { batchSize: 1, maxBatches: 2 })
    expect(resumed).toMatchObject({ batches: 1, evaluated: 1, capped: false, verificationFailed: false, ready: true,
      transactions: 3, workTransactions: 2, verificationBatches: 1 })
    expect(first.calls.filter(call => call.sql.includes('"isReady" = $1')).map(call => call.values?.[0])).toEqual([false, false, true])
    const finalVerifierBegin = first.calls.map(call => call.sql).lastIndexOf("BEGIN")
    const isolation = first.calls.findIndex(call => call.sql === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
    const statementTimeout = first.calls.findIndex(call => call.sql === "SET LOCAL statement_timeout = '20000ms'")
    const readyWrite = first.calls.findIndex(call => call.sql.includes('"isReady" = $1') && call.values?.[0] === true)
    expect(isolation).toBeGreaterThan(finalVerifierBegin)
    expect(statementTimeout).toBeGreaterThan(isolation)
    expect(statementTimeout).toBeLessThan(readyWrite)
    expect(readyWrite).toBeLessThan(first.calls.map(call => call.sql).lastIndexOf("COMMIT"))
  })

  it("validates every persisted locator in bounded pages inside one final verification transaction", async () => {
    const h = harness([candidate("candidate")], true, false, 101)

    const report = await backfillObjectiveHistoryProjection(h.pool, { maxBatches: 2 })

    expect(report).toMatchObject({ batches: 1, verificationBatches: 1, workTransactions: 2, ready: true })
    expect(vi.mocked(isValidRootObjectiveHistoryTerminalReceipt)).toHaveBeenCalledTimes(101)
    expect(h.calls.filter(call => call.sql === "BEGIN")).toHaveLength(3)
  })

  it("shares maxBatches with one final verifier transaction and defers readiness when the budget is full", async () => {
    const h = harness([candidate("a")])
    const first = await backfillObjectiveHistoryProjection(h.pool, { maxBatches: 1 })
    expect(first).toMatchObject({ batches: 1, verificationBatches: 0, transactions: 2, workTransactions: 1, capped: true, ready: false })

    const resumed = await backfillObjectiveHistoryProjection(h.pool, { maxBatches: 1 })
    expect(resumed).toMatchObject({ batches: 0, verificationBatches: 1, transactions: 2, workTransactions: 1, verificationComplete: true, ready: true })
    expect(h.calls.filter(call => call.sql === "BEGIN")).toHaveLength(4)
  })

  it("leaves readiness false when the full consistency pass finds a mismatch", async () => {
    const h = harness([candidate("a")], false)

    const report = await backfillObjectiveHistoryProjection(h.pool)

    expect(report).toMatchObject({ evaluated: 1, verificationFailed: true, ready: false })
    expect(h.calls.filter(call => call.sql.includes('"isReady" = $1')).map(call => call.values?.[0])).toEqual([false])
  })

  it("keeps retryable conflicts pending for the next invocation", async () => {
    const row = candidate("stale")
    const h = harness([row])
    mockState.outcomes.set("stale", { kind: "retryable_conflict", reason: "persisted_input_changed" })

    const report = await backfillObjectiveHistoryProjection(h.pool)

    expect(report).toMatchObject({ evaluated: 0, conflicts: 1, ready: false })
    expect(mockState.pending.has("stale")).toBe(true)
  })

  it("does not let a terminal-ineligible receipt pass readiness verification", async () => {
    const h = harness([candidate("invalid-terminal")], true, true)
    mockState.terminalSuccess = false

    const report = await backfillObjectiveHistoryProjection(h.pool)

    expect(report).toMatchObject({ evaluated: 1, terminalIneligible: 1, verificationFailed: true, ready: false })
    expect(h.calls.filter(call => call.sql.includes('"isReady" = $1')).map(call => call.values?.[0])).toEqual([false])
  })

  it("rolls back readiness when a pre-existing locator fails the shared receipt validator", async () => {
    const h = harness([candidate("a")], true, false, 1)
    mockState.terminalSuccess = false

    const report = await backfillObjectiveHistoryProjection(h.pool)

    expect(report).toMatchObject({ verificationComplete: true, verificationFailed: true, ready: false })
    expect(h.calls.filter(call => call.sql.includes('"isReady" = $1')).map(call => call.values?.[0])).toEqual([false])
    expect(h.calls.filter(call => call.sql === "ROLLBACK")).toHaveLength(1)
    expect(h.calls.filter(call => call.sql === "BEGIN")).toHaveLength(3)
  })

  it.each(["57014", "40001", "40P01"])("fails closed and rolls back on verifier abort %s", async code => {
    const h = harness([candidate("a")])
    mockState.verificationErrorCode = code

    const report = await backfillObjectiveHistoryProjection(h.pool)

    expect(report).toMatchObject({ verificationBatches: 1, transactions: 3, workTransactions: 2, verificationComplete: false, verificationFailed: true, ready: false })
    expect(h.calls.filter(call => call.sql === "ROLLBACK")).toHaveLength(1)
    expect(h.calls.filter(call => call.sql.includes('"isReady" = $1')).map(call => call.values?.[0])).toEqual([false])
    expect(h.calls.filter(call => call.sql === "BEGIN")).toHaveLength(3)
  })
})
