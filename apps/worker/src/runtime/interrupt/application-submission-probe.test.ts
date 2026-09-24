import type { Pool } from "pg"
import { afterEach, describe, expect, it, vi } from "vitest"
import { acquireApplicationSubmissionStartFence, isApplicationSubmissionStopped, startApplicationSubmissionStopProbe } from "./application-submission-probe.js"

const scope = { userId: "user_1", sessionId: "session_1", turnId: "turn_1", applicationTaskId: "task_1", jobId: "job_1" }

function fakePool(turnStatus = "in_progress", interrupted = false) {
  const query = vi.fn(async (sql: string) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
    if (sql.includes('FROM "agent_sessions"')) return { rows: [{ status: "running" }], rowCount: 1 }
    if (sql.includes('FROM "agent_turns"')) return { rows: [{ status: turnStatus }], rowCount: 1 }
    if (sql.includes('FROM "agent_events"')) return { rows: [{ stopped: interrupted }], rowCount: 1 }
    if (sql.includes("UPDATE application_tasks")) return { rows: [{ id: "task_1" }], rowCount: 1 }
    throw new Error(`Unexpected query: ${sql}`)
  })
  const release = vi.fn()
  return { pool: { connect: vi.fn().mockResolvedValue({ query, release }) } as unknown as Pool, query, release }
}

afterEach(() => vi.useRealTimers())

describe("application submission Stop probe", () => {
  it("holds Session and Turn locks until the browser request boundary is released", async () => {
    const { pool, query, release } = fakePool()
    const fence = await acquireApplicationSubmissionStartFence(pool, scope)

    expect(fence.state).toBe("ready")
    const statements = query.mock.calls.map(([sql]) => sql)
    const sessionLock = statements.findIndex(sql => sql.includes('FROM "agent_sessions"'))
    const turnLock = statements.findIndex(sql => sql.includes('FROM "agent_turns"'))
    const taskUpdate = statements.findIndex(sql => sql.includes("UPDATE application_tasks"))
    expect(statements.indexOf("BEGIN")).toBeLessThan(sessionLock)
    expect(sessionLock).toBeLessThan(turnLock)
    expect(turnLock).toBeLessThan(taskUpdate)
    expect(query).not.toHaveBeenCalledWith("COMMIT")
    expect(release).not.toHaveBeenCalled()

    await fence.release(true)

    expect(query).toHaveBeenLastCalledWith("COMMIT")
    expect(release).toHaveBeenCalledOnce()
  })

  it("rolls back without staging a request when Stop already owns the Turn", async () => {
    const { pool, query, release } = fakePool("interrupted")

    const fence = await acquireApplicationSubmissionStartFence(pool, scope)

    expect(fence.state).toBe("stopped")
    expect(query.mock.calls.some(([sql]) => sql.includes("UPDATE application_tasks"))).toBe(false)
    expect(query).toHaveBeenLastCalledWith("ROLLBACK")
    expect(release).toHaveBeenCalledOnce()
  })

  it("rolls back when the approved ApplicationTask is no longer active", async () => {
    const query = vi.fn(async (sql: string) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ status: "running" }], rowCount: 1 }
      if (sql.includes('FROM "agent_turns"')) return { rows: [{ status: "in_progress" }], rowCount: 1 }
      if (sql.includes('FROM "agent_events"')) return { rows: [{ stopped: false }], rowCount: 1 }
      if (sql.includes("UPDATE application_tasks")) return { rows: [], rowCount: 0 }
      throw new Error(`Unexpected query: ${sql}`)
    })
    const release = vi.fn()
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) } as unknown as Pool

    const fence = await acquireApplicationSubmissionStartFence(pool, scope)

    expect(fence.state).toBe("inactive")
    expect(query).toHaveBeenLastCalledWith("ROLLBACK")
    expect(release).toHaveBeenCalledOnce()
  })

  it("checks the scoped session, Turn, and interruption event", async () => {
    const { pool, query, release } = fakePool()

    await expect(isApplicationSubmissionStopped(pool, scope)).resolves.toBe(false)

    expect(query).toHaveBeenCalledWith(expect.stringContaining('"id" = $1 AND "sessionId" = $2 AND "userId" = $3'), ["turn_1", "session_1", "user_1"])
    expect(query).toHaveBeenCalledWith(expect.stringContaining("turn.interrupted"), ["session_1", "turn_1"])
    expect(release).toHaveBeenCalledOnce()
  })

  it.each([["interrupted", false], ["in_progress", true]] as const)("detects stopped state from Turn status or event", async (turnStatus, interrupted) => {
    const { pool } = fakePool(turnStatus, interrupted)
    await expect(isApplicationSubmissionStopped(pool, scope)).resolves.toBe(true)
  })

  it("aborts the active browser best effort after observing Stop", async () => {
    vi.useFakeTimers()
    const { pool } = fakePool("interrupted")
    const closePage = vi.fn().mockResolvedValue(undefined)
    const onStopped = vi.fn()
    const controller = new AbortController()
    const probe = startApplicationSubmissionStopProbe({
      pool, scope, closePage, controller, hasSubmissionStarted: () => false,
      onStopped, onUnavailable: vi.fn(), intervalMs: 100_000,
    })

    await probe.pollNow()
    probe.stop()

    expect(onStopped).toHaveBeenCalledOnce()
    expect(closePage).toHaveBeenCalledOnce()
    expect(controller.signal.aborted).toBe(true)
  })

  it("reports state-store failures without treating them as Stop", async () => {
    const onUnavailable = vi.fn()
    const controller = new AbortController()
    const closePage = vi.fn().mockResolvedValue(undefined)
    const probe = startApplicationSubmissionStopProbe({
      pool: { connect: vi.fn().mockRejectedValue(new Error("database unavailable")) } as unknown as Pool,
      scope, closePage, controller, hasSubmissionStarted: () => false,
      onStopped: vi.fn(), onUnavailable, intervalMs: 100_000,
    })

    await probe.pollNow()
    probe.stop()

    expect(onUnavailable).toHaveBeenCalledWith(expect.objectContaining({ message: "database unavailable" }))
    expect(controller.signal.aborted).toBe(true)
    expect(closePage).toHaveBeenCalledOnce()
  })

  it("does not treat a post-checkpoint probe error as a Stop", async () => {
    const controller = new AbortController()
    const closePage = vi.fn().mockResolvedValue(undefined)
    const probe = startApplicationSubmissionStopProbe({
      pool: { connect: vi.fn().mockRejectedValue(new Error("database unavailable")) } as unknown as Pool,
      scope, closePage, controller, hasSubmissionStarted: () => true,
      onStopped: vi.fn(), onUnavailable: vi.fn(), intervalMs: 100_000,
    })

    await probe.pollNow()
    probe.stop()

    expect(controller.signal.aborted).toBe(false)
    expect(closePage).not.toHaveBeenCalled()
  })
})
