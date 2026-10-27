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

function fixture(options: { readonly markerRowCount?: number; readonly renewalRowCounts?: number[] } = {}) {
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
      else if (statement.startsWith('UPDATE "agent_sessions"') && statement.includes('SET "sessionControlRecoveryAttemptedAt"')) controls.order.push("claim")
      else if (statement.startsWith('UPDATE "agent_sessions"') && statement.includes('SET "sessionControlRecoveryClaimExpiresAt"')) controls.order.push("renew")
      else if (statement.startsWith('UPDATE "agent_sessions"') && statement.includes('SET "sessionControlRecoveryClaimToken" = NULL')) controls.order.push("clear")

      if (statement.startsWith('SELECT session."userId"')) return { rows, rowCount: rows.length, sql, values }
      if (statement.includes('SET "sessionControlRecoveryAttemptedAt"')) {
        return { rows: [], rowCount: options.markerRowCount ?? rows.length, sql, values }
      }
      if (statement.includes('SET "sessionControlRecoveryClaimExpiresAt"')) {
        return { rows: [], rowCount: options.renewalRowCounts?.shift() ?? 1, sql, values }
      }
      if (statement.includes('SET "sessionControlRecoveryClaimToken" = NULL')) {
        return { rows: [], rowCount: 1, sql, values }
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
    expect(scanSql).toContain('session."sessionControlRecoveryClaimToken" IS NULL')
    expect(scanSql).toContain('session."sessionControlRecoveryClaimExpiresAt" <= clock_timestamp()')
    expect(scanSql).toMatch(/ORDER BY COALESCE\(session\."sessionControlRecoveryAttemptedAt", session\."createdAt"\), session\."id"\s+LIMIT \$1\s+FOR UPDATE OF session SKIP LOCKED/)
    expect(fake.client.query).toHaveBeenCalledWith(
      expect.stringContaining('SET "sessionControlRecoveryAttemptedAt" = NOW()'),
      [["session-a", "session-b"], expect.any(Array)],
    )
    const markerSql = fake.client.query.mock.calls.find(([sql]) => sql.includes('SET "sessionControlRecoveryAttemptedAt"'))?.[0] ?? ""
    expect(markerSql).toContain('SET "sessionControlRecoveryAttemptedAt" = NOW()')
    expect(markerSql).toContain('"sessionControlRecoveryClaimToken" = claim."claimToken"')
    expect(markerSql).toContain('"sessionControlRecoveryClaimExpiresAt" = clock_timestamp() + INTERVAL \'2 minutes\'')
    expect(markerSql).not.toContain('"updatedAt"')
    expect(markerSql).not.toContain('SET "status"')
    expect(controls.order).toEqual(["begin", "scan", "claim", "commit", "release", "renew", "release", "pause", "clear", "release", "renew", "release", "resume", "clear", "release"])
    expect(fake.client.release).toHaveBeenCalledTimes(5)
    expect(controls.pause).toHaveBeenCalledWith(fake.pool, expect.objectContaining({ userId: "user-a", sessionId: "session-a", turnId: "turn-a", recoveryClaimToken: expect.any(String) }))
    expect(controls.resume).toHaveBeenCalledWith(fake.pool, expect.objectContaining({ userId: "user-b", sessionId: "session-b", turnId: "turn-b", recoveryClaimToken: expect.any(String) }))
    expect(controls.pause.mock.calls[0]?.[1].recoveryClaimToken).not.toBe(controls.resume.mock.calls[0]?.[1].recoveryClaimToken)
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

  it("clears each exact claim after renewal failure without calling a coordinator", async () => {
    const fake = fixture({ renewalRowCounts: [0, 0] })
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)

    await expect(reconcilePendingSessionControls(fake.pool)).resolves.toEqual({ scanned: 2, reconciled: 0, failed: 2 })

    const clears = fake.client.query.mock.calls.filter(([sql]) => sql.includes('SET "sessionControlRecoveryClaimToken" = NULL'))
    expect(clears).toHaveLength(2)
    expect(clears.map(([, values]) => values)).toEqual([
      ["session-a", expect.any(String)],
      ["session-b", expect.any(String)],
    ])
    expect(clears[0]?.[0]).toContain('WHERE "id" = $1 AND "sessionControlRecoveryClaimToken" = $2')
    expect(controls.pause).not.toHaveBeenCalled()
    expect(controls.resume).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledTimes(2)
    log.mockRestore()
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
