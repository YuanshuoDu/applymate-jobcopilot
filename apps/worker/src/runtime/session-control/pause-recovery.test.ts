import { beforeEach, describe, expect, it, vi } from "vitest"

const controls = vi.hoisted(() => ({
  pause: vi.fn(),
  resume: vi.fn(),
  order: [] as string[],
}))

vi.mock("./pause-coordinator.js", () => ({
  reconcileSessionPause: controls.pause,
  resumeSession: controls.resume,
}))

import { reconcilePendingSessionControls, SESSION_CONTROL_RECOVERY_MAX_BATCH } from "./pause-recovery.js"

function fixture() {
  const rows = [
    { userId: "user-a", sessionId: "session-a", turnId: "turn-a", status: "pausing" },
    { userId: "user-b", sessionId: "session-b", turnId: "turn-b", status: "resuming" },
  ]
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      controls.order.push("scan")
      return { rows, rowCount: rows.length, sql, values }
    }),
    release: vi.fn(() => controls.order.push("release")),
  }
  const pool = { connect: vi.fn().mockResolvedValue(client) }
  return { pool, client }
}

describe("session control recovery scan", () => {
  beforeEach(() => {
    controls.pause.mockReset()
    controls.resume.mockReset()
    controls.order.length = 0
    controls.pause.mockResolvedValue({ state: "paused" })
    controls.resume.mockResolvedValue({ status: "queued" })
  })

  it("scans bounded same-owner control candidates and invokes the coordinator after releasing the scan connection", async () => {
    const fake = fixture()

    await expect(reconcilePendingSessionControls(fake.pool)).resolves.toEqual({ scanned: 2, reconciled: 2, failed: 0 })

    const [sql, values] = fake.client.query.mock.calls[0] as unknown as [string, unknown[]]
    expect(values).toEqual([SESSION_CONTROL_RECOVERY_MAX_BATCH])
    expect(sql).toContain('session."status" IN (\'pausing\', \'resuming\')')
    expect(sql).toContain('turn."userId" = session."userId"')
    expect(sql).toContain('event."sessionId" = session."id" AND event."turnId" = turn."id"')
    expect(sql).toContain('event."payload"->>\'turnId\' = turn."id"')
    expect(sql).toContain('LIMIT $1')
    expect(fake.client.release).toHaveBeenCalledOnce()
    expect(controls.pause).toHaveBeenCalledWith(fake.pool, { userId: "user-a", sessionId: "session-a", turnId: "turn-a" })
    expect(controls.resume).toHaveBeenCalledWith(fake.pool, { userId: "user-b", sessionId: "session-b", turnId: "turn-b" })
    expect(controls.order).toEqual(["scan", "release"])
    expect(controls.pause.mock.invocationCallOrder[0]).toBeLessThan(controls.resume.mock.invocationCallOrder[0])
  })

  it("continues to the next candidate after an individual coordinator failure", async () => {
    const fake = fixture()
    const error = new Error("unavailable")
    controls.pause.mockRejectedValueOnce(error)
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)

    await expect(reconcilePendingSessionControls(fake.pool)).resolves.toEqual({ scanned: 2, reconciled: 1, failed: 1 })

    expect(controls.resume).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith("[session-control-recovery] candidate reconciliation failed:", {
      sessionId: "session-a",
      status: "pausing",
      error,
    })
    log.mockRestore()
  })
})
