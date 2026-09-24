import { describe, expect, it, vi } from "vitest"

vi.mock("ioredis", () => ({ Redis: vi.fn().mockImplementation(() => ({ disconnect: vi.fn() })) }))

import { dispatchPendingTurnOutbox, persistTurnDispatch, reclaimExpiredTurns, repairLegacyTurnDispatchAggregates, recoverTurnQueue, turnJobId } from "./recovery-scanner.js"
import { markTurnDispatchClaimed } from "./turn-queue.js"

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function matchingLegacyRows(rows: unknown[]): unknown[] {
  return rows.flatMap((value) => {
    const row = record(value)
    const payload = record(row?.payload)
    const id = row?.id
    const aggregateId = row?.aggregateId
    const topic = row?.topic
    const idempotencyKey = row?.idempotencyKey
    const turnId = payload?.turnId
    const sessionId = payload?.sessionId
    if (typeof id !== "string" || aggregateId !== turnId || topic !== "agent.turn.dispatch" || idempotencyKey !== `turn-dispatch:${String(turnId)}` || row?.publishedAt !== null || turnId !== "turn_1" || sessionId !== "session_1") return []
    return [{ id, turnId, sessionId }]
  })
}

function pool(rows: unknown[] = [], sessionStatus: string | null = "running", queuedRows: unknown[] = [], legacyRows: unknown[] = [], controlGate = "open", lineageRows: readonly unknown[] = [{ id: "turn_1" }]) {
  const calls: Array<[string, unknown[]?]> = []
  const open = sessionStatus !== null && !["aborted", "archived"].includes(sessionStatus)
  const runnable = open && controlGate === "open"
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      if (sql.includes("WITH stale")) return runnable ? { rows: [{ id: "turn_1", sessionId: "session_1", leaseVersion: 9 }], rowCount: 1 } : { rows: [], rowCount: 0 }
      if (sql.includes("WITH candidates AS")) {
        const candidates = matchingLegacyRows(legacyRows)
        return open ? { rows: candidates, rowCount: candidates.length } : { rows: [], rowCount: 0 }
      }
      if (sql.includes('WHERE turn."id" = $1') && sql.includes("FOR UPDATE OF turn, session")) return { rows: lineageRows, rowCount: lineageRows.length }
      if (sql.includes('WHERE turn."id" = $1') && sql.includes("FOR UPDATE OF turn, turnSession")) return { rows: lineageRows, rowCount: lineageRows.length }
      if (sql.includes('FROM "agent_turns" AS turn')) return runnable ? { rows: queuedRows, rowCount: queuedRows.length } : { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_outbox"') && sql.includes('SELECT')) return runnable ? { rows, rowCount: rows.length } : { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_sessions"')) return sql.includes('session."controlGate" = \'open\'') ? (runnable ? { rows: [{ id: "session_1" }], rowCount: 1 } : { rows: [], rowCount: 0 }) : (open ? { rows: [{ id: "session_1" }], rowCount: 1 } : { rows: [], rowCount: 0 })
      if (sql.includes('FROM "agent_turns"')) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) }, client, calls }
}

describe("Turn recovery scanner", () => {
  it("rejects an invalid dispatch batch size before touching the database", async () => {
    const fake = pool()
    await expect(dispatchPendingTurnOutbox(fake.pool, { add: vi.fn() }, 0)).rejects.toThrow("Turn dispatch limit must be positive")
    expect(fake.pool.connect).not.toHaveBeenCalled()
  })

  it("reclaims only stale in-progress rows and increments their fence", async () => {
    const fake = pool([{ id: "turn_1", sessionId: "session_1", leaseVersion: 9 }])
    const result = await reclaimExpiredTurns(fake.pool, new Date("2026-09-01T00:00:00.000Z"), 50)
    expect(result).toEqual([{ turnId: "turn_1", sessionId: "session_1", previousLeaseVersion: 8 }])
    const sql = fake.calls.find(([text]) => text.includes("WITH stale"))?.[0] ?? ""
    expect(sql).toContain("status\" = 'in_progress'")
    expect(sql).toMatch(/ORDER BY turn\."updatedAt" ASC, turn\."id" ASC\s+LIMIT \$2 FOR UPDATE OF turn, session SKIP LOCKED/)
    expect(sql).toContain('session."status" NOT IN (\'aborted\', \'archived\')')
    expect(sql).toContain('session."controlGate" = \'open\'')
    expect(sql.match(/session\."status" NOT IN/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it("persists a deduplicated dispatch intent before queueing", async () => {
    const fake = pool()
    await persistTurnDispatch(fake.pool, { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" })
    expect(fake.calls.some(([sql]) => sql.includes("ON CONFLICT (\"idempotencyKey\") DO NOTHING"))).toBe(true)
    expect(fake.calls.some(([, params]) => params?.includes("agent.turn.dispatch"))).toBe(true)
    const insert = fake.calls.find(([sql]) => sql.includes('INSERT INTO "agent_outbox"'))
    expect(insert?.[1]).toEqual(expect.arrayContaining(["session_1", "turn-dispatch:turn_1"]))
    expect(insert?.[1]?.[2]).toBe("session_1")
    expect(insert?.[1]?.[2]).not.toBe("turn_1")

    const resetFake = pool()
    await persistTurnDispatch(resetFake.pool, { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" }, true)
    expect(resetFake.calls.some(([sql]) => sql.includes('WHERE "agent_outbox"."topic" = EXCLUDED."topic"') && sql.includes('"agent_outbox"."aggregateId" = EXCLUDED."aggregateId"'))).toBe(true)
    const pausedResetFake = pool([], "running", [], [], "user_paused")
    await persistTurnDispatch(pausedResetFake.pool, { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" }, true)
    expect(pausedResetFake.calls.some(([sql]) => sql.includes('INSERT INTO "agent_outbox"'))).toBe(false)
    expect(pausedResetFake.calls.find(([sql]) => sql.includes('SELECT session."id"'))?.[0]).toContain('session."controlGate" = \'open\'')

    const closedFake = pool([], "archived")
    await persistTurnDispatch(closedFake.pool, { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" }, true)
    expect(closedFake.calls.some(([sql]) => sql.includes('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  it("repairs an open legacy aggregate from canonical session and turn rows", async () => {
    const fake = pool([], "running", [], [{ id: "dispatch_legacy", aggregateId: "turn_1", topic: "agent.turn.dispatch", idempotencyKey: "turn-dispatch:turn_1", payload: { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" }, publishedAt: null }])
    const repaired = await repairLegacyTurnDispatchAggregates(fake.pool, 50)

    expect(repaired).toBe(1)
    const repair = fake.calls.find(([sql]) => sql.includes("WITH candidates AS"))?.[0] ?? ""
    expect(repair).toContain('FROM "agent_sessions" AS session')
    expect(repair).toContain('JOIN "agent_turns" AS turn')
    expect(repair).toContain('JOIN "agent_outbox" AS dispatch')
    expect(repair).toContain('turn."userId" = session."userId"')
    expect(repair).toContain('dispatch."aggregateId" = turn."id"')
    expect(repair).toContain('dispatch."aggregateId" <> session."id"')
    expect(repair).toContain('dispatch."payload"->>\'turnId\' = turn."id"')
    expect(repair).toContain('dispatch."payload"->>\'sessionId\' = session."id"')
    expect(repair).toMatch(/LIMIT \$2 FOR UPDATE OF session, turn, dispatch SKIP LOCKED/)
    expect(repair).toContain('UPDATE "agent_outbox" AS dispatch')
    expect(repair).toContain('dispatch."topic" = $1')
    expect(repair).toContain('dispatch."aggregateId" = candidates."turnId"')
    expect(repair).toContain('dispatch."publishedAt" IS NULL')
    expect(repair).toContain('session."status" NOT IN (\'aborted\', \'archived\')')
    expect(repair).not.toContain('session."controlGate"')
  })

  it("is reentrant and does not update a repaired legacy row twice", async () => {
    let aggregateId = "turn_1"
    let updateCount = 0
    const calls: Array<[string, unknown[]?]> = []
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push([sql, params])
        if (sql.includes("WITH candidates AS")) {
          if (aggregateId !== "turn_1") return { rows: [], rowCount: 0 }
          aggregateId = "session_1"
          updateCount += 1
          return { rows: [{ id: "dispatch_legacy", turnId: "turn_1", sessionId: "session_1" }], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const fakePool = { connect: vi.fn().mockResolvedValue(client) }

    await expect(repairLegacyTurnDispatchAggregates(fakePool, 50)).resolves.toBe(1)
    await expect(repairLegacyTurnDispatchAggregates(fakePool, 50)).resolves.toBe(0)
    expect(updateCount).toBe(1)
  })

  it("leaves a canonical session aggregate unchanged", async () => {
    const fake = pool([], "running", [], [{ id: "dispatch_canonical", aggregateId: "session_1", topic: "agent.turn.dispatch", idempotencyKey: "turn-dispatch:turn_1", payload: { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" }, publishedAt: null }])

    await expect(repairLegacyTurnDispatchAggregates(fake.pool, 50)).resolves.toBe(0)
  })

  it("includes legacy aggregate repairs in recovery before reclaim and queue repair", async () => {
    const fake = pool([], "running", [{ id: "turn_1", sessionId: "session_1" }], [{ id: "dispatch_legacy", aggregateId: "turn_1", topic: "agent.turn.dispatch", idempotencyKey: "turn-dispatch:turn_1", payload: { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" }, publishedAt: null }])
    const report = await recoverTurnQueue(fake.pool, { add: vi.fn().mockResolvedValue(undefined) }, "owner_1", new Date("2026-09-01T00:00:00.000Z"))

    expect(report.repaired).toBe(2)
    const legacyIndex = fake.calls.findIndex(([sql]) => sql.includes("WITH candidates AS"))
    const reclaimIndex = fake.calls.findIndex(([sql]) => sql.includes("WITH stale"))
    const queuedIndex = fake.calls.findIndex(([sql]) => sql.includes('LEFT JOIN "agent_outbox" AS dispatch'))
    expect(legacyIndex).toBeGreaterThanOrEqual(0)
    expect(legacyIndex).toBeLessThan(reclaimIndex)
    expect(legacyIndex).toBeLessThan(queuedIndex)
  })

  it("repairs a queued automation Turn when the Redis handoff lost turn.started", async () => {
    const calls: Array<[string, unknown[]?]> = []
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push([sql, params])
        if (sql.includes("WITH stale") || sql.includes("WITH candidates AS")) return { rows: [], rowCount: 0 }
        if (sql.includes('FROM "agent_turns" AS turn') && sql.includes('LEFT JOIN "agent_outbox" AS dispatch')) {
          return sql.includes(`event."type" = 'turn.started'`)
            ? { rows: [], rowCount: 0 }
            : { rows: [{ id: "turn_automation", sessionId: "session_1" }], rowCount: 1 }
        }
        if (sql.includes('FROM "agent_outbox" AS dispatch') && sql.includes('SELECT dispatch."id"')) return { rows: [], rowCount: 0 }
        if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session_1" }], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const fakePool = { connect: vi.fn().mockResolvedValue(client) }
    const report = await recoverTurnQueue(fakePool, { add: vi.fn() }, "recovery-owner", new Date("2026-09-01T00:00:00.000Z"))

    expect(report).toEqual({ reclaimed: 0, repaired: 1, dispatched: 0 })
    const insert = calls.find(([sql]) => sql.includes('INSERT INTO "agent_outbox"'))
    expect(insert?.[1]).toEqual(expect.arrayContaining(["session_1", "turn-dispatch:turn_automation"]))
    const queuedScan = calls.find(([sql]) => sql.includes('LEFT JOIN "agent_outbox" AS dispatch'))?.[0] ?? ""
    expect(queuedScan).not.toContain(`event."type" = 'turn.started'`)
  })

  it.each([
    ["aggregate/payload session mismatch", { turnId: "turn_1", sessionId: "session_2", ownerId: "owner_1" }, [{ id: "turn_1" }]],
    ["turn/session mismatch", { turnId: "turn_other", sessionId: "session_1", ownerId: "owner_1" }, []],
  ] as const)("quarantines a poisoned %s dispatch without queueing it", async (_kind, payload, lineageRows) => {
    const fake = pool([{ id: "outbox_poison", aggregateId: "session_1", payload }], "running", [], [], "open", lineageRows)
    const queue = { add: vi.fn() }

    await expect(dispatchPendingTurnOutbox(fake.pool, queue)).resolves.toBe(0)

    expect(queue.add).not.toHaveBeenCalled()
    const quarantine = fake.calls.find(([sql]) => sql.includes('"lastError" = $2') && sql.includes('"publishedAt" = CURRENT_TIMESTAMP'))
    expect(quarantine?.[1]).toEqual(["outbox_poison", "turn_dispatch_lineage_mismatch"])
  })

  it.each([
    ["aborted", "archived", { turnId: "turn_1", sessionId: "session_1" }],
    ["archived", "archived", { turnId: "turn_1", sessionId: "session_1" }],
    ["missing", "running", { turnId: "missing-turn", sessionId: "missing-session" }],
    ["corrupt", "running", { turnId: "wrong-turn", sessionId: "session_1" }],
  ] as const)("does not queue a %s legacy row", async (_kind, sessionStatus, payload) => {
    const fake = pool([], sessionStatus, [], [{ id: "dispatch_legacy", aggregateId: payload.turnId, topic: "agent.turn.dispatch", idempotencyKey: `turn-dispatch:${payload.turnId}`, payload: { ...payload, ownerId: "owner_1" }, publishedAt: null }])
    const queue = { add: vi.fn() }
    const report = await recoverTurnQueue(fake.pool, queue, "owner_1", new Date("2026-09-01T00:00:00.000Z"))

    expect(report.repaired).toBe(0)
    expect(report.dispatched).toBe(0)
    expect(queue.add).not.toHaveBeenCalled()
  })

  it("uses a colon-free generation id so a resumed Turn is not hidden by a completed job", async () => {
    const completedJobIds = new Set<string>()
    const addedJobIds: string[] = []
    const state = { attemptCount: 0, published: false }
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('WHERE turn."id" = $1') && (sql.includes("FOR UPDATE OF turn, session") || sql.includes("FOR UPDATE OF turn, turnSession"))) return { rows: [{ id: "turn:1" }], rowCount: 1 }
        if (sql.includes('FROM "agent_outbox"') && sql.includes("SELECT")) {
          return state.published ? { rows: [], rowCount: 0 } : {
            rows: [{ id: "dispatch_1", payload: { turnId: "turn:1", sessionId: "session_1", ownerId: "owner_1" }, attemptCount: state.attemptCount }], rowCount: 1,
          }
        }
        if (sql.includes('SET "publishedAt" = CURRENT_TIMESTAMP') && !sql.includes('WHERE "id" = $1 AND "publishedAt" IS NULL')) {
          if (!state.published) {
            state.published = true
            state.attemptCount += 1
          }
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session_1" }], rowCount: 1 }
        if (sql.includes('ON CONFLICT ("idempotencyKey") DO UPDATE')) {
          state.published = false
          state.attemptCount += 1
          return { rows: [], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const fakePool = { connect: vi.fn().mockResolvedValue(client) }
    const queue = {
      add: vi.fn(async (_name: string, _payload: unknown, options?: { jobId?: string }) => {
        if (options?.jobId && !completedJobIds.has(options.jobId)) {
          completedJobIds.add(options.jobId)
          addedJobIds.push(options.jobId)
        }
      }),
    }

    await dispatchPendingTurnOutbox(fakePool, queue)
    await markTurnDispatchClaimed(fakePool, { turnId: "turn:1", sessionId: "session_1", ownerId: "owner_1" })
    await persistTurnDispatch(fakePool, { turnId: "turn:1", sessionId: "session_1", ownerId: "owner_1" }, true)
    await dispatchPendingTurnOutbox(fakePool, queue)
    await dispatchPendingTurnOutbox(fakePool, queue)

    expect(addedJobIds).toEqual([turnJobId("turn:1", 0), turnJobId("turn:1", 2)])
    expect(addedJobIds.every((id) => !id.includes(":"))).toBe(true)
    expect(queue.add).toHaveBeenCalledWith("turn", expect.anything(), expect.objectContaining({ jobId: turnJobId("turn:1", 2) }))
    expect(client.query.mock.calls.filter(([sql]) => sql.includes('UPDATE "agent_outbox"') && sql.includes('WHERE "id" = $1 AND "publishedAt" IS NULL')).length).toBeGreaterThanOrEqual(2)
  })

  it("re-enqueues pending DB intents with a deterministic BullMQ job id", async () => {
    const fake = pool([{ id: "outbox_1", payload: { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" }, attemptCount: 4 }])
    const queue = { add: vi.fn().mockResolvedValue({ id: turnJobId("turn_1") }) }
    await dispatchPendingTurnOutbox(fake.pool, queue)
    const outboxScan = fake.calls.find(([sql]) => sql.includes('FROM "agent_outbox" AS dispatch') && sql.includes('SELECT dispatch."id"'))?.[0] ?? ""
    expect(outboxScan).toMatch(/ORDER BY dispatch\."createdAt" ASC, dispatch\."id" ASC\s+LIMIT \$2 FOR UPDATE OF dispatch, session SKIP LOCKED/)
    expect(outboxScan).toContain('session."id" = dispatch."aggregateId"')
    expect(outboxScan).toContain('session."status" NOT IN (\'aborted\', \'archived\')')
    expect(queue.add).toHaveBeenCalledWith("turn", { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" }, { jobId: turnJobId("turn_1", 4), attempts: 5 })
  })

  it("records queue add failures without publishing the outbox row", async () => {
    const fake = pool([{ id: "outbox_1", payload: { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" }, attemptCount: 4 }])
    const queue = { add: vi.fn().mockRejectedValue(new Error("redis unavailable")) }
    await expect(dispatchPendingTurnOutbox(fake.pool, queue)).rejects.toThrow("redis unavailable")
    const failure = fake.calls.find(([sql]) => sql.includes('SET "attemptCount" = "attemptCount" + 1'))
    expect(failure?.[0]).toContain('"publishedAt" = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE "publishedAt" END')
    expect(failure?.[1]).toEqual(["outbox_1", "queue_add_failed", false])
  })

  it("keeps the generation unchanged when publish bookkeeping fails after enqueue", async () => {
    const calls: Array<[string, unknown[]?]> = []
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push([sql, params])
        if (sql.includes('FROM "agent_outbox"') && sql.includes("SELECT")) return { rows: [{ id: "outbox_1", payload: { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" }, attemptCount: 4 }], rowCount: 1 }
        if (sql.includes('WHERE turn."id" = $1') && sql.includes("FOR UPDATE OF turn, turnSession")) return { rows: [{ id: "turn_1" }], rowCount: 1 }
        if (sql.includes('WHERE "id" = $1 AND "publishedAt" IS NULL')) throw new Error("database unavailable")
        if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session_1" }], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const fakePool = { connect: vi.fn().mockResolvedValue(client) }
    const queue = { add: vi.fn().mockResolvedValue(undefined) }
    await expect(dispatchPendingTurnOutbox(fakePool, queue)).rejects.toThrow("turn_dispatch_delivery_uncertain")
    expect(queue.add).toHaveBeenCalledWith("turn", expect.anything(), expect.objectContaining({ jobId: turnJobId("turn_1", 4) }))
    expect(calls.filter(([sql]) => sql.includes('SET "attemptCount" = "attemptCount" + 1')).length).toBe(0)
  })

  it("repairs queued or reclaimed work even when the queue add is unavailable", async () => {
    const calls: Array<[string, unknown[]?]> = []
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push([sql, params])
        if (sql.includes("WITH stale")) return { rows: [{ id: "turn_1", sessionId: "session_1", leaseVersion: 2 }], rowCount: 1 }
        if (sql.includes('FROM "agent_turns" AS turn') && sql.includes('LEFT JOIN "agent_outbox" AS dispatch')) return { rows: [{ id: "turn_1", sessionId: "session_1" }], rowCount: 1 }
        if (sql.includes('WHERE turn."id" = $1') && (sql.includes("FOR UPDATE OF turn, session") || sql.includes("FOR UPDATE OF turn, turnSession"))) return { rows: [{ id: "turn_1" }], rowCount: 1 }
        if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session_1" }], rowCount: 1 }
        if (sql.includes('FROM "agent_outbox"') && sql.includes("SELECT")) return { rows: [{ id: "dispatch_1", payload: { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_2" } }], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const fake = { pool: { connect: vi.fn().mockResolvedValue(client) }, calls }
    const queue = { add: vi.fn().mockRejectedValue(new Error("redis unavailable")) }
    await expect(recoverTurnQueue(fake.pool, queue, "owner_2", new Date("2026-09-01T00:00:00.000Z"))).rejects.toThrow("redis unavailable")
    expect(fake.calls.some(([sql]) => sql.includes('INSERT INTO "agent_outbox"'))).toBe(true)
    const queuedDispatchScan = fake.calls.find(([sql]) => sql.includes('FROM "agent_turns" AS turn') && sql.includes('LEFT JOIN "agent_outbox" AS dispatch'))?.[0] ?? ""
    expect(queuedDispatchScan).toMatch(/ORDER BY turn\."createdAt" ASC, turn\."id" ASC\s+LIMIT \$2 FOR UPDATE OF turn, session SKIP LOCKED/)
    expect(queuedDispatchScan).toContain('session."status" NOT IN (\'aborted\', \'archived\')')
    expect(queuedDispatchScan).toContain('dispatch."aggregateId" = turn."sessionId"')
    expect(queuedDispatchScan).toContain('dispatch."idempotencyKey" = \'turn-dispatch:\' || turn."id"')
    expect(queuedDispatchScan).not.toContain('dispatch."aggregateId" = turn."id"')
    const dispatchInserts = fake.calls.filter(([sql, params]) => sql.includes('INSERT INTO "agent_outbox"') && params?.[1] === "agent.turn.dispatch")
    expect(dispatchInserts.length).toBeGreaterThan(0)
    expect(dispatchInserts.every(([, params]) => params?.[2] === "session_1")).toBe(true)
    const guardedDispatchInserts = dispatchInserts.filter(([sql]) => sql.includes("SELECT $1, $2, $3, $4, $5::jsonb"))
    expect(guardedDispatchInserts.length).toBeGreaterThan(0)
    expect(guardedDispatchInserts.every(([sql]) => sql.includes('turn."sessionId" = $3') && sql.includes('session."status" NOT IN') && sql.includes('session."controlGate" = \'open\''))).toBe(true)
  })

  it.each(["aborted", "archived", null] as const)("does not reclaim, repair, or queue a %s session", async (sessionStatus) => {
    const fake = pool([{ id: "outbox_1", payload: { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" } }], sessionStatus)
    const queue = { add: vi.fn() }
    const report = await recoverTurnQueue(fake.pool, queue, "owner_1", new Date("2026-09-01T00:00:00.000Z"))

    expect(report).toEqual({ reclaimed: 0, repaired: 0, dispatched: 0 })
    expect(queue.add).not.toHaveBeenCalled()
    expect(fake.calls.some(([sql]) => sql.includes('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  it("rechecks the session fence after selecting an outbox row", async () => {
    let scanCompleted = false
    const calls: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql)
        if (sql.includes('FROM "agent_outbox" AS dispatch') && sql.includes("SELECT dispatch.")) {
          scanCompleted = true
          return { rows: [{ id: "dispatch_1", aggregateId: "session_1", payload: { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" }, attemptCount: 0 }], rowCount: 1 }
        }
        if (scanCompleted && sql.includes('FROM "agent_sessions"')) return { rows: [], rowCount: 0 }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const queue = { add: vi.fn() }
    const fakePool = { connect: vi.fn().mockResolvedValue(client) }

    await expect(dispatchPendingTurnOutbox(fakePool, queue)).resolves.toBe(0)
    expect(queue.add).not.toHaveBeenCalled()
    expect(calls.some((sql) => sql.includes('SET "publishedAt" = CURRENT_TIMESTAMP'))).toBe(false)
  })

  it.each(["running", "paused", "waiting_for_user"] as const)("keeps recovery compatible with an open %s session", async (sessionStatus) => {
    const fake = pool([{ id: "dispatch_1", payload: { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" } }], sessionStatus, [{ id: "turn_1", sessionId: "session_1" }])
    const queue = { add: vi.fn().mockResolvedValue(undefined) }
    const report = await recoverTurnQueue(fake.pool, queue, "owner_1", new Date("2026-09-01T00:00:00.000Z"))

    expect(report.repaired).toBe(1)
    expect(report.dispatched).toBe(1)
    expect(queue.add).toHaveBeenCalledWith("turn", { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" }, expect.objectContaining({ attempts: 5 }))
  })

  it("suppresses expired Turn recovery for a user-paused session", async () => {
    const fake = pool([], "running", [], [], "user_paused")
    await expect(reclaimExpiredTurns(fake.pool, new Date("2026-09-01T00:00:00.000Z"), 50)).resolves.toEqual([])
    const scan = fake.calls.find(([sql]) => sql.includes("WITH stale"))?.[0] ?? ""
    expect(scan).toContain('session."controlGate" = \'open\'')
  })

  it("leaves a user-paused pending Turn dispatch unpublished", async () => {
    const fake = pool([{ id: "outbox_1", payload: { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" } }], "running", [], [], "user_paused")
    const queue = { add: vi.fn() }
    await expect(dispatchPendingTurnOutbox(fake.pool, queue)).resolves.toBe(0)
    expect(queue.add).not.toHaveBeenCalled()
    expect(fake.calls.some(([sql]) => sql.includes('SET "publishedAt" = CURRENT_TIMESTAMP'))).toBe(false)
    const scan = fake.calls.find(([sql]) => sql.includes('FROM "agent_outbox" AS dispatch'))?.[0] ?? ""
    expect(scan).toContain('session."controlGate" = \'open\'')
  })
})
