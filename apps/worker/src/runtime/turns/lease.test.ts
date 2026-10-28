import { describe, expect, it, vi } from "vitest"

import {
  claimTurnLease,
  expireTurnLease,
  interruptTurnLease,
  releaseTurnLease,
  renewTurnLease,
  TurnLeaseError,
  TURN_MAX_LEASE_MS,
  type LeasePool,
  type TurnLease,
} from "./lease.js"

const now = new Date("2026-09-01T00:00:00.000Z")
const row = {
  id: "turn_1", sessionId: "session_1", userId: "user_1", rootTaskId: null, leaseOwnerId: "owner_1", leaseVersion: 8,
  leaseStartedAt: now, leaseExpiresAt: new Date(now.getTime() + 60_000),
}

function fakePool(rows: unknown[] = [row], sessionStatus = "running", sessionUserId = "user_1", rootRows?: unknown[]) {
  const calls: Array<[string, unknown[]?]> = []
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      if (sql.includes("pg_current_xact_id")) return { rows: [{ xid8: "42" }], rowCount: 1 }
      if (sql.includes('SELECT session."userId"')) {
        return ["missing", "aborted", "archived"].includes(sessionStatus) ? { rows: [], rowCount: 0 } : { rows: [{ userId: sessionUserId }], rowCount: 1 }
      }
      if (sql.includes('SELECT session."id" FROM "agent_sessions"')) {
        return sessionStatus === "running" ? { rows: [{ id: "session_1" }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (sql.includes('UPDATE "sub_agent_tasks"')) return { rows: rootRows ?? rows, rowCount: (rootRows ?? rows).length }
      if (sql.includes('UPDATE "agent_turns"') && ["missing", "aborted", "archived"].includes(sessionStatus)) return { rows: [], rowCount: 0 }
      if (sql.includes('UPDATE "agent_turns"') && sessionUserId !== "user_1") return { rows: [], rowCount: 0 }
      return { rows, rowCount: rows.length }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) }, client, calls }
}

type PersistedFailure = {
  turnId: string; sessionId: string; userId: string; leaseVersion: number
  turnStatus: string; turnError: string; rootStatus: string; rootFailureReason: string; terminalEvents: boolean
}

const persistedNoProgress: PersistedFailure = {
  turnId: row.id, sessionId: row.sessionId, userId: row.userId, leaseVersion: row.leaseVersion,
  turnStatus: "failed", turnError: "no_progress", rootStatus: "failed", rootFailureReason: "no_progress", terminalEvents: true,
}

function noProgressReceiptPool(overrides: Partial<PersistedFailure> = {}) {
  const persisted = { ...persistedNoProgress, ...overrides }
  const calls: Array<[string, unknown[]?]> = []
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push([sql, values])
      if (sql.includes("pg_current_xact_id")) return { rows: [{ xid8: "42" }], rowCount: 1 }
      if (sql.includes('SELECT session."id" FROM "agent_sessions"')) {
        return values?.[0] === persisted.sessionId && values?.[1] === persisted.userId
          ? { rows: [{ id: persisted.sessionId }], rowCount: 1 }
          : { rows: [], rowCount: 0 }
      }
      if (sql.includes('UPDATE "agent_turns"')) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_turns" AS turn')) {
        const sameIdentity = values?.[0] === persisted.turnId && values?.[1] === persisted.sessionId
          && values?.[2] === persisted.userId && values?.[3] === persisted.leaseVersion
        const exactFailure = persisted.turnStatus === "failed" && persisted.turnError === "no_progress"
          && persisted.rootStatus === "failed" && persisted.rootFailureReason === "no_progress" && persisted.terminalEvents
        return sameIdentity && exactFailure ? { rows: [{ id: persisted.turnId }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (sql.includes('SELECT "rootTaskId" FROM "agent_turns"')) return { rows: [{ rootTaskId: "root-turn-1" }], rowCount: 1 }
      if (sql.includes('FROM "agent_events"')) {
        const event = { id: "event-turn-failed", sessionId: persisted.sessionId, turnId: persisted.turnId, taskId: "root-turn-1",
          itemId: "final-item", sequence: "12", type: "turn.failed", actor: "orchestrator", correlationId: persisted.turnId,
          causationId: "event-final", idempotencyKey: `turn:${persisted.turnId}:event:turn-failed:no_progress`,
          payload: { turnId: persisted.turnId, taskId: "root-turn-1", errorCode: "no_progress", finalItemId: "final-item", final: {} } }
        if (sql.includes('WHERE "id"=$1 AND "sessionId"=$2')) return values?.[0] === event.id ? { rows: [event], rowCount: 1 } : { rows: [], rowCount: 0 }
        return values?.[2] === event.idempotencyKey ? { rows: [{ id: event.id }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (sql.includes('FROM "agent_outbox"')) {
        const eventId = "event-turn-failed"
        const outbox = { id: `agent-outbox-${eventId}`, topic: "agent.events", aggregateId: persisted.sessionId,
          idempotencyKey: `agent-event:${eventId}`, payload: { eventId, sessionId: persisted.sessionId, turnId: persisted.turnId,
            taskId: "root-turn-1", itemId: "final-item", sequence: "12", type: "turn.failed", actor: "orchestrator",
            correlationId: persisted.turnId, causationId: "event-final", idempotencyKey: `turn:${persisted.turnId}:event:turn-failed:no_progress`,
            payload: { turnId: persisted.turnId, taskId: "root-turn-1", errorCode: "no_progress", finalItemId: "final-item", final: {} } } }
        return values?.[0] === outbox.idempotencyKey || values?.[1] === outbox.id ? { rows: [outbox], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) }, client, calls }
}

const payload = { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" }

describe("database Turn lease", () => {
  it("claims through one conditional UPDATE and returns a fencing token", async () => {
    const fake = fakePool()
    const result = await claimTurnLease(fake.pool, payload, now)
    expect(result).toMatchObject({ ...payload, userId: "user_1", leaseVersion: 8 })
    expect(fake.calls.filter(([sql]) => sql.includes('UPDATE "agent_turns"')).length).toBe(1)
    expect(fake.calls.find(([sql]) => sql.includes('UPDATE "agent_turns"'))?.[0]).toContain("status\" = 'queued'")
    expect(fake.calls.find(([sql]) => sql.includes('SELECT session."userId"'))?.[0]).toContain("status\" NOT IN ('aborted', 'archived')")
    expect(fake.calls.find(([sql]) => sql.includes('SELECT session."userId"'))?.[0]).not.toContain('controlGate')
    expect(fake.calls.find(([sql]) => sql.includes('SELECT session."userId"'))?.[0]).toContain("FOR UPDATE")
    expect(fake.calls.find(([sql]) => sql.includes('UPDATE "agent_turns"'))?.[0]).toContain('session."status" NOT IN (\'aborted\', \'archived\')')
    expect(fake.calls[0][0]).toBe("BEGIN")
    expect(fake.calls.findIndex(([sql]) => sql.includes('SELECT session."userId"'))).toBeLessThan(fake.calls.findIndex(([sql]) => sql.includes('UPDATE "agent_turns"')))
  })

  it.each(["missing", "aborted", "archived"])("does not claim a Turn whose session is %s", async (sessionStatus) => {
    const fake = fakePool([row], sessionStatus)

    await expect(claimTurnLease(fake.pool, payload, now)).rejects.toMatchObject({ code: "lease_not_available", recoverable: true })
    expect(fake.calls.some(([sql]) => sql.includes('UPDATE "agent_turns"'))).toBe(false)
    expect(fake.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true)
  })

  it("does not claim a Turn across a session owner boundary", async () => {
    const fake = fakePool([row], "running", "user-2")

    await expect(claimTurnLease(fake.pool, payload, now)).rejects.toMatchObject({ code: "lease_not_available" })
    expect(fake.calls.some(([sql]) => sql.includes('SELECT session."userId"'))).toBe(true)
    expect(fake.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true)
  })

  it("claims a Turn when its session is running", async () => {
    const fake = fakePool([row], "running")

    await expect(claimTurnLease(fake.pool, payload, now)).resolves.toMatchObject({ turnId: payload.turnId, sessionId: payload.sessionId, userId: row.userId })
    const sql = fake.calls.find(([text]) => text.includes('UPDATE "agent_turns"'))?.[0] ?? ""
    expect(sql).not.toContain('session."source"')
  })

  it.each(["queued", "paused", "waiting_for_user", "waiting_for_approval", "waiting_for_dependency", "pausing", "resuming"])("does not claim a Turn while its session is %s", async (sessionStatus) => {
    const fake = fakePool([row], sessionStatus)

    await expect(claimTurnLease(fake.pool, payload, now)).rejects.toMatchObject({ code: "lease_not_available" })
    expect(fake.calls.some(([sql]) => sql.includes('UPDATE "agent_turns"'))).toBe(false)
  })

  it.each(["pausing", "resuming"])("does not claim a Turn while Session control is %s", async sessionStatus => {
    const fake = fakePool([row], sessionStatus)
    await expect(claimTurnLease(fake.pool, payload, now)).rejects.toMatchObject({ code: "lease_not_available" })
    expect(fake.calls.some(([sql]) => sql.includes('UPDATE "agent_turns"'))).toBe(false)
    const gateIndex = fake.calls.findIndex(([sql]) => sql.includes("pause_request"))
    expect(fake.calls.findIndex(([sql]) => sql.includes('SELECT session."userId"'))).toBeLessThan(gateIndex)
  })

  it("keeps in-flight lease cleanup on the open-session fence", async () => {
    const fake = fakePool()
    const current: TurnLease = { ...payload, userId: row.userId, leaseVersion: row.leaseVersion, leaseStartedAt: now, leaseExpiresAt: row.leaseExpiresAt }

    await expect(releaseTurnLease(fake.pool, current, "completed", now)).resolves.toBe(true)
    const sql = fake.calls.find(([text]) => text.includes('SET "status" = $5'))?.[0] ?? ""
    expect(sql).not.toContain('session."controlGate"')
    expect(fake.calls.some(([text]) => text.includes('session."status" NOT IN (\'aborted\', \'archived\')'))).toBe(true)
  })

  it("returns a typed recoverable error to a duplicate claimant", async () => {
    const fake = fakePool([])
    await expect(claimTurnLease(fake.pool, payload, now)).rejects.toBeInstanceOf(TurnLeaseError)
    await expect(claimTurnLease(fake.pool, payload, now)).rejects.toMatchObject({ code: "lease_not_available", recoverable: true })
  })

  it("allows exactly one winner across 100 concurrent claim attempts", async () => {
    let claimed = false
    const clients = Array.from({ length: 100 }, () => ({
      query: vi.fn(async (sql: string) => {
        if (sql.includes('UPDATE "agent_turns"')) {
          if (claimed) return { rows: [], rowCount: 0 }
          claimed = true
          return { rows: [row], rowCount: 1 }
        }
        if (sql.includes('SELECT session."userId"')) return { rows: [{ userId: "user_1" }], rowCount: 1 }
        if (sql.includes('SELECT session."id" FROM "agent_sessions"')) return { rows: [{ id: "session_1" }], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }))
    const fake = { connect: vi.fn(async () => clients.shift()!) } as unknown as LeasePool
    const results = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => claimTurnLease(
      fake,
      { ...payload, ownerId: `owner_${index}` },
      now,
    )))
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected" && result.reason instanceof TurnLeaseError && result.reason.code === "lease_not_available")).toHaveLength(99)
  })

  it("renews a startup Turn without a Root and fences the owner/version/deadlines", async () => {
    const fake = fakePool([{ ...row, leaseExpiresAt: new Date(now.getTime() + 120_000) }])
    const current: TurnLease = { ...payload, userId: row.userId, leaseVersion: row.leaseVersion, leaseStartedAt: now, leaseExpiresAt: row.leaseExpiresAt }
    const result = await renewTurnLease(fake.pool, current, new Date(now.getTime() + 20_000))
    expect(result).not.toBeNull()
    expect(row.rootTaskId).toBeNull()
    expect(result?.leaseVersion).toBe(row.leaseVersion)
    const sql = fake.calls.find(([text]) => text.includes('UPDATE "agent_turns"'))?.[0] ?? ""
    expect(sql).toContain('"leaseOwnerId" = $3')
    expect(sql).toContain('"leaseVersion" = $4')
    expect(sql).toContain('"status" = \'in_progress\'')
    expect(sql).toContain('"leaseExpiresAt" > $6')
    expect(sql).toContain('"leaseStartedAt" + ($7 * INTERVAL \'1 millisecond\') > $6')
    expect(sql).toContain("LEAST")
    expect(sql).not.toContain('"rootTaskId" =')
    expect(fake.calls.find(([text]) => text.includes('UPDATE "agent_turns"'))?.[1]).toContain(TURN_MAX_LEASE_MS)
    expect(fake.calls.some(([text]) => text.includes('UPDATE "sub_agent_tasks"'))).toBe(false)
  })

  it("syncs only the exact running Root to the bounded renewed Turn expiry after locking the Turn", async () => {
    const rootTaskId = "root_turn_1"
    const renewedExpiry = new Date(now.getTime() + 80_000)
    const linkedTurn = { ...row, rootTaskId, leaseExpiresAt: renewedExpiry }
    const fake = fakePool([linkedTurn], "running", "user_1", [{ id: rootTaskId }])
    const current: TurnLease = { ...payload, userId: row.userId, leaseVersion: row.leaseVersion, leaseStartedAt: now, leaseExpiresAt: row.leaseExpiresAt }

    const result = await renewTurnLease(fake.pool, current, new Date(now.getTime() + 20_000))
    const sessionLock = fake.calls.findIndex(([sql]) => sql.includes('SELECT session."id" FROM "agent_sessions"'))
    const turnWrite = fake.calls.findIndex(([sql]) => sql.includes('UPDATE "agent_turns"'))
    const rootWrite = fake.calls.findIndex(([sql]) => sql.includes('UPDATE "sub_agent_tasks"'))
    const [sql, params] = fake.calls[rootWrite] ?? ["", []]

    expect(result?.leaseExpiresAt).toEqual(renewedExpiry)
    expect(sessionLock).toBeGreaterThan(-1)
    expect(turnWrite).toBeGreaterThan(sessionLock)
    expect(turnWrite).toBeGreaterThan(-1)
    expect(rootWrite).toBeGreaterThan(turnWrite)
    expect(fake.calls.at(-1)?.[0]).toBe("COMMIT")
    expect(sql).toContain('SET "leaseExpiresAt" = turn."leaseExpiresAt"')
    expect(sql).toContain('turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3')
    expect(sql).toContain('turn."leaseOwnerId" = $4 AND turn."leaseVersion" = $5 AND turn."status" = \'in_progress\'')
    expect(sql).toContain('turn."rootTaskId" = $6')
    expect(sql).toContain('root."id" = turn."rootTaskId" AND root."sessionId" = $2 AND root."turnId" = $1')
    expect(sql).toContain('root."rootTaskId" = root."id" AND root."parentTaskId" IS NULL')
    expect(sql).toContain('root."role" = \'orchestrator\' AND root."taskType" = \'root\'')
    expect(sql).toContain('root."leaseOwner" = $4 AND root."attemptCount" = 1')
    expect(sql).toContain('root."status" = \'running\'')
    expect(sql).toContain('root."leaseExpiresAt" IS NOT NULL')
    expect(sql).toContain('root."interruptRequestedAt" IS NULL AND root."failureReason" IS NULL')
    expect(sql).toContain('root."completedAt" IS NULL AND root."closedAt" IS NULL')
    expect(sql).toContain('root."nextAttemptAt" IS NULL')
    expect(params).toEqual([current.turnId, current.sessionId, current.userId, current.ownerId, current.leaseVersion,
      rootTaskId, new Date(now.getTime() + 20_000)])
  })

  it("rolls back Turn renewal when its linked Root no longer passes the running owner and attempt fence", async () => {
    const linkedTurn = { ...row, rootTaskId: "root_turn_1" }
    const fake = fakePool([linkedTurn], "running", "user_1", [])
    const current: TurnLease = { ...payload, userId: row.userId, leaseVersion: row.leaseVersion, leaseStartedAt: now, leaseExpiresAt: row.leaseExpiresAt }

    await expect(renewTurnLease(fake.pool, current, now)).resolves.toBeNull()
    expect(fake.calls.some(([sql]) => sql.includes('UPDATE "agent_turns"'))).toBe(true)
    expect(fake.calls.some(([sql]) => sql.includes('UPDATE "sub_agent_tasks"'))).toBe(true)
    expect(fake.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true)
    expect(fake.calls.some(([sql]) => sql === "COMMIT")).toBe(false)
  })

  it("does not release a lease after another owner fenced it", async () => {
    const fake = fakePool([])
    const current: TurnLease = { ...payload, userId: row.userId, leaseVersion: row.leaseVersion, leaseStartedAt: now, leaseExpiresAt: row.leaseExpiresAt }
    await expect(releaseTurnLease(fake.pool, current, "completed", now)).resolves.toBe(false)
    await expect(releaseTurnLease(fake.pool, current, "waiting_for_approval", now)).resolves.toBe(false)
    await expect(expireTurnLease(fake.pool, current, now)).resolves.toBe(false)
  })

  it("releases a matching persisted user wait with the same live fence", async () => {
    const fake = fakePool()
    const current: TurnLease = { ...payload, userId: row.userId, leaseVersion: row.leaseVersion, leaseStartedAt: now, leaseExpiresAt: row.leaseExpiresAt }
    await expect(releaseTurnLease(fake.pool, current, "waiting_for_user", now)).resolves.toBe(true)
    const [sql, params] = fake.calls.find(([text]) => text.includes('SET "status" = $5')) ?? ["", []]
    expect(sql).toContain('"status" = \'in_progress\' OR ("status" = \'waiting_for_user\' AND $5 = \'waiting_for_user\')')
    expect(sql).toContain('"revision" = "revision" + CASE WHEN "status" = $5 THEN 0 ELSE 1 END')
    expect(sql).toContain('"userId" = $7')
    expect(sql).toContain('"leaseExpiresAt" > $6')
    expect(params).toEqual([current.turnId, current.sessionId, current.ownerId, current.leaseVersion, "waiting_for_user", now, current.userId])
  })

  it("releases a matching persisted approval wait with the same live fence", async () => {
    const fake = fakePool()
    const current: TurnLease = { ...payload, userId: row.userId, leaseVersion: row.leaseVersion, leaseStartedAt: now, leaseExpiresAt: row.leaseExpiresAt }
    await expect(releaseTurnLease(fake.pool, current, "waiting_for_approval", now)).resolves.toBe(true)
    const [sql, params] = fake.calls.find(([text]) => text.includes('SET "status" = $5')) ?? ["", []]
    expect(sql).toContain('"status" = \'waiting_for_approval\' AND $5 = \'waiting_for_approval\'')
    expect(sql).toContain('"revision" = "revision" + CASE WHEN "status" = $5 THEN 0 ELSE 1 END')
    expect(sql).toContain('"leaseOwnerId" = $3')
    expect(sql).toContain('"leaseVersion" = $4')
    expect(sql).toContain('"leaseExpiresAt" > $6')
    expect(params).toEqual([current.turnId, current.sessionId, current.ownerId, current.leaseVersion, "waiting_for_approval", now, current.userId])
  })

  it("cancels accepted, queued, and consumed follow-ups in the same failed Turn release", async () => {
    const fake = fakePool()
    const current: TurnLease = { ...payload, userId: row.userId, leaseVersion: row.leaseVersion, leaseStartedAt: now, leaseExpiresAt: row.leaseExpiresAt }

    await expect(releaseTurnLease(fake.pool, current, "failed", now)).resolves.toBe(true)

    const turnWrite = fake.calls.findIndex(([sql]) => sql.includes('UPDATE "agent_turns"'))
    const inputWrite = fake.calls.findIndex(([sql]) => sql.includes('UPDATE "agent_inputs"'))
    expect(turnWrite).toBeGreaterThan(-1)
    expect(inputWrite).toBeGreaterThan(turnWrite)
    expect(fake.calls[inputWrite]?.[0]).toContain('"delivery" = \'follow_up\'')
    expect(fake.calls[inputWrite]?.[0]).toContain('"status" IN (\'accepted\', \'queued\', \'consumed\')')
    expect(fake.calls[inputWrite]?.[0]).not.toContain('"consumedByStepId" IS NULL')
    expect(fake.calls[inputWrite]?.[1]).toEqual([current.sessionId, current.userId, current.turnId, now])
  })

  it("cancels already-claimed follow-ups in the fenced shutdown interruption", async () => {
    const fake = fakePool()
    const current: TurnLease = { ...payload, userId: row.userId, leaseVersion: row.leaseVersion, leaseStartedAt: now, leaseExpiresAt: row.leaseExpiresAt }

    await expect(interruptTurnLease(fake.pool, current, now)).resolves.toBe(true)

    const turnWrite = fake.calls.findIndex(([sql]) => sql.includes('UPDATE "agent_turns"'))
    const inputWrite = fake.calls.findIndex(([sql]) => sql.includes('UPDATE "agent_inputs"'))
    expect(inputWrite).toBeGreaterThan(turnWrite)
    expect(fake.calls[inputWrite]?.[0]).toContain('"status" IN (\'accepted\', \'queued\', \'consumed\')')
    expect(fake.calls[inputWrite]?.[0]).toContain('"cancelledAt" IS NULL')
  })

  it("treats release as idempotent after an atomic completed Turn receipt", async () => {
    const calls: string[] = []
    const client = { query: vi.fn(async (sql: string) => {
      calls.push(sql)
      if (sql.includes('SELECT session."id"')) return { rows: [{ id: "session_1" }], rowCount: 1 }
      if (sql.includes('UPDATE "agent_turns"')) return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT "id" FROM "agent_turns"') && sql.includes(`"status" = 'completed'`)) return { rows: [{ id: "turn_1" }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }), release: vi.fn() }
    const pool = { connect: vi.fn(async () => client) } as unknown as LeasePool
    const current: TurnLease = { ...payload, userId: row.userId, leaseVersion: row.leaseVersion, leaseStartedAt: now, leaseExpiresAt: row.leaseExpiresAt }

    await expect(releaseTurnLease(pool, current, "completed", now)).resolves.toBe(true)

    expect(calls.filter(sql => sql.includes('UPDATE "agent_turns"'))).toHaveLength(1)
    expect(calls.some(sql => sql.includes('UPDATE "agent_inputs"'))).toBe(false)
  })

  it("treats a failed release as idempotent only for the exact persisted no-progress terminal receipt", async () => {
    const fake = noProgressReceiptPool()
    const current: TurnLease = { ...payload, userId: row.userId, leaseVersion: row.leaseVersion, leaseStartedAt: now, leaseExpiresAt: row.leaseExpiresAt }

    await expect(releaseTurnLease(fake.pool, current, "failed", now)).resolves.toBe(true)

    const [sql, values] = fake.calls.find(([text]) => text.includes('FROM "agent_turns" AS turn')) ?? ["", []]
    expect(values).toEqual([current.turnId, current.sessionId, current.userId, current.leaseVersion])
    expect(sql).toContain('JOIN "sub_agent_tasks" AS root')
    expect(sql).toContain('JOIN "agent_events" AS no_progress')
    expect(sql).toContain('JOIN "agent_events" AS turn_failed')
    expect(sql).toContain('turn."status" = \'failed\' AND turn."error" = \'no_progress\'')
    expect(sql).toContain('root."status" = \'failed\' AND root."failureReason" = \'no_progress\'')
    expect(fake.calls.at(-1)?.[0]).toBe("COMMIT")
  })

  type LeaseIdentityOverrides = Partial<Pick<TurnLease, "turnId" | "sessionId" | "userId" | "leaseVersion">>
  type PersistedFailureOverrides = Partial<PersistedFailure>
  const mismatchCases: ReadonlyArray<readonly [string, LeaseIdentityOverrides, PersistedFailureOverrides]> = [
    ["Turn id", { turnId: "turn_other" }, {}],
    ["session id", { sessionId: "session_other" }, {}],
    ["user id", { userId: "user_other" }, {}],
    ["lease version", { leaseVersion: row.leaseVersion + 1 }, {}],
    ["Turn status", {}, { turnStatus: "completed" }],
    ["Turn failure reason", {}, { turnError: "provider_failure" }],
    ["root status", {}, { rootStatus: "running" }],
    ["root failure reason", {}, { rootFailureReason: "other_failure" }],
    ["terminal event receipt", {}, { terminalEvents: false }],
  ]
  it.each(mismatchCases)("rejects a no-progress retry with a mismatched %s", async (_name, currentOverrides, persistedOverrides) => {
    const fake = noProgressReceiptPool(persistedOverrides)
    const current: TurnLease = {
      ...payload, ...currentOverrides, userId: currentOverrides.userId ?? row.userId,
      leaseVersion: currentOverrides.leaseVersion ?? row.leaseVersion, leaseStartedAt: now, leaseExpiresAt: row.leaseExpiresAt,
    }

    await expect(releaseTurnLease(fake.pool, current, "failed", now)).resolves.toBe(false)
    expect(fake.calls.at(-1)?.[0]).toBe("ROLLBACK")
  })

  it("can fence an already-expired heartbeat before a scanner reclaims it", async () => {
    const fake = fakePool([row])
    const current: TurnLease = { ...payload, userId: row.userId, leaseVersion: row.leaseVersion, leaseStartedAt: now, leaseExpiresAt: row.leaseExpiresAt }
    await expect(interruptTurnLease(fake.pool, current, now)).resolves.toBe(true)
    expect(fake.calls.some(([sql]) => sql.includes("leaseOwnerId\" IS NULL"))).toBe(true)
  })

  it.each(["renew", "expire", "release", "interrupt"] as const)("fails closed without a Turn write when the session is archived (%s)", async (operation) => {
    const fake = fakePool([row], "archived")
    const current: TurnLease = { ...payload, userId: row.userId, leaseVersion: row.leaseVersion, leaseStartedAt: now, leaseExpiresAt: row.leaseExpiresAt }

    if (operation === "renew") await expect(renewTurnLease(fake.pool, current, now)).resolves.toBeNull()
    if (operation === "expire") await expect(expireTurnLease(fake.pool, current, now)).resolves.toBe(false)
    if (operation === "release") await expect(releaseTurnLease(fake.pool, current, "completed", now)).resolves.toBe(false)
    if (operation === "interrupt") await expect(interruptTurnLease(fake.pool, current, now)).resolves.toBe(false)
    expect(fake.calls.some(([sql]) => sql.includes('UPDATE "agent_turns"'))).toBe(false)
    expect(fake.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true)
  })
})
