import { describe, expect, it } from "vitest"

import { TurnLeaseError, type TurnLease } from "../turns/lease.js"
import { suspendAndReleaseWait } from "./durable-wait-handoff.js"

const lease: TurnLease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 3,
  leaseStartedAt: new Date("2026-09-09T10:00:00.000Z"), leaseExpiresAt: new Date("2026-09-09T10:01:00.000Z"),
}
const now = new Date("2026-09-09T10:00:30.000Z")
const SESSION_FENCE = 'session."status" NOT IN (\'aborted\', \'archived\')'

function fixture(waitStatus: string, turnStatus = "in_progress", suspendedAt: Date | null = null, sessionStatus = "running", sessionSource = "automation", closeBeforeTurnUpdate = false, failResumeOutbox = false) {
  const state = {
    wait: { id: "wait-1", userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, parentTaskId: "root-1", stepId: "step-1", status: waitStatus, matchedTaskIds: ["child-1"], suspendedAt },
    turn: { id: lease.turnId, userId: lease.userId, sessionId: lease.sessionId, rootTaskId: "root-1", status: turnStatus, leaseOwnerId: turnStatus === "in_progress" ? lease.ownerId : null, leaseVersion: lease.leaseVersion, leaseExpiresAt: turnStatus === "in_progress" ? lease.leaseExpiresAt : null, leaseStartedAt: turnStatus === "in_progress" ? lease.leaseStartedAt : null },
    step: { id: "step-1", taskId: "root-1", attempt: 1, status: "waiting_for_tool" },
    outbox: false,
    published: false,
    outboxWrites: 0,
    conflictResets: 0,
    outboxParams: null as unknown[] | null,
    outboxLookupParams: null as unknown[] | null,
    resumeEvent: null as Record<string, unknown> | null,
    resumeOutbox: null as Record<string, unknown> | null,
    eventSequenceUpdates: 0,
    eventWrites: 0,
    eventOutboxWrites: 0,
    eventParams: null as unknown[] | null,
    eventOutboxParams: null as unknown[] | null,
    updates: [] as string[],
    sessionStatus,
    sessionSource,
    closeBeforeTurnUpdate,
    failResumeOutbox,
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
      if (sql.includes('FROM "agent_events"')) return { rows: state.resumeEvent ? [state.resumeEvent] : [], rowCount: state.resumeEvent ? 1 : 0 }
      if (sql.includes('FROM "agent_wait_conditions"')) return { rows: [state.wait], rowCount: 1 }
      if (sql.includes('FROM "agent_steps"')) return { rows: [state.step], rowCount: 1 }
      if (sql.includes('SELECT "id", "topic", "aggregateId", "idempotencyKey", "payload" FROM "agent_outbox"')) {
        return { rows: state.resumeOutbox ? [state.resumeOutbox] : [], rowCount: state.resumeOutbox ? 1 : 0 }
      }
      if (sql.includes('FROM "agent_outbox"')) {
        state.outboxLookupParams = params ?? null
        return { rows: state.outbox ? [{ id: "outbox-1" }] : [], rowCount: state.outbox ? 1 : 0 }
      }
      if (sql.includes('UPDATE "agent_sessions"')) { state.eventSequenceUpdates += 1; return { rows: [{ eventSequence: "42" }], rowCount: 1 } }
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
      if (sql.includes('INSERT INTO "agent_events"')) {
        state.eventWrites += 1; state.eventParams = params ?? null
        state.resumeEvent = { id: String(params?.[0]), turnId: String(params?.[2]), sequence: String(params?.[3]), type: "turn.resumed", actor: "system", correlationId: String(params?.[2]), causationId: String(params?.[4]), idempotencyKey: String(params?.[5]), payload: JSON.parse(String(params?.[6])) }
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO "agent_outbox"') && sql.includes("'agent.session.event'")) {
        if (state.failResumeOutbox) throw new Error("resume outbox failed")
        if (state.resumeOutbox) return { rows: [], rowCount: 0 }
        state.eventOutboxWrites += 1; state.eventOutboxParams = params ?? null
        state.resumeOutbox = { id: String(params?.[0]), topic: "agent.session.event", aggregateId: String(params?.[1]), idempotencyKey: String(params?.[2]), payload: JSON.parse(String(params?.[3])) }
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

  it.each(["ready", "timed_out"])('requeues a pre-resolved %s race and writes one resume event plus dispatch outbox row', async waitStatus => {
    const fake = fixture(waitStatus)
    await expect(suspendAndReleaseWait(fake.pool as never, { lease, waitId: "wait-1", now })).resolves.toMatchObject({ handoff: "queued", waitStatus, idempotent: false })
    const second = await suspendAndReleaseWait(fake.pool as never, { lease, waitId: "wait-1", now })
    expect(second).toMatchObject({ handoff: "queued", idempotent: true })
    expect(fake.state.updates).toEqual(["wait", "queue"])
    expect(fake.state.eventSequenceUpdates).toBe(1)
    expect(fake.state.eventWrites).toBe(1)
    expect(fake.state.eventOutboxWrites).toBe(1)
    expect(fake.state.eventParams?.[5]).toBe("agent-wait:wait-1:resumed")
    expect(JSON.parse(String(fake.state.eventParams?.[6]))).toEqual({ waitId: "wait-1", turnId: "turn-1", status: waitStatus, matchedTaskIds: ["child-1"] })
    expect(JSON.parse(String(fake.state.eventOutboxParams?.[3]))).toMatchObject({ sessionId: "session-1", turnId: "turn-1", type: "turn.resumed", idempotencyKey: "agent-wait:wait-1:resumed", payload: { status: waitStatus, matchedTaskIds: ["child-1"] } })
    expect(fake.state.outbox).toBe(true)
    expect(fake.state.outboxWrites).toBe(1)
    expect(fake.calls.filter(sql => sql.includes('UPDATE "agent_wait_conditions"') || sql.includes('UPDATE "agent_turns"') || (sql.includes('INSERT INTO "agent_outbox"') && sql.includes("'agent.turn.dispatch'"))).every(sql => sql.includes(SESSION_FENCE))).toBe(true)
    expect(fake.calls.some(sql => sql.includes('INSERT INTO "agent_outbox"') && sql.includes("WHERE EXISTS"))).toBe(true)
    expect(fake.calls.some(sql => sql.includes('SELECT "id" FROM "agent_outbox"') && sql.includes('"aggregateId" = $3'))).toBe(true)
    expect(fake.state.outboxLookupParams).toEqual(["agent.turn.dispatch", "turn-dispatch:turn-1", "session-1"])
    expect(fake.calls.filter(sql => sql.includes('UPDATE "agent_sessions"')).every(sql => sql.includes(SESSION_FENCE))).toBe(true)
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

  it("repairs a missing resume outbox without appending a second event", async () => {
    const fake = fixture("ready", "queued")
    fake.state.resumeEvent = { id: "resume-event-1", turnId: "turn-1", sequence: "41", type: "turn.resumed", actor: "system", correlationId: "turn-1", causationId: "wait-1", idempotencyKey: "agent-wait:wait-1:resumed", payload: { waitId: "wait-1", turnId: "turn-1", status: "ready", matchedTaskIds: ["child-1"] } }
    await expect(suspendAndReleaseWait(fake.pool as never, { lease, waitId: "wait-1", now })).resolves.toMatchObject({ handoff: "queued", idempotent: true })
    expect(fake.state.eventSequenceUpdates).toBe(0)
    expect(fake.state.eventWrites).toBe(0)
    expect(fake.state.eventOutboxWrites).toBe(1)
    expect(fake.state.resumeOutbox).toMatchObject({ id: "agent-outbox-resume-event-1", aggregateId: "session-1", idempotencyKey: "agent-event:resume-event-1" })
  })

  it.each(["event", "outbox"])('fails closed for a mismatched existing resume %s identity', async kind => {
    const fake = fixture("ready", "queued")
    fake.state.resumeEvent = { id: "resume-event-1", turnId: kind === "event" ? "turn-other" : "turn-1", sequence: "41", type: "turn.resumed", actor: "system", correlationId: "turn-1", causationId: "wait-1", idempotencyKey: "agent-wait:wait-1:resumed", payload: { waitId: "wait-1", turnId: "turn-1", status: "ready", matchedTaskIds: ["child-1"] } }
    if (kind === "outbox") fake.state.resumeOutbox = { id: "foreign-outbox", topic: "agent.session.event", aggregateId: "session-foreign", idempotencyKey: "agent-event:resume-event-1", payload: {} }
    await expect(suspendAndReleaseWait(fake.pool as never, { lease, waitId: "wait-1", now })).rejects.toThrow(kind === "event" ? "wait_resume_event_conflict" : "wait_resume_outbox_conflict")
    expect(fake.state.updates).toEqual([])
    expect(fake.calls.some(sql => sql === "ROLLBACK")).toBe(true)
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

  it("rolls back the queued handoff when the resume outbox cannot be written", async () => {
    const fake = fixture("timed_out", "in_progress", null, "running", "automation", false, true)
    await expect(suspendAndReleaseWait(fake.pool as never, { lease, waitId: "wait-1", now })).rejects.toThrow("resume outbox failed")
    expect(fake.state.updates).toEqual(["wait", "queue"])
    expect(fake.state.eventWrites).toBe(1)
    expect(fake.state.eventOutboxWrites).toBe(0)
    expect(fake.state.outbox).toBe(false)
    expect(fake.calls.some(sql => sql === "ROLLBACK")).toBe(true)
  })
})
