import type { PoolClient } from "pg"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildAgentSourceMaterialFenceKey } from "@jobcopilot/shared"
import { acquireSourceMaterialFence } from "./source-material-fence.js"

const LOCK_SQL = /SELECT pg_current_xact_id\(\)::text AS transaction_id,\s+pg_advisory_xact_lock\(hashtextextended\(\$1::text, 0\)\) AS lock_acquired/
const VERIFY_SQL = "SELECT pg_current_xact_id()::text AS transaction_id"
const TRANSACTION_CHECK_ERROR = "source material fence transaction verification failed"
const SENSITIVE_DATABASE_ERROR = "database URL=postgres://private-user-id:secret@db.example/app xid=8675309"

type SimulatedDatabaseError = Error & Record<string, unknown>

function makeDatabaseError(properties: Record<string, unknown> = {}): SimulatedDatabaseError {
  return Object.assign(new Error(SENSITIVE_DATABASE_ERROR), {
    detail: SENSITIVE_DATABASE_ERROR,
    table: "private_table",
    retryable: true,
    shouldRetry: true,
    retryAfterMs: 30000,
    cause: new Error(SENSITIVE_DATABASE_ERROR),
    ...properties,
  }) as unknown as SimulatedDatabaseError
}

const DATABASE_ERROR_CASES: Array<{
  name: string
  error: SimulatedDatabaseError
  code?: string
  metaCode?: string
}> = [
  { name: "PostgreSQL deadlock", error: makeDatabaseError({ code: "40P01" }), code: "40P01" },
  { name: "PostgreSQL serialization failure", error: makeDatabaseError({ code: "40001" }), code: "40001" },
  {
    name: "Prisma raw query error",
    error: makeDatabaseError({ code: "P2010", meta: { code: "40001", message: SENSITIVE_DATABASE_ERROR, query: SENSITIVE_DATABASE_ERROR } }),
    code: "P2010",
    metaCode: "40001",
  },
  { name: "Prisma transaction conflict", error: makeDatabaseError({ code: "P2034" }), code: "P2034" },
  { name: "unknown database code", error: makeDatabaseError({ code: "X1234", meta: { code: "X1234" } }) },
  { name: "unknown sensitive error", error: makeDatabaseError() },
]

type QueryCall = { sql: string; values: unknown[] }
type FakeQueryResult = { rows: Array<Record<string, unknown>> }

function makeTransaction(
  onQuery: (callIndex: number) => Promise<FakeQueryResult> = async () => ({ rows: [{ transaction_id: "100" }] }),
) {
  const calls: QueryCall[] = []
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values: values ?? [] })
    return onQuery(calls.length)
  })

  return { client: { query } as unknown as PoolClient, calls, query }
}

function spyOnConsole() {
  return [
    vi.spyOn(console, "log"),
    vi.spyOn(console, "info"),
    vi.spyOn(console, "warn"),
    vi.spyOn(console, "error"),
  ]
}

afterEach(() => vi.restoreAllMocks())

describe("acquireSourceMaterialFence", () => {
  it("uses a parameterized shared key and checks the caller transaction without logging IDs", async () => {
    const userId = " user-'private-id "
    const { client, calls } = makeTransaction()
    const loggers = spyOnConsole()

    await acquireSourceMaterialFence(client, [userId])

    expect(calls).toEqual([{
      sql: expect.stringMatching(LOCK_SQL),
      values: [buildAgentSourceMaterialFenceKey(userId)],
    }, { sql: VERIFY_SQL, values: [] }])
    expect(calls[0]?.sql).not.toContain(userId)
    for (const logger of loggers) expect(logger).not.toHaveBeenCalled()
  })

  it("sorts and deduplicates IDs before sequential locks and confirms one transaction ID", async () => {
    let markFirstStarted: () => void = () => undefined
    let releaseFirstLock: () => void = () => undefined
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve })
    const firstCanFinish = new Promise<void>(resolve => { releaseFirstLock = resolve })
    const { client, calls } = makeTransaction(async callIndex => {
      if (callIndex === 1) {
        markFirstStarted()
        await firstCanFinish
      }
      return { rows: [{ transaction_id: "123" }] }
    })

    const acquisition = acquireSourceMaterialFence(client, ["user-c", "user-a", "user-b", "user-a"])
    await firstStarted

    expect(calls).toHaveLength(1)
    expect(calls[0]?.values).toEqual([buildAgentSourceMaterialFenceKey("user-a")])
    expect(calls[0]?.sql).toMatch(LOCK_SQL)

    releaseFirstLock()
    await expect(acquisition).resolves.toBeUndefined()

    expect(calls.slice(0, 3).map(call => call.values)).toEqual([
      [buildAgentSourceMaterialFenceKey("user-a")],
      [buildAgentSourceMaterialFenceKey("user-b")],
      [buildAgentSourceMaterialFenceKey("user-c")],
    ])
    expect(calls.slice(0, 3).every(call => LOCK_SQL.test(call.sql))).toBe(true)
    expect(calls[3]).toEqual({ sql: VERIFY_SQL, values: [] })
  })

  it("fails closed before any lock when the list is empty or any ID is invalid", async () => {
    const secretId = "private-user-id"
    const { client, calls } = makeTransaction()
    const loggers = spyOnConsole()

    await expect(acquireSourceMaterialFence(client, [])).rejects.toThrow(/at least one user ID/i)
    const validationError = await acquireSourceMaterialFence(client, [secretId, ""]).catch(error => error)

    expect(validationError).toBeInstanceOf(TypeError)
    const message = validationError instanceof Error ? validationError.message : String(validationError)
    expect(message).not.toContain(secretId)
    expect(calls).toEqual([])
    for (const logger of loggers) expect(logger).not.toHaveBeenCalled()
  })

  it("rejects a changed transaction ID as an autocommit client", async () => {
    const secretId = "private-user-id"
    const firstXid = "81001"
    const secondXid = "81002"
    const { client, calls } = makeTransaction(async callIndex => ({
      rows: [{ transaction_id: callIndex === 1 ? firstXid : secondXid }],
    }))

    const error = await acquireSourceMaterialFence(client, [secretId]).catch(caught => caught)

    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : String(error)).toBe(TRANSACTION_CHECK_ERROR)
    expect(String(error)).not.toContain(secretId)
    expect(String(error)).not.toContain(firstXid)
    expect(String(error)).not.toContain(secondXid)
    expect(error).not.toHaveProperty("code")
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual({ sql: VERIFY_SQL, values: [] })
  })

  it("rejects missing or malformed transaction IDs with a fixed error", async () => {
    const malformedResults: FakeQueryResult[] = [
      { rows: [] },
      { rows: [{}] },
      { rows: [{ transaction_id: 123 }] },
      { rows: [{ transaction_id: "" }] },
      { rows: [{ transaction_id: "not-an-xid" }] },
    ]

    for (const malformedStage of [1, 2]) {
      for (const malformed of malformedResults) {
        const { client, calls } = makeTransaction(async callIndex => ({
          rows: callIndex === malformedStage ? malformed.rows : [{ transaction_id: "100" }],
        }))
        const error = await acquireSourceMaterialFence(client, ["private-user-id"]).catch(caught => caught)

        expect(error instanceof Error ? error.message : String(error)).toBe(TRANSACTION_CHECK_ERROR)
        expect(String(error)).not.toContain("private-user-id")
        expect(error).not.toHaveProperty("code")
        expect(calls).toHaveLength(malformedStage)
        expect(calls[0]?.sql).toMatch(LOCK_SQL)
        if (malformedStage === 2) expect(calls[1]?.sql).toBe(VERIFY_SQL)
      }
    }
  })

  it("maps a verification query failure to a fixed error without leaking IDs or XIDs", async () => {
    const secretId = "private-user-id"
    const expectedXid = "91001"
    const queryFailure = new Error(`private failure for ${secretId} in xid ${expectedXid}`)
    const { client, calls } = makeTransaction(async callIndex => {
      if (callIndex === 2) throw queryFailure
      return { rows: [{ transaction_id: expectedXid }] }
    })
    const loggers = spyOnConsole()

    const error = await acquireSourceMaterialFence(client, [secretId]).catch(caught => caught)

    expect(error instanceof Error ? error.message : String(error)).toBe(TRANSACTION_CHECK_ERROR)
    expect(String(error)).not.toContain(secretId)
    expect(String(error)).not.toContain(expectedXid)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.sql).toMatch(LOCK_SQL)
    expect(calls[1]?.sql).toBe(VERIFY_SQL)
    for (const logger of loggers) expect(logger).not.toHaveBeenCalled()
  })

  it.each([1, 2])("normalizes allowlisted database errors from query %i without retry markers or private details", async failureQueryIndex => {
    for (const testCase of DATABASE_ERROR_CASES) {
      const { client, calls } = makeTransaction(async callIndex => {
        if (callIndex === failureQueryIndex) throw testCase.error
        return { rows: [{ transaction_id: "100" }] }
      })
      const error = await acquireSourceMaterialFence(client, ["private-user-id"]).catch(caught => caught)

      expect(error).toBeInstanceOf(Error)
      expect(error).toHaveProperty("message", TRANSACTION_CHECK_ERROR)
      expect(String(error)).not.toContain(SENSITIVE_DATABASE_ERROR)
      expect(JSON.stringify(error)).not.toContain(SENSITIVE_DATABASE_ERROR)
      expect(String(error)).not.toContain("private-user-id")
      expect(String(error)).not.toContain("8675309")
      expect(error).not.toHaveProperty("detail")
      expect(error).not.toHaveProperty("table")
      expect(error).not.toHaveProperty("cause")
      expect(error).not.toHaveProperty("retryable")
      expect(error).not.toHaveProperty("shouldRetry")
      expect(error).not.toHaveProperty("retryAfterMs")

      if (testCase.code === undefined) {
        expect(error).not.toHaveProperty("code")
        expect(error).not.toHaveProperty("meta")
        expect(Object.keys(error as object)).toEqual([])
      } else {
        expect(error).toHaveProperty("code", testCase.code)
        if (testCase.metaCode === undefined) {
          expect(error).not.toHaveProperty("meta")
          expect(Object.keys(error as object)).toEqual(["code"])
        } else {
          expect(error).toHaveProperty("meta", { code: testCase.metaCode })
          expect(Object.keys(error as object)).toEqual(["code", "meta"])
        }
      }
      expect(calls).toHaveLength(failureQueryIndex)
    }
  })
})
