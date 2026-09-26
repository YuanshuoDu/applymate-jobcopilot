import type { Pool } from "pg"
import { afterEach, describe, expect, it, vi } from "vitest"
import { acquireApplicationSubmissionStartFence, isApplicationSubmissionStopped, startApplicationSubmissionStopProbe } from "./application-submission-probe.js"

const scope = { userId: "user_1", sessionId: "session_1", turnId: "turn_1", applicationTaskId: "task_1", jobId: "job_1" }

function fakePool(turnStatus = "in_progress", interrupted = false, markerRowCount = 1, markerCommitFails = false) {
  const query = vi.fn(async (sql: string) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
    if (sql.includes('FROM "agent_sessions"')) return { rows: [{ status: "running" }], rowCount: 1 }
    if (sql.includes('FROM "agent_turns"')) return { rows: [{ status: turnStatus }], rowCount: 1 }
    if (sql.includes('FROM "agent_events"')) return { rows: [{ stopped: interrupted }], rowCount: 1 }
    throw new Error(`Unexpected query: ${sql}`)
  })
  const markerQuery = vi.fn(async (sql: string) => {
    if (sql === "COMMIT" && markerCommitFails) throw new Error("connection lost during marker commit")
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
    if (sql.includes("UPDATE application_tasks")) return { rows: markerRowCount === 1 ? [{ id: "task_1" }] : [], rowCount: markerRowCount }
    throw new Error(`Unexpected marker query: ${sql}`)
  })
  const release = vi.fn()
  const markerRelease = vi.fn()
  let connections = 0
  const connect = vi.fn(async () => {
    connections += 1
    return connections % 2 === 1
      ? { query, release }
      : { query: markerQuery, release: markerRelease }
  })
  return {
    pool: { connect } as unknown as Pool,
    query,
    markerQuery,
    release,
    markerRelease,
    connect,
  }
}

afterEach(() => vi.useRealTimers())

describe("application submission Stop probe", () => {
  it("holds Session and Turn locks until the browser request boundary is released", async () => {
    const { pool, query, markerQuery, release, markerRelease, connect } = fakePool()
    const fence = await acquireApplicationSubmissionStartFence(pool, scope)

    expect(fence.state).toBe("ready")
    const statements = query.mock.calls.map(([sql]) => sql)
    const sessionLock = statements.findIndex(sql => sql.includes('FROM "agent_sessions"'))
    const turnLock = statements.findIndex(sql => sql.includes('FROM "agent_turns"'))
    expect(connect.mock.invocationCallOrder[1]).toBeLessThan(query.mock.invocationCallOrder[sessionLock])
    expect(statements.indexOf("BEGIN")).toBeLessThan(sessionLock)
    expect(sessionLock).toBeLessThan(turnLock)
    expect(statements.some(sql => sql.includes("UPDATE application_tasks"))).toBe(false)
    expect(query).not.toHaveBeenCalledWith("COMMIT")
    expect(release).not.toHaveBeenCalled()
    expect(markerQuery.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      "SELECT set_config($1, $2, true)",
      expect.stringContaining("submission_request_started"),
      "COMMIT",
    ])
    expect(markerRelease).toHaveBeenCalledOnce()

    await fence.release(true)

    expect(query).toHaveBeenLastCalledWith("COMMIT")
    expect(release).toHaveBeenCalledOnce()
  })

  it("waits to check out a second fence client until the first releases its row locks", async () => {
    const { pool, query, connect } = fakePool()
    const first = await acquireApplicationSubmissionStartFence(pool, scope)
    const secondAttempt = acquireApplicationSubmissionStartFence(pool, scope)

    expect(connect).toHaveBeenCalledTimes(2)
    expect(query).not.toHaveBeenCalledWith("COMMIT")

    await first.release(true)
    const second = await secondAttempt

    expect(connect).toHaveBeenCalledTimes(4)
    const statements = query.mock.calls.map(([sql]) => sql)
    const firstCommit = statements.indexOf("COMMIT")
    const secondBegin = statements.indexOf("BEGIN", firstCommit + 1)
    expect(firstCommit).toBeGreaterThanOrEqual(0)
    expect(secondBegin).toBeGreaterThan(firstCommit)

    await second.release(true)
  })

  it("releases its permit after a decline or a pool checkout error", async () => {
    const release = vi.fn()
    const markerRelease = vi.fn()
    const query = vi.fn(async (sql: string) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ status: "running" }], rowCount: 1 }
      if (sql.includes('FROM "agent_turns"')) return { rows: [{ status: "interrupted" }], rowCount: 1 }
      if (sql.includes('FROM "agent_events"')) return { rows: [{ stopped: false }], rowCount: 1 }
      throw new Error(`Unexpected query: ${sql}`)
    })
    const client = { query, release }
    const markerClient = { query, release: markerRelease }
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error("injected pool checkout failure"))
      .mockResolvedValueOnce(client)
      .mockResolvedValueOnce(markerClient)
    const pool = { connect } as unknown as Pool

    await expect(acquireApplicationSubmissionStartFence(pool, scope)).rejects.toThrow("injected pool checkout failure")
    await expect(acquireApplicationSubmissionStartFence(pool, scope)).resolves.toMatchObject({ state: "stopped" })

    expect(connect).toHaveBeenCalledTimes(3)
    expect(release).toHaveBeenCalledOnce()
    expect(markerRelease).toHaveBeenCalledOnce()
  })

  it("releases the first client and permit when reserving the marker client fails", async () => {
    const { query, markerQuery } = fakePool()
    const firstRelease = vi.fn()
    const nextFenceRelease = vi.fn()
    const markerRelease = vi.fn()
    const connect = vi.fn()
      .mockResolvedValueOnce({ query, release: firstRelease })
      .mockRejectedValueOnce(new Error("injected marker checkout failure"))
      .mockResolvedValueOnce({ query, release: nextFenceRelease })
      .mockResolvedValueOnce({ query: markerQuery, release: markerRelease })
    const pool = { connect } as unknown as Pool

    await expect(acquireApplicationSubmissionStartFence(pool, scope)).rejects.toThrow("injected marker checkout failure")
    expect(firstRelease).toHaveBeenCalledOnce()

    const fence = await acquireApplicationSubmissionStartFence(pool, scope)
    expect(fence.state).toBe("ready")
    expect(connect).toHaveBeenCalledTimes(4)
    await fence.release(false)
    expect(nextFenceRelease).toHaveBeenCalledOnce()
    expect(markerRelease).toHaveBeenCalledOnce()
  })

  it("releases both reserved clients and the permit when lock setup fails", async () => {
    const { pool, query, release, markerRelease, connect } = fakePool()
    query.mockRejectedValueOnce(new Error("injected lock setup failure"))

    await expect(acquireApplicationSubmissionStartFence(pool, scope)).rejects.toThrow("injected lock setup failure")
    expect(connect).toHaveBeenCalledTimes(2)
    expect(release).toHaveBeenCalledOnce()
    expect(markerRelease).toHaveBeenCalledOnce()

    const fence = await acquireApplicationSubmissionStartFence(pool, scope)
    expect(fence.state).toBe("ready")
    expect(connect).toHaveBeenCalledTimes(4)
    await fence.release(false)
  })

  it("rolls back without staging a request when Stop already owns the Turn", async () => {
    const { pool, query, markerQuery, release, markerRelease } = fakePool("interrupted")

    const fence = await acquireApplicationSubmissionStartFence(pool, scope)

    expect(fence.state).toBe("stopped")
    expect(markerQuery).not.toHaveBeenCalled()
    expect(query).toHaveBeenLastCalledWith("ROLLBACK")
    expect(release).toHaveBeenCalledOnce()
    expect(markerRelease).toHaveBeenCalledOnce()
  })

  it("rolls back when the approved ApplicationTask is no longer active", async () => {
    const { pool, query, markerQuery, release, markerRelease } = fakePool("in_progress", false, 0)

    const fence = await acquireApplicationSubmissionStartFence(pool, scope)

    expect(fence.state).toBe("inactive")
    expect(query).toHaveBeenLastCalledWith("ROLLBACK")
    expect(markerQuery).toHaveBeenLastCalledWith("ROLLBACK")
    expect(release).toHaveBeenCalledOnce()
    expect(markerRelease).toHaveBeenCalledOnce()
  })

  it("keeps the Stop row locks while marking a failed marker COMMIT uncertain", async () => {
    const { pool, query, markerQuery, release, markerRelease, connect } = fakePool("in_progress", false, 1, true)

    const fence = await acquireApplicationSubmissionStartFence(pool, scope)

    expect(fence.state).toBe("uncertain")
    expect(markerQuery).toHaveBeenCalledWith("COMMIT")
    expect(markerQuery).toHaveBeenCalledWith("ROLLBACK")
    expect(markerRelease).toHaveBeenCalledOnce()
    expect(query).not.toHaveBeenCalledWith("COMMIT")
    expect(query).not.toHaveBeenCalledWith("ROLLBACK")
    expect(release).not.toHaveBeenCalled()

    const secondAttempt = acquireApplicationSubmissionStartFence(pool, scope)
    expect(connect).toHaveBeenCalledTimes(2)

    await fence.release(false)

    const secondFence = await secondAttempt
    expect(connect).toHaveBeenCalledTimes(4)
    await secondFence.release(false)

    expect(query.mock.calls.filter(([sql]) => sql === "ROLLBACK")).toHaveLength(2)
    expect(release).toHaveBeenCalledTimes(2)
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
