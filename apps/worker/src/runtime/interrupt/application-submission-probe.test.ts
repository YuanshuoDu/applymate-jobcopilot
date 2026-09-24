import type { Pool } from "pg"
import { afterEach, describe, expect, it, vi } from "vitest"
import { isApplicationSubmissionStopped, startApplicationSubmissionStopProbe } from "./application-submission-probe.js"

const scope = { userId: "user_1", sessionId: "session_1", turnId: "turn_1", applicationTaskId: "task_1", jobId: "job_1" }

function fakePool(options: {
  sessionStatus?: string
  turnStatus?: string
  interrupted?: boolean
  missingSession?: boolean
  missingTurn?: boolean
} = {}) {
  const query = vi.fn(async (sql: string) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
    if (sql.includes('FROM "agent_sessions"')) return { rows: options.missingSession ? [] : [{ status: options.sessionStatus ?? "running" }], rowCount: options.missingSession ? 0 : 1 }
    if (sql.includes('FROM "agent_turns"')) return { rows: options.missingTurn ? [] : [{ status: options.turnStatus ?? "in_progress" }], rowCount: options.missingTurn ? 0 : 1 }
    if (sql.includes('FROM "agent_events"')) return { rows: [{ stopped: options.interrupted ?? false }], rowCount: 1 }
    throw new Error(`Unexpected query: ${sql}`)
  })
  const release = vi.fn()
  return { pool: { connect: vi.fn().mockResolvedValue({ query, release }) } as unknown as Pool, query, release }
}

afterEach(() => vi.useRealTimers())

describe("application submission Stop probe", () => {
  it("checks scoped session, Turn, and interruption event in a short read transaction", async () => {
    const { pool, query, release } = fakePool()

    await expect(isApplicationSubmissionStopped(pool, scope)).resolves.toBe(false)

    expect(query).toHaveBeenCalledWith(expect.stringContaining('"id" = $1 AND "sessionId" = $2 AND "userId" = $3'), ["turn_1", "session_1", "user_1"])
    expect(query).toHaveBeenCalledWith(expect.stringContaining("turn.interrupted"), ["session_1", "turn_1"])
    expect(query).toHaveBeenLastCalledWith("COMMIT")
    expect(release).toHaveBeenCalledOnce()
  })

  it.each([
    ["aborted session", { sessionStatus: "aborted" }],
    ["archived session", { sessionStatus: "archived" }],
    ["interrupted Turn", { turnStatus: "interrupted" }],
    ["durable interruption event", { interrupted: true }],
  ] as const)("detects Stop from %s", async (_label, options) => {
    const { pool } = fakePool(options)
    await expect(isApplicationSubmissionStopped(pool, scope)).resolves.toBe(true)
  })

  it.each(["completed", "failed"] as const)("does not treat natural %s session and Turn outcomes as Stop", async status => {
    vi.useFakeTimers()
    const { pool } = fakePool({ sessionStatus: status, turnStatus: status })
    const closePage = vi.fn().mockResolvedValue(undefined)
    const onStopped = vi.fn()
    const controller = new AbortController()
    const probe = startApplicationSubmissionStopProbe({
      pool, scope, closePage, controller, hasSubmissionStarted: () => true,
      onStopped, onUnavailable: vi.fn(), intervalMs: 100_000,
    })

    await expect(isApplicationSubmissionStopped(pool, scope)).resolves.toBe(false)
    await probe.pollNow()
    probe.stop()

    expect(onStopped).not.toHaveBeenCalled()
    expect(closePage).not.toHaveBeenCalled()
    expect(controller.signal.aborted).toBe(false)
  })

  it("fails closed when the scoped Session or Turn is missing", async () => {
    const missingSession = fakePool({ missingSession: true })
    const missingTurn = fakePool({ missingTurn: true })

    await expect(isApplicationSubmissionStopped(missingSession.pool, scope)).rejects.toThrow("Stop scope is unavailable")
    await expect(isApplicationSubmissionStopped(missingTurn.pool, scope)).rejects.toThrow("Stop scope is unavailable")
  })

  it("aborts and closes the active browser best effort after observing Stop", async () => {
    vi.useFakeTimers()
    const { pool } = fakePool({ turnStatus: "interrupted" })
    const closePage = vi.fn().mockResolvedValue(undefined)
    const onStopped = vi.fn()
    const controller = new AbortController()
    const probe = startApplicationSubmissionStopProbe({
      pool, scope, closePage, controller, hasSubmissionStarted: () => true,
      onStopped, onUnavailable: vi.fn(), intervalMs: 100_000,
    })

    await probe.pollNow()
    probe.stop()

    expect(onStopped).toHaveBeenCalledOnce()
    expect(closePage).toHaveBeenCalledOnce()
    expect(controller.signal.aborted).toBe(true)
  })

  it("aborts and closes before the checkpoint when Stop state cannot be checked", async () => {
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

  it("does not abort or close after the checkpoint when Stop state polling fails", async () => {
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