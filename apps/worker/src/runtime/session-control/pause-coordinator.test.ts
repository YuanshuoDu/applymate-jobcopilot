import { beforeEach, describe, expect, it, vi } from "vitest"
import type pg from "pg"

const expiryRecovery = vi.hoisted(() => ({ recoverExpired: vi.fn(async (): Promise<unknown[]> => []) }))
vi.mock("../subagents/pg-store-expiry-recovery.js", () => ({ recoverExpired: expiryRecovery.recoverExpired }))

import { reconcileSessionPause, resumeSession } from "./pause-coordinator.js"

const input = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", now: new Date("2026-10-06T10:00:00.000Z") }
type Event = Record<string, unknown>
const pauseEvent: Event = { id: "pause-event", sessionId: input.sessionId, turnId: input.turnId, sequence: 3, type: "session.pause_requested", actor: "user", taskId: null, itemId: null, correlationId: input.turnId, causationId: null, idempotencyKey: "agent-session-control:pause-1", payload: { turnId: input.turnId, expectedRevision: 4, requestedAt: "2026-10-06T09:59:00.000Z" } }
const resumeEvent: Event = { id: "resume-event", sessionId: input.sessionId, turnId: input.turnId, sequence: 5, type: "session.resume_requested", actor: "user", taskId: null, itemId: null, correlationId: input.turnId, causationId: null, idempotencyKey: "agent-session-control:resume-1", payload: { turnId: input.turnId, expectedRevision: 6, requestedAt: "2026-10-06T10:00:00.000Z" } }

function fixture(options: { sessionStatus?: string; turnStatus?: string; turnRevision?: number; rootTaskId?: string | null; waits?: Event[]; approvals?: Event[]; questions?: Event[]; steps?: Event[]; calls?: Event[]; tasks?: Event[]; turnLease?: Event; withResume?: boolean; existingDispatch?: boolean } = {}) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [], events = [pauseEvent, ...(options.withResume ? [resumeEvent] : [])], outboxes: Event[] = options.existingDispatch ? [{ topic: "agent.turn.dispatch", aggregateId: input.sessionId, idempotencyKey: `turn-dispatch:${input.turnId}`, payload: { turnId: input.turnId, sessionId: input.sessionId, ownerId: "stale" }, publishedAt: new Date() }] : []
  let sessionStatus = options.sessionStatus ?? (options.withResume ? "resuming" : "pausing"), turnStatus = options.turnStatus ?? "queued", revision = options.turnRevision ?? 6, eventSequence = 10
  const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
    calls.push({ sql, values })
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
    if (sql.includes('SELECT session."id", session."status"')) return { rows: [{ id: input.sessionId, status: sessionStatus }], rowCount: 1 }
    if (sql.includes('SELECT turn."id", turn."status", turn."revision"')) return { rows: [{ id: input.turnId, status: turnStatus, revision, rootTaskId: options.rootTaskId ?? null, leaseOwnerId: options.turnLease?.leaseOwnerId ?? null, leaseExpiresAt: options.turnLease?.leaseExpiresAt ?? null }], rowCount: 1 }
    if (sql.includes("FROM \"agent_events\" AS pause")) return { rows: [pauseEvent], rowCount: 1 }
    if (sql.includes("FROM \"agent_events\" AS event") && sql.includes("session.resume_requested")) return { rows: options.withResume ? [resumeEvent] : [], rowCount: options.withResume ? 1 : 0 }
    if (sql.includes("FROM \"agent_events\" AS event") && sql.includes('"sequence" < $3')) return { rows: [pauseEvent], rowCount: 1 }
    if (sql.includes('SELECT "id", "taskId", "turnId", "itemId", "type", "actor"')) return { rows: events.filter(event => event.idempotencyKey === values?.[1]), rowCount: events.some(event => event.idempotencyKey === values?.[1]) ? 1 : 0 }
    if (sql.includes('UPDATE "agent_sessions" SET "eventSequence"')) return { rows: [{ eventSequence: ++eventSequence }], rowCount: 1 }
    if (sql.includes('INSERT INTO "agent_events"')) {
      const row = { id: values?.[0], sessionId: values?.[1], turnId: values?.[2], itemId: null, taskId: values?.[3], sequence: values?.[4], type: values?.[5], actor: "orchestrator", correlationId: values?.[2], causationId: values?.[6], idempotencyKey: values?.[7], payload: JSON.parse(String(values?.[8])) as unknown }
      events.push(row); return { rows: [], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO "agent_outbox"')) {
      if (values?.[1] === "agent.turn.dispatch") {
        const existing = outboxes.find(item => item.idempotencyKey === values?.[3])
        if (existing) { existing.payload = JSON.parse(String(values?.[4])) as unknown; existing.publishedAt = null; return { rows: [], rowCount: 0 } }
        outboxes.push({ topic: values[1], aggregateId: values[2], idempotencyKey: values[3], payload: JSON.parse(String(values[4])) as unknown })
        return { rows: [], rowCount: 1 }
      }
      const row = { id: values?.[0], topic: "agent.session.event", aggregateId: values?.[1], idempotencyKey: values?.[2], payload: JSON.parse(String(values?.[3])) as unknown }
      const duplicate = outboxes.some(item => item.idempotencyKey === row.idempotencyKey); if (!duplicate) outboxes.push(row)
      return { rows: [], rowCount: duplicate ? 0 : 1 }
    }
    if (sql.includes('SELECT "id", "topic", "aggregateId", "idempotencyKey", "payload" FROM "agent_outbox"')) return { rows: outboxes.filter(item => item.idempotencyKey === values?.[0]), rowCount: 1 }
    if (sql.includes('SELECT "aggregateId", "topic" FROM "agent_outbox"')) return { rows: [{ aggregateId: input.sessionId, topic: "agent.turn.dispatch" }], rowCount: 1 }
    if (sql.includes('FROM "agent_wait_conditions"')) return { rows: options.waits ?? [], rowCount: options.waits?.length ?? 0 }
    if (sql.includes('FROM "agent_approvals"')) return { rows: options.approvals ?? [], rowCount: options.approvals?.length ?? 0 }
    if (sql.includes('FROM "agent_items"')) return { rows: options.questions ?? [], rowCount: options.questions?.length ?? 0 }
    if (sql.includes('FROM "agent_steps"')) return { rows: options.steps ?? [], rowCount: options.steps?.length ?? 0 }
    if (sql.includes('SELECT started."taskId"')) return { rows: options.calls ?? [], rowCount: options.calls?.length ?? 0 }
    if (sql.includes('FROM "sub_agent_tasks"')) return { rows: options.tasks ?? [], rowCount: options.tasks?.length ?? 0 }
    if (sql.includes("UPDATE \"agent_turns\" SET")) { turnStatus = sql.includes("SET \"status\" = 'queued'") ? "queued" : String(values?.[2]); revision += 1; return { rows: [], rowCount: 1 } }
    if (sql.includes("UPDATE \"agent_sessions\" SET \"status\"")) {
      sessionStatus = sql.includes("SET \"status\" = 'pausing'") ? "pausing" : sql.includes("SET \"status\" = 'paused'") ? "paused" : sql.includes("SET \"status\" = 'running'") ? "running" : String(values?.[2])
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('SELECT session."id" FROM "agent_sessions"')) return { rows: [{ id: input.sessionId }], rowCount: 1 }
    if (sql.includes('SELECT turn."id"') && sql.includes('FROM "agent_turns"')) return { rows: [{ id: input.turnId }], rowCount: 1 }
    return { rows: [], rowCount: 1 }
  }), release: vi.fn() }
  return { pool: { connect: vi.fn(async () => client) } as unknown as pg.Pool, client, calls, events, outboxes, getSessionStatus: () => sessionStatus, getTurnStatus: () => turnStatus, setTurnRevision: (value: number) => { revision = value } }
}

function sessionEventOutboxes(outboxes: Event[], type: string): Event[] {
  return outboxes.filter(item => {
    const payload = item.payload
    return item.topic === "agent.session.event" && !!payload && typeof payload === "object" && !Array.isArray(payload)
      && (payload as Record<string, unknown>).type === type
  })
}
function resumedOutboxes(outboxes: Event[]): Event[] { return sessionEventOutboxes(outboxes, "session.resumed") }

function reverseJsonObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseJsonObjectKeys)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, nested]) => [key, reverseJsonObjectKeys(nested)]))
  }
  return value
}

describe("session pause coordinator", () => {
  beforeEach(() => {
    expiryRecovery.recoverExpired.mockReset()
    expiryRecovery.recoverExpired.mockResolvedValue([])
  })

  it("consumes the API user request and writes only Worker pause outcome events after Session/Turn locks", async () => {
    const fake = fixture()
    await expect(reconcileSessionPause(fake.pool, input)).resolves.toMatchObject({ state: "paused", preservedWaitCount: 0 })
    const sessionLock = fake.calls.findIndex(call => call.sql.includes('SELECT session."id", session."status"'))
    const turnLock = fake.calls.findIndex(call => call.sql.includes('SELECT turn."id", turn."status", turn."revision"'))
    const waitLock = fake.calls.findIndex(call => call.sql.includes('FROM "agent_wait_conditions"'))
    const stepLock = fake.calls.findIndex(call => call.sql.includes('FROM "agent_steps"'))
    const eventWrite = fake.calls.findIndex(call => call.sql.includes('INSERT INTO "agent_events"'))
    const outboxWrite = fake.calls.findIndex(call => call.sql.includes('INSERT INTO "agent_outbox"'))
    expect(sessionLock).toBeLessThan(turnLock); expect(turnLock).toBeLessThan(waitLock); expect(waitLock).toBeLessThan(stepLock)
    expect(stepLock).toBeLessThan(eventWrite); expect(eventWrite).toBeLessThan(outboxWrite)
    expect(fake.events.filter(event => event.type === "session.pause_requested")).toEqual([pauseEvent])
    expect(fake.events.some(event => event.type === "session.paused" && event.actor === "orchestrator")).toBe(true)
    expect(fake.outboxes[0]).toMatchObject({ topic: "agent.session.event", payload: { taskId: null, type: "session.paused", actor: "orchestrator" } })
    expect(fake.getSessionStatus()).toBe("paused")
  })

  it("stays pausing while a started call or live Turn lease remains", async () => {
    const fake = fixture({ calls: [{ taskId: "root-1", correlationId: "call-1" }], turnStatus: "in_progress", turnLease: { leaseOwnerId: "worker-1", leaseExpiresAt: new Date("2026-10-06T10:01:00.000Z") } })
    await expect(reconcileSessionPause(fake.pool, input)).resolves.toMatchObject({ state: "pausing", blockers: ["started_external_call", "turn_not_quiescent"] })
    expect(fake.getSessionStatus()).toBe("pausing")
    expect(fake.events.some(event => event.type === "session.pause_blocked")).toBe(true)
  })

  it("reuses a blocked pause event and outbox when PostgreSQL reorders nested JSONB keys", async () => {
    const fake = fixture({ calls: [{ taskId: "root-1", correlationId: "call-1" }], turnStatus: "in_progress", turnLease: { leaseOwnerId: "worker-1", leaseExpiresAt: new Date("2026-10-06T10:01:00.000Z") } })
    const blockers = ["started_external_call", "turn_not_quiescent"]
    await expect(reconcileSessionPause(fake.pool, input)).resolves.toMatchObject({ state: "pausing", blockers })

    const blocked = fake.events.find(event => event.type === "session.pause_blocked")
    const outbox = sessionEventOutboxes(fake.outboxes, "session.pause_blocked")[0]
    expect(blocked).toBeDefined()
    expect(outbox).toBeDefined()
    blocked!.payload = reverseJsonObjectKeys(blocked!.payload)
    outbox!.payload = reverseJsonObjectKeys(outbox!.payload)
    const retryAt = new Date(input.now.getTime() + 1_000)

    await expect(reconcileSessionPause(fake.pool, { ...input, now: retryAt })).resolves.toMatchObject({ state: "pausing", blockers })

    expect(fake.events.filter(event => event.type === "session.pause_blocked")).toHaveLength(1)
    expect(sessionEventOutboxes(fake.outboxes, "session.pause_blocked")).toHaveLength(1)
    const sessionUpdates = fake.calls.filter(call => call.sql.includes('UPDATE "agent_sessions" SET "status" = \'pausing\''))
    expect(sessionUpdates).toHaveLength(2)
    expect(sessionUpdates[1]?.values).toEqual([input.sessionId, input.userId, retryAt])
  })

  it("preserves dependency wait state while marking quiescent session paused", async () => {
    const fake = fixture({ turnStatus: "waiting_for_dependency", waits: [{ id: "wait-1", status: "waiting" }] })
    await expect(reconcileSessionPause(fake.pool, input)).resolves.toMatchObject({ state: "paused", preservedWaitCount: 1 })
    expect(fake.getSessionStatus()).toBe("paused")
    expect(fake.calls.some(call => call.sql.startsWith("UPDATE \"agent_wait_conditions\""))).toBe(false)
  })

  it("recovers only explicitly expired leases when no Step or external call is started", async () => {
    const expiredAt = new Date("2026-10-06T09:59:00.000Z")
    const fake = fixture({ rootTaskId: "root-1", turnStatus: "in_progress", turnLease: { leaseOwnerId: "worker-1", leaseExpiresAt: expiredAt }, tasks: [{ id: "root-1", status: "running", leaseOwner: "worker-1", leaseExpiresAt: expiredAt, interruptRequestedAt: null }] })
    await expect(reconcileSessionPause(fake.pool, input)).resolves.toMatchObject({ state: "paused", recoveredExpiredLeases: 2 })
    expect(fake.calls.some(call => call.sql.includes('SET "status" = \'queued\'') && call.sql.includes('"leaseVersion" = "leaseVersion" + 1'))).toBe(true)
  })

  it("runs graph-aware exact-Turn expiry recovery before deciding pause completion", async () => {
    const expiredAt = new Date(input.now.getTime() - 1_000)
    const child: Event = { id: "child-1", status: "running", leaseOwner: "worker-1", leaseExpiresAt: expiredAt, interruptRequestedAt: null }
    const fake = fixture({ rootTaskId: "root-1", tasks: [child] })
    expiryRecovery.recoverExpired.mockImplementation(async () => {
      child.status = "queued"
      child.leaseOwner = null
      child.leaseExpiresAt = null
      fake.events.push({ type: "task.retrying", actor: "orchestrator" })
      return [child]
    })

    await expect(reconcileSessionPause(fake.pool, input)).resolves.toMatchObject({ state: "paused", recoveredExpiredLeases: 1 })

    expect(expiryRecovery.recoverExpired).toHaveBeenCalledWith(fake.pool, {
      now: input.now, limit: 50, sessionId: input.sessionId, turnId: input.turnId,
    })
    const graphReceipt = fake.events.findIndex(event => event.type === "task.retrying")
    const paused = fake.events.findIndex(event => event.type === "session.paused")
    expect(graphReceipt).toBeGreaterThan(-1)
    expect(graphReceipt).toBeLessThan(paused)
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
  })

  it("consumes API resume and dispatches the same queued Turn only after durable wait checks", async () => {
    const fake = fixture({ sessionStatus: "resuming", withResume: true })
    await expect(resumeSession(fake.pool, input)).resolves.toEqual({ status: "queued", sessionStatus: "running", dispatched: true })
    expect(fake.events.filter(event => event.type === "session.resume_requested")).toEqual([resumeEvent])
    expect(fake.outboxes.some(item => item.topic === "agent.turn.dispatch")).toBe(true)
    const resumed = fake.events.find(event => event.type === "session.resumed")
    expect(resumed).toMatchObject({ actor: "orchestrator", causationId: resumeEvent.id, payload: { resumeRequestEventId: resumeEvent.id, turnId: input.turnId } })
    expect(resumedOutboxes(fake.outboxes)).toHaveLength(1)
    expect(resumedOutboxes(fake.outboxes)[0]).toMatchObject({
      idempotencyKey: `agent-event:${String(resumed?.id)}`,
      payload: { type: "session.resumed", actor: "orchestrator", causationId: resumeEvent.id },
    })
    expect(fake.calls.some(call => call.sql.startsWith("UPDATE \"agent_wait_conditions\""))).toBe(false)
  })

  it("keeps an accepted resume pending while an unresolved dependency wait remains", async () => {
    const fake = fixture({ sessionStatus: "resuming", withResume: true, turnStatus: "waiting_for_dependency", waits: [{ id: "wait-1", status: "waiting" }] })
    await expect(resumeSession(fake.pool, input)).resolves.toEqual({ status: "waiting_for_dependency", sessionStatus: "resuming", dispatched: false })
    expect(fake.getTurnStatus()).toBe("waiting_for_dependency")
    expect(fake.getSessionStatus()).toBe("resuming")
    expect(fake.outboxes.some(item => item.topic === "agent.turn.dispatch")).toBe(false)
    expect(fake.events.some(event => event.type === "session.resumed")).toBe(false)
    expect(resumedOutboxes(fake.outboxes)).toHaveLength(0)
    expect(fake.calls.some(call => call.sql.startsWith("UPDATE \"agent_wait_conditions\""))).toBe(false)
    const update = fake.calls.find(call => call.sql.includes('UPDATE "agent_sessions" SET "status" = $3'))
    expect(update?.sql).toContain('"updatedAt" = $4')
    expect(update?.values).toEqual([input.sessionId, input.userId, "resuming", input.now])
  })

  it("retries the same Turn after a dependency wait becomes ready", async () => {
    const wait = { id: "wait-1", status: "waiting" }
    const fake = fixture({ sessionStatus: "resuming", withResume: true, turnStatus: "waiting_for_dependency", waits: [wait] })
    await expect(resumeSession(fake.pool, input)).resolves.toEqual({ status: "waiting_for_dependency", sessionStatus: "resuming", dispatched: false })
    expect(fake.outboxes.some(item => item.topic === "agent.turn.dispatch")).toBe(false)
    expect(fake.events.some(event => event.type === "session.resumed")).toBe(false)
    expect(resumedOutboxes(fake.outboxes)).toHaveLength(0)

    wait.status = "ready"
    await expect(resumeSession(fake.pool, input)).resolves.toEqual({ status: "queued", sessionStatus: "running", dispatched: true })
    expect(fake.getTurnStatus()).toBe("queued")
    expect(fake.getSessionStatus()).toBe("running")
    expect(fake.outboxes.filter(item => item.topic === "agent.turn.dispatch")).toHaveLength(1)
    expect(fake.events.filter(event => event.type === "session.resumed")).toHaveLength(1)
    expect(resumedOutboxes(fake.outboxes)).toHaveLength(1)
    expect(fake.outboxes.find(item => item.topic === "agent.turn.dispatch")).toMatchObject({ idempotencyKey: `turn-dispatch:${input.turnId}`, payload: { turnId: input.turnId, ownerId: `resume:${resumeEvent.id}` } })
  })

  it.each(["waiting_for_dependency", "queued"])("redispatches the same Turn after a dependency wait is ready (%s)", async turnStatus => {
    const fake = fixture({ sessionStatus: "resuming", withResume: true, turnStatus, waits: [{ id: "wait-1", status: "ready" }], existingDispatch: true })
    await expect(resumeSession(fake.pool, input)).resolves.toEqual({ status: "queued", sessionStatus: "running", dispatched: true })
    expect(fake.getTurnStatus()).toBe("queued")
    expect(fake.getSessionStatus()).toBe("running")
    expect(fake.outboxes.filter(item => item.topic === "agent.turn.dispatch")).toHaveLength(1)
    expect(fake.outboxes.find(item => item.topic === "agent.turn.dispatch")).toMatchObject({ idempotencyKey: `turn-dispatch:${input.turnId}`, publishedAt: null, payload: { turnId: input.turnId, sessionId: input.sessionId, ownerId: `resume:${resumeEvent.id}` } })
    expect(fake.events.filter(event => event.type === "session.resumed")).toHaveLength(1)
    expect(resumedOutboxes(fake.outboxes)).toHaveLength(1)
    expect(fake.calls.some(call => call.sql.includes('UPDATE "agent_wait_conditions"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.includes('"publishedAt" = NULL'))).toBe(true)
  })

  it("keeps pending approvals and questions on the user-wait projection", async () => {
    const approval = fixture({ sessionStatus: "resuming", withResume: true, turnStatus: "waiting_for_approval", approvals: [{ id: "approval-1" }] })
    await expect(resumeSession(approval.pool, input)).resolves.toMatchObject({ status: "waiting_for_approval", sessionStatus: "resuming", dispatched: false })
    expect(approval.getTurnStatus()).toBe("waiting_for_approval")
    expect(approval.outboxes.some(item => item.topic === "agent.turn.dispatch")).toBe(false)
    expect(approval.events.some(event => event.type === "session.resumed")).toBe(false)
    expect(resumedOutboxes(approval.outboxes)).toHaveLength(0)
    const question = fixture({ sessionStatus: "resuming", withResume: true, turnStatus: "waiting_for_user", questions: [{ id: "question-1" }] })
    await expect(resumeSession(question.pool, input)).resolves.toMatchObject({ status: "waiting_for_user", sessionStatus: "resuming", dispatched: false })
    expect(question.getTurnStatus()).toBe("waiting_for_user")
    expect(question.outboxes.some(item => item.topic === "agent.turn.dispatch")).toBe(false)
    expect(question.events.some(event => event.type === "session.resumed")).toBe(false)
    expect(resumedOutboxes(question.outboxes)).toHaveLength(0)
  })

  it("retries an accepted resume after approval or question resolution advances the Turn revision", async () => {
    const approvalRows = [{ id: "approval-1" }]
    const approval = fixture({ sessionStatus: "resuming", withResume: true, turnStatus: "waiting_for_approval", approvals: approvalRows })
    await expect(resumeSession(approval.pool, input)).resolves.toMatchObject({ status: "waiting_for_approval", sessionStatus: "resuming", dispatched: false })
    approvalRows.splice(0, 1)
    approval.setTurnRevision(7)
    await expect(resumeSession(approval.pool, input)).resolves.toMatchObject({ status: "queued", sessionStatus: "running", dispatched: true })
    expect(approval.events.filter(event => event.type === "session.resumed")).toHaveLength(1)
    expect(resumedOutboxes(approval.outboxes)).toHaveLength(1)

    const questionRows = [{ id: "question-1" }]
    const question = fixture({ sessionStatus: "resuming", withResume: true, turnStatus: "waiting_for_user", questions: questionRows })
    await expect(resumeSession(question.pool, input)).resolves.toEqual({ status: "waiting_for_user", sessionStatus: "resuming", dispatched: false })
    expect(question.getTurnStatus()).toBe("waiting_for_user")
    expect(question.outboxes.some(item => item.topic === "agent.turn.dispatch")).toBe(false)
    questionRows.splice(0, 1)
    question.setTurnRevision(7)
    await expect(resumeSession(question.pool, input)).resolves.toEqual({ status: "queued", sessionStatus: "running", dispatched: true })
    expect(question.getTurnStatus()).toBe("queued")
    expect(question.getSessionStatus()).toBe("running")
    expect(question.outboxes.filter(item => item.topic === "agent.turn.dispatch")).toHaveLength(1)
    expect(question.events.filter(event => event.type === "session.resumed")).toHaveLength(1)
    expect(resumedOutboxes(question.outboxes)).toHaveLength(1)
    expect(question.outboxes.find(item => item.topic === "agent.turn.dispatch")).toMatchObject({ idempotencyKey: `turn-dispatch:${input.turnId}`, payload: { turnId: input.turnId, ownerId: `resume:${resumeEvent.id}` } })
  })

  it("rejects a resume event whose accepted revision is ahead of the current Turn", async () => {
    const fake = fixture({ sessionStatus: "resuming", withResume: true, turnStatus: "waiting_for_user", turnRevision: 5 })
    await expect(resumeSession(fake.pool, input)).rejects.toThrow("session_control_resume_request_unavailable")
    expect(fake.getSessionStatus()).toBe("resuming")
    expect(fake.outboxes.some(item => item.topic === "agent.turn.dispatch")).toBe(false)
  })

  it("dispatches an answered question after its accepted resume revision advances from 6 to 7", async () => {
    const fake = fixture({ sessionStatus: "resuming", withResume: true, turnStatus: "waiting_for_user", turnRevision: 7, questions: [] })
    await expect(resumeSession(fake.pool, input)).resolves.toEqual({ status: "queued", sessionStatus: "running", dispatched: true })
    expect(fake.getTurnStatus()).toBe("queued")
    expect(fake.getSessionStatus()).toBe("running")
    expect(fake.outboxes.filter(item => item.topic === "agent.turn.dispatch")).toHaveLength(1)
    expect(fake.events.filter(event => event.type === "session.resumed")).toHaveLength(1)
    expect(resumedOutboxes(fake.outboxes)).toHaveLength(1)
    expect(fake.outboxes.find(item => item.topic === "agent.turn.dispatch")).toMatchObject({ idempotencyKey: `turn-dispatch:${input.turnId}`, payload: { turnId: input.turnId, ownerId: `resume:${resumeEvent.id}` } })
  })

  it.each([
    ["completed", "completed"],
    ["failed", "failed"],
    ["interrupted", "paused"],
    ["cancelled", "paused"],
    ["aborted", "paused"],
    ["archived", "paused"],
  ] as const)("settles a stale resume for terminal Turn %s as session %s without dispatch", async (turnStatus, sessionStatus) => {
    const fake = fixture({ sessionStatus: "resuming", withResume: true, turnStatus })
    await expect(resumeSession(fake.pool, input)).resolves.toEqual({ status: turnStatus, sessionStatus, dispatched: false })
    expect(fake.getSessionStatus()).toBe(sessionStatus)
    expect(fake.outboxes.some(item => item.topic === "agent.turn.dispatch")).toBe(false)
    expect(fake.events.some(event => event.type === "session.resumed")).toBe(false)
    expect(resumedOutboxes(fake.outboxes)).toHaveLength(0)
    const update = fake.calls.find(call => call.sql.includes('UPDATE "agent_sessions" SET "status" = $3'))
    expect(update?.sql).toContain('"completedAt" = $4')
    expect(update?.values).toEqual([
      input.sessionId,
      input.userId,
      sessionStatus,
      sessionStatus === "completed" || sessionStatus === "failed" ? input.now : null,
      input.now,
    ])
  })

  it("rejects a missing API-authored resume event instead of manufacturing one", async () => {
    const fake = fixture({ sessionStatus: "resuming" })
    await expect(resumeSession(fake.pool, input)).rejects.toThrow("session_control_resume_request_unavailable")
    expect(fake.events.some(event => event.type === "session.resume_requested")).toBe(false)
  })
})
