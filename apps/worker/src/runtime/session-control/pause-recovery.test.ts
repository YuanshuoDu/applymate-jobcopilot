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

function fixture(options: { readonly markerRowCount?: number } = {}) {
  const rows = [
    { userId: "user-a", sessionId: "session-a", turnId: "turn-a", status: "pausing" },
    { userId: "user-b", sessionId: "session-b", turnId: "turn-b", status: "resuming" },
  ]
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      const statement = sql.trim()
      if (statement === "BEGIN") controls.order.push("begin")
      else if (statement === "COMMIT") controls.order.push("commit")
      else if (statement === "ROLLBACK") controls.order.push("rollback")
      else if (statement.startsWith('SELECT session."userId"')) controls.order.push("scan")
      else if (statement.startsWith('UPDATE "agent_sessions"')) controls.order.push("mark")

      if (statement.startsWith('SELECT session."userId"')) return { rows, rowCount: rows.length, sql, values }
      if (statement.startsWith('UPDATE "agent_sessions"')) {
        return { rows: [], rowCount: options.markerRowCount ?? rows.length, sql, values }
      }
      return { rows: [], rowCount: 0, sql, values }
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
    controls.pause.mockImplementation(async () => {
      controls.order.push("pause")
      return { state: "paused" }
    })
    controls.resume.mockImplementation(async () => {
      controls.order.push("resume")
      return { status: "queued" }
    })
  })

  it("claims bounded same-owner candidates and invokes coordinators only after commit and release", async () => {
    const fake = fixture()

    await expect(reconcilePendingSessionControls(fake.pool)).resolves.toEqual({ scanned: 2, reconciled: 2, failed: 0 })

    const scanCall = fake.client.query.mock.calls.find(([sql]) => sql.includes('FROM "agent_sessions" AS session'))
    const scanSql = scanCall?.[0] ?? ""
    expect(scanCall?.[1]).toEqual([SESSION_CONTROL_RECOVERY_MAX_BATCH])
    expect(scanSql).toContain('session."status" IN (\'pausing\', \'resuming\')')
    expect(scanSql).toContain('turn."userId" = session."userId"')
    expect(scanSql).toContain('event."sessionId" = session."id" AND event."turnId" = turn."id"')
    expect(scanSql).toContain('event."payload"->>\'turnId\' = turn."id"')
    expect(scanSql).toMatch(/ORDER BY COALESCE\(session\."sessionControlRecoveryAttemptedAt", session\."createdAt"\), session\."id"\s+LIMIT \$1\s+FOR UPDATE OF session SKIP LOCKED/)
    expect(fake.client.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "agent_sessions"'),
      [["session-a", "session-b"]],
    )
    const markerSql = fake.client.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE "agent_sessions"'))?.[0] ?? ""
    expect(markerSql).toContain('SET "sessionControlRecoveryAttemptedAt" = NOW()')
    expect(markerSql).not.toContain('"updatedAt"')
    expect(markerSql).not.toContain('"status"')
    expect(controls.order).toEqual(["begin", "scan", "mark", "commit", "release", "pause", "resume"])
    expect(fake.client.release).toHaveBeenCalledOnce()
    expect(controls.pause).toHaveBeenCalledWith(fake.pool, { userId: "user-a", sessionId: "session-a", turnId: "turn-a" })
    expect(controls.resume).toHaveBeenCalledWith(fake.pool, { userId: "user-b", sessionId: "session-b", turnId: "turn-b" })
    expect(controls.pause.mock.invocationCallOrder[0]).toBeLessThan(controls.resume.mock.invocationCallOrder[0])
  })

  it("rolls back and skips coordinators when the marker update does not claim every selected Session", async () => {
    const fake = fixture({ markerRowCount: 1 })

    await expect(reconcilePendingSessionControls(fake.pool)).rejects.toThrow("session_control_recovery_claim_conflict")

    expect(fake.client.query.mock.calls.map(([sql]) => sql.trim())).toEqual([
      "BEGIN",
      expect.stringContaining('FROM "agent_sessions" AS session'),
      expect.stringContaining('UPDATE "agent_sessions"'),
      "ROLLBACK",
    ])
    expect(fake.client.release).toHaveBeenCalledOnce()
    expect(controls.pause).not.toHaveBeenCalled()
    expect(controls.resume).not.toHaveBeenCalled()
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
