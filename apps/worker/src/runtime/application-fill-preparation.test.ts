import { beforeEach, describe, expect, it, vi } from "vitest"
import type pg from "pg"
import type { TurnLease } from "./turns/lease.js"
import { readSelectedJobReviewedArtifactWithClient, type SelectedJobReviewedArtifact } from "./selected-job-reviewed-artifact-read.js"
import { loadApplicationFillPreparation } from "./application-fill-preparation.js"

vi.mock("./selected-job-reviewed-artifact-read.js", () => ({ readSelectedJobReviewedArtifactWithClient: vi.fn() }))

type BoundRow = { id: string; userId: string; jobId: string; sessionId: string; fillTurnSessionId: string; fillTurnUserId: string; turnInput: unknown; status: string; checkpoint: string }
const boundTask: BoundRow = {
  id: "application-a", userId: "user-a", jobId: "job-a", sessionId: "session-a", fillTurnSessionId: "session-a", fillTurnUserId: "user-a",
  turnInput: {},
  status: "filling", checkpoint: "taskgraph_fill_queued",
}
const reviewedProof: SelectedJobReviewedArtifact = {
  sourceTurnId: "source-turn-a", rootTaskId: "root-a", graphRevision: 4, jobId: "job-a", writerTaskId: "writer-a",
  reviewerTaskId: "reviewer-a", reviewerToolCallId: "review-call-a", reviewHash: `sha256:${"a".repeat(64)}`,
  artifactId: "artifact-a", version: 2, contentHash: `sha256:${"b".repeat(64)}`,
  sourceDigest: `sha256:${"c".repeat(64)}`, content: "reviewed draft",
}

beforeEach(() => vi.mocked(readSelectedJobReviewedArtifactWithClient).mockReset().mockResolvedValue(null))

function fixture(boundRows: BoundRow[] = [boundTask], materialRows: Array<{ id: string }> = [{ id: "application-a" }]) {
  const lease: TurnLease = {
    turnId: "turn-a", sessionId: "session-a", userId: "user-a", ownerId: "worker-a", leaseVersion: 7,
    leaseStartedAt: new Date("2026-10-15T11:59:00.000Z"), leaseExpiresAt: new Date("2026-10-15T12:01:00.000Z"),
  }
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values })
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 }
      if (sql.includes("set_config")) return { rows: [{ set_config: "user-a" }], rowCount: 1 }
      if (sql.includes('FROM "agent_turns"')) return { rows: boundRows, rowCount: boundRows.length }
      if (sql.includes('FROM "application_tasks"')) return { rows: materialRows, rowCount: materialRows.length }
      throw new Error(`unexpected preparation query: ${sql}`)
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool
  return { lease, calls, client, pool }
}

describe("application-fill preparation", () => {
  it("confirms the live Turn lease and exact DB-bound queued ApplicationTask without exposing its identity", async () => {
    const test = fixture()
    const now = new Date("2026-10-15T12:00:00.000Z")

    await expect(loadApplicationFillPreparation(test.pool, test.lease, now)).resolves.toEqual({ available: true })

    const read = test.calls.find(call => call.sql.includes('FROM "agent_turns"'))
    expect(read?.sql).toContain('turn."userId" = $3')
    expect(read?.sql).toContain('app."jobId"')
    expect(read?.sql).toContain('turn."input" AS "turnInput"')
    expect(read?.sql).toContain('turn."leaseOwnerId" = $4 AND turn."leaseVersion" = $5')
    expect(read?.sql).toContain('turn."leaseExpiresAt" > $6 AND turn."status" = \'in_progress\'')
    expect(read?.sql).toContain('app."fillTurnId" = turn."id"')
    expect(read?.values).toEqual(["turn-a", "session-a", "user-a", "worker-a", 7, now])
    const materials = test.calls.find(call => call.sql.includes('FROM "application_tasks"'))
    expect(materials?.sql).toContain('job."userId" = app."userId"')
    expect(materials?.sql).toContain('resume."userId" = app."userId"')
    expect(materials?.sql).toContain('(resume."targetJobId" IS NULL OR resume."targetJobId" = app."jobId")')
    expect(materials?.sql).toContain('cover."userId" = app."userId" AND cover."jobId" = app."jobId"')
    expect(materials?.sql).toContain('app."fillTurnSessionId" = $3 AND app."fillTurnUserId" = $2')
    expect(materials?.values).toEqual(["application-a", "user-a", "session-a", "turn-a"])
    expect(test.calls.map(call => call.sql)).toContain("COMMIT")
    expect(test.client.release).toHaveBeenCalledOnce()
    expect(readSelectedJobReviewedArtifactWithClient).not.toHaveBeenCalled()
  })

  it("exposes the template for an exact terminal reviewed source bound to this fill Job", async () => {
    vi.mocked(readSelectedJobReviewedArtifactWithClient).mockResolvedValue(reviewedProof)
    const sourceTurnId = reviewedProof.sourceTurnId
    const test = fixture([{
      ...boundTask,
      turnInput: { reviewedApplicationMaterialSource: {
        schemaVersion: "agent-harness.v2.selected-job-reviewed-fill-source.v1", sourceTurnId,
      } },
    }])

    await expect(loadApplicationFillPreparation(test.pool, test.lease)).resolves.toEqual({ available: true })
    expect(readSelectedJobReviewedArtifactWithClient).toHaveBeenCalledWith(test.client, {
      userId: "user-a", sessionId: "session-a", jobId: "job-a", sourceTurnId,
    })
  })

  it.each(["stale", "ambiguous"]) ("withholds the template when the terminal source reader reports %s evidence", async () => {
    const test = fixture([{
      ...boundTask,
      turnInput: { reviewedApplicationMaterialSource: {
        schemaVersion: "agent-harness.v2.selected-job-reviewed-fill-source.v1", sourceTurnId: "source-turn-a",
      } },
    }])

    await expect(loadApplicationFillPreparation(test.pool, test.lease)).resolves.toBeUndefined()
    expect(readSelectedJobReviewedArtifactWithClient).toHaveBeenCalledOnce()
    expect(test.calls.some(call => call.sql.includes('FROM "application_tasks" AS app'))).toBe(false)
  })

  it("rejects a reader proof that resolves a different Job or source Turn", async () => {
    for (const proof of [{ ...reviewedProof, jobId: "job-b" }, { ...reviewedProof, sourceTurnId: "source-turn-b" }]) {
      vi.mocked(readSelectedJobReviewedArtifactWithClient).mockResolvedValue(proof)
      const test = fixture([{
        ...boundTask,
        turnInput: { reviewedApplicationMaterialSource: {
          schemaVersion: "agent-harness.v2.selected-job-reviewed-fill-source.v1", sourceTurnId: "source-turn-a",
        } },
      }])

      await expect(loadApplicationFillPreparation(test.pool, test.lease)).resolves.toBeUndefined()
      expect(test.calls.some(call => call.sql.includes('FROM "application_tasks" AS app'))).toBe(false)
    }
  })

  it("fails closed on a malformed selector instead of treating it as legacy", async () => {
    const selectors: unknown[] = [null, {},
      { schemaVersion: "wrong", sourceTurnId: "source-turn-a" },
      { schemaVersion: "agent-harness.v2.selected-job-reviewed-fill-source.v1", sourceTurnId: "source-turn-a", extra: true },
      { schemaVersion: "agent-harness.v2.selected-job-reviewed-fill-source.v1", sourceTurnId: " " },
    ]
    for (const selector of selectors) {
      const test = fixture([{
        ...boundTask, turnInput: { reviewedApplicationMaterialSource: selector },
      }])

      await expect(loadApplicationFillPreparation(test.pool, test.lease)).resolves.toBeUndefined()
      expect(readSelectedJobReviewedArtifactWithClient).not.toHaveBeenCalled()
      expect(test.calls.some(call => call.sql.includes('FROM "application_tasks" AS app'))).toBe(false)
    }
  })

  it("withholds the capability when no exact bound ApplicationTask exists", async () => {
    const test = fixture([])

    await expect(loadApplicationFillPreparation(test.pool, test.lease)).resolves.toBeUndefined()
    expect(test.calls.some(call => call.sql === "COMMIT")).toBe(true)
    expect(test.calls.some(call => call.sql.includes('FROM "application_tasks"'))).toBe(false)
    expect(test.calls.some(call => /^(UPDATE|INSERT)/.test(call.sql))).toBe(false)
  })

  it("withholds preparation for an exactly bound browser-active fill without reading materials", async () => {
    const test = fixture([{ ...boundTask, checkpoint: "browser_active" }])

    await expect(loadApplicationFillPreparation(test.pool, test.lease)).resolves.toBeUndefined()
    expect(test.calls.some(call => call.sql.includes('FROM "application_tasks"'))).toBe(false)
    expect(test.calls.some(call => call.sql === "COMMIT")).toBe(true)
    expect(test.calls.some(call => call.sql === "ROLLBACK")).toBe(false)
    expect(test.client.release).toHaveBeenCalledOnce()
  })

  it("rejects a browser-active fill whose persisted turn binding does not match the live lease", async () => {
    const test = fixture([{ ...boundTask, checkpoint: "browser_active", fillTurnSessionId: "different-session" }])

    await expect(loadApplicationFillPreparation(test.pool, test.lease)).rejects.toThrow("application_fill_binding_invalid")
    expect(test.calls.some(call => call.sql.includes('FROM "application_tasks"'))).toBe(false)
    expect(test.calls.some(call => call.sql === "ROLLBACK")).toBe(true)
    expect(test.calls.some(call => call.sql === "COMMIT")).toBe(false)
  })

  it("rejects a bound task outside the queued fill state instead of treating it as an ordinary Turn", async () => {
    const test = fixture([{ ...boundTask, status: "failed", checkpoint: "fill_prestart_failed" }])

    await expect(loadApplicationFillPreparation(test.pool, test.lease)).rejects.toThrow("application_fill_state_invalid")
    expect(test.calls.some(call => call.sql.includes('FROM "application_tasks"'))).toBe(false)
    expect(test.calls.some(call => call.sql === "ROLLBACK")).toBe(true)
    expect(test.calls.some(call => call.sql === "COMMIT")).toBe(false)
    expect(test.client.release).toHaveBeenCalledOnce()
  })

  it("rejects a bound fill with missing or mismatched persisted material", async () => {
    const test = fixture([boundTask], [])

    await expect(loadApplicationFillPreparation(test.pool, test.lease)).rejects.toThrow("application_fill_material_unavailable")
    expect(test.calls.some(call => call.sql === "ROLLBACK")).toBe(true)
    expect(test.calls.some(call => call.sql === "COMMIT")).toBe(false)
    expect(test.client.release).toHaveBeenCalledOnce()
  })

  it("rejects a bound task whose persisted session/user bindings do not match the leased Turn", async () => {
    const test = fixture([{ ...boundTask, fillTurnUserId: "different-user" }])

    await expect(loadApplicationFillPreparation(test.pool, test.lease)).rejects.toThrow("application_fill_binding_invalid")
    expect(test.calls.some(call => call.sql.includes('FROM "application_tasks"'))).toBe(false)
    expect(test.calls.some(call => call.sql === "ROLLBACK")).toBe(true)
  })

  it("does not query when the Turn lease fence is malformed", async () => {
    const test = fixture()
    test.lease.leaseVersion = 0

    await expect(loadApplicationFillPreparation(test.pool, test.lease)).resolves.toBeUndefined()
    expect(test.pool.connect).not.toHaveBeenCalled()
  })
})
