import { describe, expect, it, vi } from "vitest"
import type { Pool, PoolClient } from "pg"

import { recordApplicationSubmissionEvidence } from "./application-submission-evidence.js"
import type { ApplicationSubmissionExecution } from "./application-submit-fence.js"

const scope: ApplicationSubmissionExecution = {
  sessionId: "session-a", fillTurnId: "turn-a", applicationTaskId: "task-a", userId: "user-a",
  jobId: "job-a", approvalId: "receipt-a", constraintHash: "c".repeat(64),
  workerTaskId: "worker-a", executionId: "execution-a",
}
const attempt = { id: "attempt-a", artifactHash: "a".repeat(64), responseRef: "application:task-a" }

function poolFixture(options: { readonly attempt?: { id: string; artifactHash: string; responseRef: string | null } | null; readonly insertRowCount?: number } = {}) {
  const queries: Array<{ sql: string; values?: unknown[] }> = []
  const release = vi.fn()
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    queries.push({ sql, values })
    if (sql.includes('FROM "submission_attempt"') && sql.includes('SELECT "id", "artifactHash"')) {
      return { rows: options.attempt === null ? [] : [options.attempt ?? attempt], rowCount: options.attempt === null ? 0 : 1 }
    }
    if (sql.includes("INSERT INTO \"application_task_events\"")) return { rows: [], rowCount: options.insertRowCount ?? 1 }
    return { rows: [], rowCount: 1 }
  })
  const client = { query, release } as unknown as PoolClient
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool
  return { pool, query, release, queries }
}

async function flushMicrotasksUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30 && !predicate(); attempt += 1) await Promise.resolve()
}

describe("application submission evidence producer", () => {
  it("writes only the closed evidence contract after validating current database bindings", async () => {
    const fixture = poolFixture()
    await expect(recordApplicationSubmissionEvidence(fixture.pool, scope)).resolves.toBe(true)

    const insert = fixture.queries.find(call => call.sql.includes("INSERT INTO \"application_task_events\""))
    expect(insert?.sql).toContain("submission_evidence_recorded")
    expect(insert?.sql).toContain("task.\"workerTaskId\" = $9")
    expect(insert?.sql).toContain("approval.\"resourceHash\" = submitted.\"artifactHash\"")
    expect(insert?.sql).toContain("execution.exact_pair")
    expect(insert?.sql).toContain("ON CONFLICT (\"id\") DO NOTHING")
    expect(insert?.values?.[0]).toMatch(/^evt_submission_evidence_[a-f0-9]{64}$/)
    expect(insert?.values?.[12]).toBe("correlated")
    expect(JSON.stringify(fixture.queries)).not.toContain("application:task-a")
    expect(fixture.queries.filter(call => call.sql.startsWith("SET LOCAL")).map(call => call.sql)).toEqual([
      "SET LOCAL statement_timeout = '1500ms'",
      "SET LOCAL lock_timeout = '500ms'",
      "SET LOCAL idle_in_transaction_session_timeout = '6000ms'",
    ])
    expect(fixture.queries.at(-1)?.sql).toBe("COMMIT")
    expect(fixture.release).toHaveBeenCalledTimes(1)
  })

  it("uses only a closed local-reference status and never persists another provider reference", async () => {
    const fixture = poolFixture({ attempt: { ...attempt, responseRef: "provider-private-confirmation" } })
    await expect(recordApplicationSubmissionEvidence(fixture.pool, scope)).resolves.toBe(true)
    const insert = fixture.queries.find(call => call.sql.includes("INSERT INTO \"application_task_events\""))
    expect(insert?.values?.[12]).toBe("unavailable")
    expect(JSON.stringify(fixture.queries)).not.toContain("provider-private-confirmation")
  })

  it("does not project absent or unusable durable attempts", async () => {
    for (const row of [null, { ...attempt, responseRef: null }, { ...attempt, artifactHash: "invalid" }]) {
      const fixture = poolFixture({ attempt: row })
      await expect(recordApplicationSubmissionEvidence(fixture.pool, scope)).resolves.toBe(false)
      expect(fixture.queries.some(call => call.sql.includes("INSERT INTO \"application_task_events\""))).toBe(false)
      expect(fixture.queries.at(-1)?.sql).toBe("ROLLBACK")
      expect(fixture.release).toHaveBeenCalledTimes(1)
    }
  })

  it("rejects invalid identity before checking out a connection", async () => {
    const fixture = poolFixture()
    await expect(recordApplicationSubmissionEvidence(fixture.pool, { ...scope, constraintHash: "wrong" })).resolves.toBe(false)
    expect(fixture.pool.connect).not.toHaveBeenCalled()
  })

  it("releases a pool client that arrives after bounded checkout expires", async () => {
    vi.useFakeTimers()
    let resolveCheckout!: (client: PoolClient) => void
    const release = vi.fn()
    const client = { query: vi.fn(), release } as unknown as PoolClient
    const pool = { connect: vi.fn(() => new Promise<PoolClient>(resolve => { resolveCheckout = resolve })) } as unknown as Pool
    try {
      const projection = recordApplicationSubmissionEvidence(pool, scope)
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(projection).resolves.toBe(false)
      resolveCheckout(client)
      await Promise.resolve()
      await Promise.resolve()
      expect(release).toHaveBeenCalledTimes(1)
      expect(client.query).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it.each(["BEGIN", "COMMIT"] as const)("destroys the client if %s never settles", async hungQuery => {
    vi.useFakeTimers()
    const release = vi.fn()
    const queries: string[] = []
    const query = vi.fn(async (sql: string) => {
      queries.push(sql)
      if (sql === hungQuery) return new Promise<never>(() => {})
      if (sql.includes('SELECT "id", "artifactHash"')) return { rows: [attempt], rowCount: 1 }
      if (sql.includes('INSERT INTO "application_task_events"')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    })
    const client = { query, release } as unknown as PoolClient
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool
    try {
      const projection = recordApplicationSubmissionEvidence(pool, scope)
      const rejected = expect(projection).rejects.toThrow("bounded deadline")
      await flushMicrotasksUntil(() => queries.includes(hungQuery))
      expect(queries).toContain(hungQuery)
      await vi.advanceTimersByTimeAsync(2_000)
      await rejected
      expect(release).toHaveBeenCalledWith(true)
      expect(queries).not.toContain("ROLLBACK")
    } finally { vi.useRealTimers() }
  })

  it("bounds a stalled rollback and preserves the original query failure", async () => {
    vi.useFakeTimers()
    const failure = new Error("evidence insert failed")
    const release = vi.fn()
    const queries: string[] = []
    const query = vi.fn(async (sql: string) => {
      queries.push(sql)
      if (sql.includes('SELECT "id", "artifactHash"')) return { rows: [attempt], rowCount: 1 }
      if (sql.includes('INSERT INTO "application_task_events"')) throw failure
      if (sql === "ROLLBACK") return new Promise<never>(() => {})
      return { rows: [], rowCount: 1 }
    })
    const client = { query, release } as unknown as PoolClient
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool
    try {
      const projection = recordApplicationSubmissionEvidence(pool, scope)
      const rejected = expect(projection).rejects.toBe(failure)
      await flushMicrotasksUntil(() => queries.includes("ROLLBACK"))
      expect(queries).toContain("ROLLBACK")
      await vi.advanceTimersByTimeAsync(2_000)
      await rejected
      expect(release).toHaveBeenCalledWith(true)
    } finally { vi.useRealTimers() }
  })

  it("rolls back and releases when the evidence write fails", async () => {
    const fixture = poolFixture()
    fixture.query.mockImplementation(async (sql: string, values?: unknown[]) => {
      fixture.queries.push({ sql, values })
      if (sql.includes('SELECT "id", "artifactHash"')) return { rows: [attempt], rowCount: 1 }
      if (sql.includes("INSERT INTO \"application_task_events\"")) throw new Error("private database diagnostic")
      return { rows: [], rowCount: 1 }
    })
    await expect(recordApplicationSubmissionEvidence(fixture.pool, scope)).rejects.toThrow("private database diagnostic")
    expect(fixture.queries.at(-1)?.sql).toBe("ROLLBACK")
    expect(fixture.release).toHaveBeenCalledTimes(1)
  })
})
