import type { Pool, PoolClient } from "pg"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { readSelectedJobReviewedArtifactWithClient, type SelectedJobReviewedArtifact } from "./selected-job-reviewed-artifact-read.js"
import { claimApplicationFillBrowserStart, reviewedApplicationFillSelector } from "./reviewed-application-fill-binding.js"
import type { SubagentLease } from "./subagents/types.js"

vi.mock("./selected-job-reviewed-artifact-read.js", () => ({ readSelectedJobReviewedArtifactWithClient: vi.fn() }))

const proof: SelectedJobReviewedArtifact = {
  sourceTurnId: "source-turn-a", rootTaskId: "root-a", graphRevision: 4, jobId: "job-a", writerTaskId: "writer-a",
  reviewerTaskId: "reviewer-a", reviewerToolCallId: "review-call-a", reviewHash: `sha256:${"a".repeat(64)}`,
  artifactId: "artifact-a", version: 2, contentHash: `sha256:${"b".repeat(64)}`,
  sourceDigest: `sha256:${"c".repeat(64)}`, content: "Exact private reviewed draft",
}
const selector = { kind: "selected", sourceTurnId: "source-turn-a" } as const
const selectedTurnInput = { reviewedApplicationMaterialSource: {
  schemaVersion: "agent-harness.v2.selected-job-reviewed-fill-source.v1", sourceTurnId: "source-turn-a",
} }

function lease(): SubagentLease {
  return {
    id: "filler-a", userId: "user-a", sessionId: "session-a", turnId: "fill-turn-a", role: "application_filler",
    taskType: "application_fill_for_review", status: "running", attemptCount: 3, maxAttempts: 4,
    leaseOwner: "worker-a", ownerId: "worker-a", leaseExpiresAt: new Date("2026-11-20T12:01:00.000Z"),
    interruptRequestedAt: null, signal: new AbortController().signal,
  } as SubagentLease
}

function fixture(options: { turnInput?: unknown; checkpoint?: string; subtaskFound?: boolean; priorEvents?: unknown[]; updateRowCount?: number } = {}) {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values })
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 }
      if (sql.includes("set_config")) return { rows: [], rowCount: 1 }
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{ transaction_id: "123", lock_acquired: null }], rowCount: 1 }
      if (sql === "SELECT pg_current_xact_id()::text AS transaction_id") return { rows: [{ transaction_id: "123" }], rowCount: 1 }
      if (sql.includes("FROM agent_sessions")) return { rows: [{ status: "running" }], rowCount: 1 }
      if (sql.includes('FROM agent_turns WHERE')) return { rows: [{ status: "in_progress", input: options.turnInput ?? selectedTurnInput }], rowCount: 1 }
      if (sql.includes("UPDATE application_tasks AS app")) { const count = options.updateRowCount ?? 1; return { rows: count === 1 ? [{ id: "application-a" }] : [], rowCount: count } }
      if (sql.includes("FROM sub_agent_tasks sub")) return options.subtaskFound === false ? { rows: [], rowCount: 0 } : { rows: [{ id: "filler-a" }], rowCount: 1 }
      if (sql.includes("FROM application_tasks")) return { rows: [{ id: "application-a", jobId: "job-a", status: "filling", checkpoint: options.checkpoint ?? "taskgraph_fill_queued" }], rowCount: 1 }
      if (sql.includes('FROM "application_task_events"')) {
        const rows = (options.priorEvents ?? []).filter(row => Boolean(row && typeof row === "object" && (row as { fillTurnId?: unknown }).fillTurnId === values[1]))
        return { rows, rowCount: rows.length }
      }
      if (sql.includes('INSERT INTO "application_task_events"')) return { rows: [], rowCount: 1 }
      throw new Error(`Unexpected query: ${sql}`)
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool
  return { calls, client, pool }
}

beforeEach(() => vi.mocked(readSelectedJobReviewedArtifactWithClient).mockReset().mockResolvedValue(proof))

describe("reviewed application fill browser binding", () => {
  it("parses only the exact accepted source selector", () => {
    expect(reviewedApplicationFillSelector({})).toEqual({ kind: "absent" })
    expect(reviewedApplicationFillSelector(selectedTurnInput)).toEqual(selector)
    expect(reviewedApplicationFillSelector({ reviewedApplicationMaterialSource: { ...selectedTurnInput.reviewedApplicationMaterialSource, extra: true } })).toEqual({ kind: "invalid" })
  })

  it("fences and revalidates source proof before atomically writing the private binding event and browser checkpoint", async () => {
    const test = fixture()
    const result = await claimApplicationFillBrowserStart({ pool: test.pool, lease: lease(), expectedSelector: selector, applicationTaskId: "application-a", jobId: "job-a" })

    expect(result).toEqual({ status: "claimed", reviewedMaterial: proof })
    const sql = test.calls.map(call => call.sql)
    expect(sql.indexOf("pg_advisory_xact_lock")).toBeLessThan(sql.findIndex(value => value.includes("FROM agent_sessions")))
    expect(sql.findIndex(value => value.includes('INSERT INTO "application_task_events"'))).toBeLessThan(sql.findIndex(value => value.includes("UPDATE application_tasks AS app")))
    expect(sql.findIndex(value => value.includes("UPDATE application_tasks AS app"))).toBeLessThan(sql.indexOf("COMMIT"))
    const event = test.calls.find(call => call.sql.includes('INSERT INTO "application_task_events"'))!
    const data = JSON.parse(String(event.values[3])) as Record<string, unknown>
    expect(data).toMatchObject({ userId: "user-a", sessionId: "session-a", fillTurnId: "fill-turn-a", jobId: "job-a", applicationTaskId: "application-a", fillerTaskId: "filler-a", attemptCount: 3, sourceTurnId: "source-turn-a", writerTaskId: "writer-a", reviewerTaskId: "reviewer-a", artifactId: "artifact-a", version: 2, contentHash: proof.contentHash, sourceDigest: proof.sourceDigest })
    expect(Object.keys(data)).not.toContain("content")
    expect(JSON.stringify(event.values)).not.toContain(proof.content)
    const update = test.calls.find(call => call.sql.includes("UPDATE application_tasks AS app"))!
    expect(update.sql).toContain('sub."leaseExpiresAt">clock_timestamp()')
    expect(update.sql).toContain('sub."interruptRequestedAt" IS NULL')
    expect(update.sql).toContain('sub."leaseOwner"=$9 AND sub."attemptCount"=$10')
    expect(test.client.release).toHaveBeenCalledOnce()
  })

  it.each([
    ["changed source selector", { turnInput: { reviewedApplicationMaterialSource: { ...selectedTurnInput.reviewedApplicationMaterialSource, sourceTurnId: "source-turn-b" } } }, undefined],
    ["missing current proof", {}, undefined],
    ["duplicate or conflicting binding event", {}, { priorEvents: [{ id: "old-event", fillTurnId: "fill-turn-a" }] }],
  ])("fails closed on %s", async (_name, turnOverride, fixtureOverride) => {
    if (_name === "missing current proof") vi.mocked(readSelectedJobReviewedArtifactWithClient).mockResolvedValue(null)
    const test = fixture({ ...(turnOverride as object), ...(fixtureOverride as object) })
    const result = await claimApplicationFillBrowserStart({ pool: test.pool, lease: lease(), expectedSelector: selector, applicationTaskId: "application-a", jobId: "job-a" })
    expect(result).toEqual({ status: "conflict" })
    expect(test.calls.some(call => call.sql.includes('INSERT INTO "application_task_events"'))).toBe(false)
    expect(test.calls.some(call => call.sql.includes("UPDATE application_tasks AS app"))).toBe(false)
    expect(test.calls.some(call => call.sql === "ROLLBACK")).toBe(true)
  })

  it("allows a historical binding event from an earlier fill Turn", async () => {
    const test = fixture({ priorEvents: [{ id: "old-event", fillTurnId: "previous-fill-turn" }] })
    const result = await claimApplicationFillBrowserStart({ pool: test.pool, lease: lease(), expectedSelector: selector, applicationTaskId: "application-a", jobId: "job-a" })
    const priorQuery = test.calls.find(call => call.sql.includes('FROM "application_task_events"'))
    expect(result.status).toBe("claimed")
    expect(priorQuery?.sql).toContain('"data"->>\'fillTurnId\'=$2')
    expect(priorQuery?.values).toEqual(["application-a", "fill-turn-a"])
    expect(test.calls.some(call => call.sql.includes('INSERT INTO "application_task_events"'))).toBe(true)
  })

  it("rejects a same-fill-Turn reviewed start even if its selector was later removed", async () => {
    const test = fixture({ turnInput: {}, priorEvents: [{ id: "old-event", fillTurnId: "fill-turn-a" }] })
    const result = await claimApplicationFillBrowserStart({ pool: test.pool, lease: lease(), expectedSelector: { kind: "absent" }, applicationTaskId: "application-a", jobId: "job-a" })
    expect(result).toEqual({ status: "conflict" })
    expect(test.calls.some(call => call.sql.includes('INSERT INTO "application_task_events"'))).toBe(false)
    expect(test.calls.some(call => call.sql.includes("UPDATE application_tasks AS app"))).toBe(false)
  })

  it("rolls back a binding event if the final live-lease compare-and-set loses its race", async () => {
    const test = fixture({ updateRowCount: 0 })
    const result = await claimApplicationFillBrowserStart({ pool: test.pool, lease: lease(), expectedSelector: selector, applicationTaskId: "application-a", jobId: "job-a" })
    expect(result).toEqual({ status: "conflict" })
    expect(test.calls.some(call => call.sql.includes('INSERT INTO "application_task_events"'))).toBe(true)
    expect(test.calls.some(call => call.sql === "ROLLBACK")).toBe(true)
    expect(test.calls.some(call => call.sql === "COMMIT")).toBe(false)
  })

  it("preserves absent-selector browser start without reviewed source fencing or event writes", async () => {
    const test = fixture({ turnInput: {} })
    const result = await claimApplicationFillBrowserStart({ pool: test.pool, lease: lease(), expectedSelector: { kind: "absent" }, applicationTaskId: "application-a", jobId: "job-a" })
    expect(result).toEqual({ status: "claimed" })
    expect(test.calls.some(call => call.sql.includes("pg_advisory_xact_lock"))).toBe(false)
    expect(test.calls.some(call => call.sql.includes('INSERT INTO "application_task_events"'))).toBe(false)
    expect(test.calls.some(call => call.sql.includes("UPDATE application_tasks AS app"))).toBe(true)
  })

  it("preserves exact already-started handling without relaunching or adding another event", async () => {
    const test = fixture({ checkpoint: "browser_active" })
    const result = await claimApplicationFillBrowserStart({ pool: test.pool, lease: lease(), expectedSelector: selector, applicationTaskId: "application-a", jobId: "job-a" })
    expect(result).toEqual({ status: "already_started" })
    expect(test.calls.some(call => call.sql.includes("UPDATE application_tasks AS app"))).toBe(false)
    expect(test.calls.some(call => call.sql.includes('INSERT INTO "application_task_events"'))).toBe(false)
    expect(readSelectedJobReviewedArtifactWithClient).not.toHaveBeenCalled()
  })

  it("rejects a stale filler lease before writing or changing the checkpoint", async () => {
    const test = fixture({ subtaskFound: false })
    const result = await claimApplicationFillBrowserStart({ pool: test.pool, lease: lease(), expectedSelector: selector, applicationTaskId: "application-a", jobId: "job-a" })
    expect(result).toEqual({ status: "stale" })
    expect(test.calls.some(call => call.sql.includes('sub."leaseExpiresAt">clock_timestamp()'))).toBe(true)
    expect(test.calls.some(call => call.sql.includes('INSERT INTO "application_task_events"'))).toBe(false)
    expect(test.calls.some(call => call.sql.includes("UPDATE application_tasks AS app"))).toBe(false)
  })
})
