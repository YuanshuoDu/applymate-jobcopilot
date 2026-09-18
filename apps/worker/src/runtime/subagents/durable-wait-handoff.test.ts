import { describe, expect, it } from "vitest"

import { TurnLeaseError, type TurnLease } from "../turns/lease.js"
import { suspendAndReleaseWait } from "./durable-wait-handoff.js"

const lease: TurnLease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 3,
  leaseStartedAt: new Date("2026-09-09T10:00:00.000Z"), leaseExpiresAt: new Date("2026-09-09T10:01:00.000Z"),
}
const now = new Date("2026-09-09T10:00:30.000Z")
const SESSION_FENCE = 'session."status" NOT IN (\'aborted\', \'archived\')'

function fixture(waitStatus: string, turnStatus = "in_progress", suspendedAt: Date | null = null, sessionStatus = "running", sessionSource = "automation", closeBeforeTurnUpdate = false) {
  const state = {
    wait: { id: "wait-1", userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, parentTaskId: "root-1", stepId: "step-1", status: waitStatus, suspendedAt },
    turn: { id: lease.turnId, userId: lease.userId, sessionId: lease.sessionId, rootTaskId: "root-1", status: turnStatus, leaseOwnerId: turnStatus === "in_progress" ? lease.ownerId : null, leaseVersion: lease.leaseVersion, leaseExpiresAt: turnStatus === "in_progress" ? lease.leaseExpiresAt : null, leaseStartedAt: turnStatus === "in_progress" ? lease.leaseStartedAt : null },
    step: { id: "step-1", taskId: "root-1", attempt: 1, status: "waiting_for_tool" },
    outbox: false,
    published: false,
    outboxWrites: 0,
    conflictResets: 0,
    outboxParams: null as unknown[] | null,
    outboxLookupParams: null as unknown[] | null,
    updates: [] as string[],
    sessionStatus,
    sessionSource,
    closeBeforeTurnUpdate,
  }
  const calls: string[] = []
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push(sql)
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 1 }
      if (sql.includes('SELECT session."id", session."userId", session."status"') && sql.includes("FOR UPDATE")) {
        if (["aborted", "archived", "missing"].includes(state.sessionStatus)) {
          if (!sql.includes(SESSION_FENCE)) throw new Error("missing session-state fence")
          return { rows: [], rowCount: 0 }
        }
        return { rows: [{ id: lease.sessionId, userId: lease.userId, status: state.sessionStatus }], rowCount: 1 }
      }
      if (sql.includes('FROM "agent_turns"')) {
        if (state.sessionStatus === "aborted" || state.sessionStatus === "archived") {
          if (!sql.includes(SESSION_FENCE)) throw new Error("missing session-state fence")
          return { rows: [], rowCount: 0 }
        }
        return { rows: [state.turn], rowCount: 1 }
      }
      if (sql.includes('FROM "agent_wait_conditions"')) return { rows: [state.wait], rowCount: 1 }
      if (sql.includes('FROM "agent_steps"')) return { rows: [state.step], rowCount: 1 }
      if (sql.includes('FROM "agent_outbox"')) {
        state.outboxLookupParams = params ?? null
        return { rows: state.outbox ? [{ id: "outbox-1" }] : [], rowCount: state.outbox ? 1 : 0 }
      }
      if (sql.includes('UPDATE "agent_wait_conditions"')) {
        state.wait.suspendedAt = params?.[1] as Date
        state.updates.push("wait")
        if (state.closeBeforeTurnUpdate) state.sessionStatus = "aborted"
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes("SET \"status\" = 'waiting_for_dependency'")) {
        if (state.sessionStatus === "aborted" || state.sessionStatus === "archived") { if (!sql.includes(SESSION_FENCE)) throw new Error("missing session-state fence"); return { rows: [], rowCount: 0 } }
        state.turn.status = "waiting_for_dependency"; state.turn.leaseOwnerId = null; state.turn.leaseExpiresAt = null
        state.updates.push("suspend")
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes("SET \"status\" = 'queued'")) {
        if (state.sessionStatus === "aborted" || state.sessionStatus === "archived") { if (!sql.includes(SESSION_FENCE)) throw new Error("missing session-state fence"); return { rows: [], rowCount: 0 } }
        state.turn.status = "queued"; state.turn.leaseOwnerId = null; state.turn.leaseExpiresAt = null
        state.updates.push("queue")
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO "agent_outbox"')) {
        if (state.outbox && state.published && sql.includes('DO UPDATE')) state.conflictResets += 1
        state.outboxParams = params ?? null
        state.outbox = true; state.published = false; state.outboxWrites += 1
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    },
    release() {},
  }
  return { pool: { connect: async () => client }, state, calls }
}

describe("durable dependency wait handoff", () => {
  it("suspends the waiting Turn and clears its lease atomically", async () => {
    const fake = fixture("waiting")
    await expect(suspendAndReleaseWait(fake.pool as never, { lease, waitId: "wait-1", now })).resolves.toMatchObject({ handoff: "suspended", idempotent: false })
    expect(fake.state.updates).toEqual(["wait", "suspend"])
    expect(fake.state.turn.status).toBe("waiting_for_dependency")
  })

  it("requeues a ready race and writes one idempotent dispatch outbox row", async () => {
    const fake = fixture("ready")
    await expect(suspendAndReleaseWait(fake.pool as never, { lease, waitId: "wait-1", now })).resolves.toMatchObject({ handoff: "queued" })
    const second = await suspendAndReleaseWait(fake.pool as never, { lease, waitId: "wait-1", now })
    expect(second).toMatchObject({ handoff: "queued", idempotent: true })
    expect(fake.state.updates).toEqual(["wait", "queue"])
    expect(fake.state.outbox).toBe(true)
    expect(fake.state.outboxWrites).toBe(1)
    expect(fake.calls.filter(sql => sql.includes('UPDATE "agent_wait_conditions"') || sql.includes('UPDATE "agent_turns"') || sql.includes('INSERT INTO "agent_outbox"')).every(sql => sql.includes(SESSION_FENCE))).toBe(true)
    expect(fake.calls.some(sql => sql.includes('INSERT INTO "agent_outbox"') && sql.includes("WHERE EXISTS"))).toBe(true)
    expect(fake.calls.some(sql => sql.includes('SELECT "id" FROM "agent_outbox"') && sql.includes('"aggregateId" = $3'))).toBe(true)
    expect(fake.state.outboxLookupParams).toEqual(["agent.turn.dispatch", "turn-dispatch:turn-1", "session-1"])
  })

  it("resets a previously published dispatch when the wait becomes ready", async () => {
    const fake = fixture("ready")
    fake.state.outbox = true
    fake.state.published = true
    await suspendAndReleaseWait(fake.pool as never, { lease, waitId: "wait-1", now })
    expect(fake.state.published).toBe(false)
    expect(fake.state.conflictResets).toBe(1)
    expect(fake.state.outboxParams?.[2]).toBe(lease.sessionId)
    expect(fake.state.outboxParams?.[2]).not.toBe(lease.turnId)
    expect(fake.state.outboxParams?.[3]).toBe("turn-dispatch:turn-1")
    expect(fake.calls.some(sql => sql.includes('WHERE "agent_outbox"."aggregateId" = EXCLUDED."aggregateId"'))).toBe(true)
  })

  it("rejects an expired or mismatched lease before writing wait, turn, or outbox state", async () => {
    const fake = fixture("waiting")
    fake.state.turn.leaseOwnerId = "other-worker"
    await expect(suspendAndReleaseWait(fake.pool as never, { lease, waitId: "wait-1", now })).rejects.toBeInstanceOf(TurnLeaseError)
    expect(fake.state.updates).toEqual([])
    expect(fake.state.outbox).toBe(false)
  })

  it("treats an already suspended wait as an idempotent retry", async () => {
    const fake = fixture("waiting", "waiting_for_dependency", now)
    await expect(suspendAndReleaseWait(fake.pool as never, { lease, waitId: "wait-1", now })).resolves.toMatchObject({ handoff: "suspended", idempotent: true })
    expect(fake.state.updates).toEqual([])
  })

  it.each(["aborted", "archived", "missing"])("does not suspend, requeue, or dispatch a %s session", async sessionStatus => {
    const fake = fixture("ready", "in_progress", null, sessionStatus)
    await expect(suspendAndReleaseWait(fake.pool as never, { lease, waitId: "wait-1", now })).rejects.toThrow("Session is unavailable")
    expect(fake.state.updates).toEqual([])
    expect(fake.state.outbox).toBe(false)
  })

  it("locks the scoped open session before locking the Turn", async () => {
    const fake = fixture("waiting")
    await suspendAndReleaseWait(fake.pool as never, { lease, waitId: "wait-1", now })
    const sessionLock = fake.calls.findIndex(sql => sql.includes('SELECT session."id", session."userId", session."status"') && sql.includes("FOR UPDATE"))
    const turnLock = fake.calls.findIndex(sql => sql.includes('SELECT turn."id"') && sql.includes("FOR UPDATE"))
    expect(sessionLock).toBeGreaterThan(-1)
    expect(fake.calls[sessionLock]).toContain('session."id" = $1 AND session."userId" = $2')
    expect(fake.calls[sessionLock]).toContain(SESSION_FENCE)
    expect(turnLock).toBeGreaterThan(sessionLock)
  })

  it.each(["running", "paused", "waiting_for_user"])("keeps %s sessions compatible", async sessionStatus => {
    const fake = fixture("waiting", "in_progress", null, sessionStatus)
    await expect(suspendAndReleaseWait(fake.pool as never, { lease, waitId: "wait-1", now })).resolves.toMatchObject({ handoff: "suspended" })
  })

  it.each(["user", "system"])("keeps ordinary %s sessions compatible", async sessionSource => {
    const fake = fixture("waiting", "in_progress", null, "running", sessionSource)
    await expect(suspendAndReleaseWait(fake.pool as never, { lease, waitId: "wait-1", now })).resolves.toMatchObject({ handoff: "suspended" })
  })

  it("rolls back wait suspension when the session closes before the Turn update", async () => {
    const fake = fixture("waiting", "in_progress", null, "running", "automation", true)
    await expect(suspendAndReleaseWait(fake.pool as never, { lease, waitId: "wait-1", now })).rejects.toBeInstanceOf(TurnLeaseError)
    expect(fake.state.outbox).toBe(false)
    expect(fake.state.updates).toEqual(["wait"])
    expect(fake.calls.some(sql => sql === "ROLLBACK")).toBe(true)
  })
})
