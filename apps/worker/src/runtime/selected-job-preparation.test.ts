import { describe, expect, it, vi } from "vitest"
import { loadSelectedJobPreparation } from "./selected-job-preparation.js"
import type { TurnLease } from "./turns/lease.js"

const lease: TurnLease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "owner-1", userId: "user-1", leaseVersion: 3,
  leaseStartedAt: new Date("2026-09-29T10:00:00Z"), leaseExpiresAt: new Date("2026-09-29T10:01:00Z"),
}

function pool(input: unknown) {
  const client = {
    query: vi.fn(async (sql: string, _values?: readonly unknown[]) => sql.includes("SELECT \"input\"") ? { rows: [{ input }] } : { rows: [] }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn(async () => client) }, client }
}

describe("loadSelectedJobPreparation", () => {
  it("loads only the exact server-owned job selector under the current Turn lease", async () => {
    const { pool: pgPool, client } = pool({ goal: "Prepare selected job", selectedJobPreparation: { jobId: "job-1" } })
    await expect(loadSelectedJobPreparation(pgPool as never, lease)).resolves.toEqual({ jobId: "job-1" })
    expect(client.query).toHaveBeenCalledWith("SELECT set_config($1, $2, true)", ["app.user_id", lease.userId])
    const select = client.query.mock.calls.find(([sql]) => sql.includes("SELECT \"input\""))
    expect(select?.[1]).toEqual([lease.turnId, lease.sessionId, lease.userId, lease.ownerId, lease.leaseVersion, expect.any(Date)])
    expect(select?.[0]).toContain('"leaseOwnerId" = $4 AND "leaseVersion" = $5')
    expect(client.release).toHaveBeenCalledOnce()
  })

  it("leaves ordinary Turns without a selected-job intent unchanged", async () => {
    const { pool: pgPool } = pool({ goal: "Find jobs" })
    await expect(loadSelectedJobPreparation(pgPool as never, lease)).resolves.toBeUndefined()
  })

  it("rejects malformed or extra model-shaped identity fields", async () => {
    const { pool: pgPool } = pool({ selectedJobPreparation: { jobId: "job-1", userId: "user-2" } })
    await expect(loadSelectedJobPreparation(pgPool as never, lease)).rejects.toThrow("selected_job_preparation_invalid")
  })

  it("fails closed when the Turn lease is no longer owned", async () => {
    const client = { query: vi.fn(async (sql: string) => sql === "SELECT set_config($1, $2, true)" ? { rows: [] } : { rows: [] }), release: vi.fn() }
    await expect(loadSelectedJobPreparation({ connect: async () => client } as never, lease)).rejects.toThrow("turn_not_owned")
    expect(client.query).toHaveBeenCalledWith("ROLLBACK")
  })
})
