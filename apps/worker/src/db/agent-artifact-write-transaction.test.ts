import { describe, expect, it, vi } from "vitest"
import type { PoolClient } from "pg"
import { withFencedArtifactWriteTransaction } from "./agent-artifact-write-transaction.js"

function createPool(transactionId: string | null = "42") {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      if (sql.includes("pg_current_xact_id()::text AS transaction_id")) {
        return { rows: transactionId ? [{ transaction_id: transactionId }] : [], rowCount: transactionId ? 1 : 0 }
      }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) }
  return { pool, client, calls }
}

describe("fenced artifact write transaction", () => {
  it("sets the tenant, acquires source then job locks, and runs one callback on that transaction", async () => {
    const { pool, client, calls } = createPool()
    const work = vi.fn(async (sameClient: PoolClient) => {
      expect(sameClient).toBe(client)
      await sameClient.query("SELECT write artifact")
      return "written"
    })

    await expect(withFencedArtifactWriteTransaction(pool as never, "user-a", "job-a", work)).resolves.toBe("written")

    const statements = calls.map(call => call.sql)
    const sourceLock = calls.findIndex(call => call.sql.includes("hashtextextended($1::text, 0)"))
    const sourceVerify = calls.findIndex((call, index) => index > sourceLock && call.sql === "SELECT pg_current_xact_id()::text AS transaction_id")
    const jobLock = calls.findIndex(call => call.sql.includes("pg_advisory_xact_lock(hashtext($1), hashtext($2))"))
    const callback = calls.findIndex(call => call.sql === "SELECT write artifact")

    expect(pool.connect).toHaveBeenCalledTimes(1)
    expect(work).toHaveBeenCalledTimes(1)
    expect(statements.filter(sql => sql === "BEGIN")).toHaveLength(1)
    expect(statements.filter(sql => sql === "COMMIT")).toHaveLength(1)
    expect(statements.filter(sql => sql === "ROLLBACK")).toHaveLength(0)
    expect(calls[1]).toMatchObject({ sql: "SELECT set_config($1, $2, true)", values: ["app.user_id", "user-a"] })
    expect(calls[sourceLock]?.values).toEqual(["applymate:gate-source-fence:v1:user-a"])
    expect(calls[jobLock]?.values).toEqual(["user-a", "job-a"])
    expect(sourceLock).toBeGreaterThan(1)
    expect(sourceVerify).toBeGreaterThan(sourceLock)
    expect(jobLock).toBeGreaterThan(sourceVerify)
    expect(callback).toBeGreaterThan(jobLock)
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it("rolls back and skips the callback when the source fence cannot prove an open transaction", async () => {
    const { pool, client, calls } = createPool(null)
    const work = vi.fn(async () => "must not run")

    await expect(withFencedArtifactWriteTransaction(pool as never, "user-a", "job-a", work))
      .rejects.toThrow("source material fence transaction verification failed")

    expect(work).not.toHaveBeenCalled()
    expect(calls.some(call => call.sql.includes("hashtext($1), hashtext($2)"))).toBe(false)
    expect(calls.map(call => call.sql)).toContain("ROLLBACK")
    expect(calls.map(call => call.sql)).not.toContain("COMMIT")
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it("keeps the source fence through the protected callback and rolls back callback failures", async () => {
    const { pool, client, calls } = createPool()
    const failure = new Error("artifact write failed")
    const work = vi.fn(async () => { throw failure })

    await expect(withFencedArtifactWriteTransaction(pool as never, "user-a", "job-a", work)).rejects.toBe(failure)

    expect(work).toHaveBeenCalledTimes(1)
    expect(calls.map(call => call.sql)).toContain("ROLLBACK")
    expect(calls.map(call => call.sql)).not.toContain("COMMIT")
    expect(pool.connect).toHaveBeenCalledTimes(1)
    expect(client.release).toHaveBeenCalledTimes(1)
  })
})
