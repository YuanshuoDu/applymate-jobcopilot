import { describe, expect, it, vi } from "vitest"

import { reconcileDurableWaits, startDurableWaitResolver } from "./durable-wait-resolver.js"

const now = new Date("2026-09-09T12:00:00.000Z")
const SESSION_FENCE = 'session."status" NOT IN (\'aborted\', \'archived\')'

type Steer = { userId: string; sessionId: string; targetTurnId: string; delivery: string; status: string; consumedByStepId: string | null; consumedAt: Date | null; cancelledAt: Date | null; acceptedSequence: string; content: string }
function fixture(input: { turnStatus?: string; waitStatus?: string; waitParentTaskId?: string; suspended?: boolean; deadline?: Date; targetStatus?: string; targetUser?: string; consumed?: boolean; turnCount?: number; sessionStatus?: string; sessionSource?: string; closeBeforeWake?: boolean; closeBeforeOutbox?: boolean; checkpoint?: string; steer?: Partial<Steer> }) {
  const turn = { id: "turn-1", userId: "user-1", sessionId: "session-1", rootTaskId: "root-1", status: input.turnStatus ?? "in_progress", leaseOwnerId: null, sessionStatus: input.sessionStatus ?? "running" }
  const wait = { id: "wait-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: input.waitParentTaskId ?? "root-1", stepId: "step-1", targetTaskIds: ["child-1"], mode: "any", status: input.waitStatus ?? "waiting", deadlineAt: input.deadline ?? new Date("2026-09-09T13:00:00.000Z"), suspendedAt: input.suspended ? now : null, consumedAt: input.consumed ? now : null, matchedTaskIds: [] }
  const secondTurn = { ...turn, id: "turn-2", rootTaskId: "root-2", sessionId: "session-2", userId: "user-2" }
  const secondWait = { ...wait, id: "wait-2", turnId: "turn-2", parentTaskId: "root-2", stepId: "step-2", userId: "user-2", sessionId: "session-2", targetTaskIds: ["child-2"] }
  const turns = input.turnCount === 2 ? [turn, secondTurn] : [turn]
  const waits = input.turnCount === 2 ? [wait, secondWait] : [wait]
  const steer: Steer = { userId: "user-1", sessionId: "session-1", targetTurnId: "turn-1", delivery: "steer", status: "accepted", consumedByStepId: null, consumedAt: null, cancelledAt: null, acceptedSequence: "9007199254740993", content: "private steer content" , ...input.steer }
  const state = { turns, waits, steer, checkpoint: input.checkpoint ?? "9007199254740992", targetUser: input.targetUser ?? "user-1", targetStatus: input.targetStatus ?? "completed", sessionStatus: input.sessionStatus ?? "running", sessionSource: input.sessionSource ?? "automation", waitUpdates: 0, turnUpdates: 0, eventWrites: 0, eventOutboxWrites: 0, outboxWrites: 0, outboxPublished: false, conflictResets: 0, steerProbes: 0, steerProbeParams: null as unknown[] | null, eventParams: null as unknown[] | null, eventOutboxParams: null as unknown[] | null, outboxParams: null as unknown[] | null }
  const calls: string[] = []
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push(sql)
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 1 }
      if (sql.includes('SELECT turn."id"') && sql.includes('JOIN "agent_turns" AS turn')) {
        if (["aborted", "archived", "missing"].includes(state.sessionStatus)) {
          if (!sql.includes(SESSION_FENCE)) throw new Error("missing session-state fence")
          return { rows: [], rowCount: 0 }
        }
        return { rows: state.turns.filter(candidate => candidate.status === "in_progress" || candidate.status === "waiting_for_dependency"), rowCount: state.turns.length }
      }
      if (sql.includes('FROM "agent_wait_conditions"')) {
        const turnId = String(params?.[2]); const limit = Number(params?.[3])
        return { rows: state.waits.filter(candidate => candidate.turnId === turnId && !candidate.consumedAt && ["waiting", "ready", "timed_out"].includes(candidate.status)).slice(0, limit), rowCount: 1 }
      }
      if (sql.includes('FROM "sub_agent_tasks"') && sql.includes('ANY($1::text[])')) {
        const turnId = String(params?.[2]); const userId = String(params?.[3]); const id = turnId === "turn-2" ? "child-2" : "child-1"
        return { rows: state.targetUser === userId ? [{ id, rootTaskId: turnId === "turn-2" ? "root-2" : "root-1", turnId, sessionId: String(params?.[1]), userId, status: state.targetStatus }] : [], rowCount: 1 }
      }
      if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [{ id: String(params?.[0]), rootTaskId: input.waitParentTaskId === "child-1" ? "root-1" : String(params?.[0]), turnId: String(params?.[2]), sessionId: String(params?.[1]), userId: String(params?.[3]) }], rowCount: 1 }
      if (sql.includes('FROM "agent_steps"')) return { rows: [{ id: "step-1", taskId: "root-1", attempt: 1, status: "waiting_for_tool", inputThroughSequence: state.checkpoint }], rowCount: 1 }
      if (sql.includes('FROM "agent_inputs" AS input')) {
        state.steerProbes += 1
        state.steerProbeParams = params ?? null
        const pending = state.steer.userId === String(params?.[0]) && state.steer.sessionId === String(params?.[1]) && state.steer.targetTurnId === String(params?.[2])
          && ["accepted", "queued"].includes(state.steer.status) && state.steer.delivery === "steer"
          && state.steer.consumedByStepId === null && state.steer.consumedAt === null && state.steer.cancelledAt === null
          && BigInt(state.steer.acceptedSequence) > BigInt(String(params?.[3]))
        return { rows: [{ pending }], rowCount: 1 }
      }
      if (sql.includes('UPDATE "agent_sessions"')) return { rows: [{ eventSequence: "42" }], rowCount: 1 }
      if (sql.includes('UPDATE "agent_wait_conditions"')) {
        const found = state.waits.find(candidate => candidate.id === String(params?.[3]))
        if (found) { found.status = String(params?.[0]); found.matchedTaskIds = JSON.parse(String(params?.[1])); state.waitUpdates += 1; if (input.closeBeforeWake) state.sessionStatus = "aborted" }
        return { rows: [], rowCount: found ? 1 : 0 }
      }
      if (sql.includes('UPDATE "agent_turns"')) {
        if (state.sessionStatus === "aborted" || state.sessionStatus === "archived") { if (!sql.includes(SESSION_FENCE)) throw new Error("missing session-state fence"); return { rows: [], rowCount: 0 } }
        const found = state.turns.find(candidate => candidate.id === String(params?.[0]))
        if (found) { found.status = "queued"; state.turnUpdates += 1 }
        return { rows: [], rowCount: found ? 1 : 0 }
      }
      if (sql.includes('INSERT INTO "agent_events"')) {
        state.eventWrites += 1; state.eventParams = params ?? null; return { rows: [], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO "agent_outbox"')) {
        if (sql.includes("'agent.session.event'")) {
          if (input.closeBeforeOutbox) { state.sessionStatus = "aborted"; return { rows: [], rowCount: 0 } }
          state.eventOutboxWrites += 1; state.eventOutboxParams = params ?? null; return { rows: [], rowCount: 1 }
        }
        if (input.closeBeforeOutbox) { state.sessionStatus = "aborted"; if (!sql.includes(SESSION_FENCE)) throw new Error("missing session-state fence"); return { rows: [], rowCount: 0 } }
        state.outboxParams = params ?? null
        if (state.outboxPublished && sql.includes("DO UPDATE")) state.conflictResets += 1; state.outboxWrites += 1; state.outboxPublished = false; return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    },
    release() {},
  }
  return { pool: { connect: async () => client }, state, calls }
}

describe("durable wait resolver", () => {
  it("marks an early terminal match ready without waking an unsuspended parent", async () => {
    const fake = fixture({})
    await expect(reconcileDurableWaits(fake.pool as never, { now })).resolves.toEqual({ scanned: 1, resolved: 1, woken: 0 })
    const turnScan = fake.calls.find(sql => sql.includes('JOIN "agent_turns" AS turn') && sql.includes('ORDER BY turn."updatedAt"')) ?? ""
    const waitScan = fake.calls.find(sql => sql.includes('FROM "agent_wait_conditions"') && sql.includes('ORDER BY "createdAt"')) ?? ""
    expect(turnScan).toContain('ORDER BY turn."updatedAt" ASC, turn."id" ASC LIMIT $1 FOR UPDATE OF session, turn SKIP LOCKED')
    expect(turnScan).toContain('JOIN "agent_turns" AS turn ON turn."sessionId" = session."id" AND turn."userId" = session."userId"')
    expect(waitScan).toContain('ORDER BY "createdAt" ASC, "id" ASC LIMIT $4 FOR UPDATE SKIP LOCKED')
    expect(fake.state.waits[0].status).toBe("ready")
    expect(fake.state.turns[0].status).toBe("in_progress")
    expect(fake.state.eventWrites).toBe(0)
    expect(fake.state.eventOutboxWrites).toBe(0)
    expect(fake.state.outboxWrites).toBe(0)
  })

  it("wakes a suspended parent and creates one dispatch outbox row", async () => {
    const fake = fixture({ suspended: true, turnStatus: "waiting_for_dependency" })
    fake.state.outboxPublished = true
    await expect(reconcileDurableWaits(fake.pool as never, { now, ownerId: "resolver-1" })).resolves.toEqual({ scanned: 1, resolved: 1, woken: 1 })
    expect(fake.state.turns[0].status).toBe("queued")
    expect(fake.state.eventWrites).toBe(1)
    expect(fake.state.eventOutboxWrites).toBe(1)
    expect(fake.state.eventParams?.[5]).toBe("agent-wait:wait-1:resumed")
    expect(JSON.parse(String(fake.state.eventParams?.[6]))).toEqual({ waitId: "wait-1", turnId: "turn-1", status: "ready", matchedTaskIds: ["child-1"] })
    expect(fake.state.eventOutboxParams?.[1]).toBe("session-1")
    expect(JSON.parse(String(fake.state.eventOutboxParams?.[3]))).toMatchObject({ sessionId: "session-1", turnId: "turn-1", type: "turn.resumed", idempotencyKey: "agent-wait:wait-1:resumed", sequence: "42" })
    expect(fake.state.outboxWrites).toBe(1)
    expect(fake.state.conflictResets).toBe(1)
    expect(fake.state.outboxParams?.[2]).toBe("session-1")
    expect(fake.state.outboxParams?.[2]).not.toBe("turn-1")
    expect(fake.state.outboxParams?.[3]).toBe("turn-dispatch:turn-1")
    expect(fake.calls.some(sql => sql.includes('WHERE "agent_outbox"."aggregateId" = EXCLUDED."aggregateId"'))).toBe(true)
    expect(fake.state.waitUpdates).toBe(1)
    expect(fake.state.turnUpdates).toBe(1)
    expect(fake.calls.some(sql => sql.includes('session."status" NOT IN (\'aborted\', \'archived\')'))).toBe(true)
    expect(fake.calls.some(sql => sql.includes('INSERT INTO "agent_outbox"') && sql.includes("WHERE EXISTS"))).toBe(true)
    expect(fake.calls.filter(sql => sql.includes('UPDATE "agent_wait_conditions"') || sql.includes('UPDATE "agent_turns"')).every(sql => sql.includes(SESSION_FENCE))).toBe(true)
    await expect(reconcileDurableWaits(fake.pool as never, { now, ownerId: "resolver-1" })).resolves.toEqual({ scanned: 0, resolved: 0, woken: 0 })
    expect(fake.state.eventWrites).toBe(1)
    expect(fake.state.eventOutboxWrites).toBe(1)
    expect(fake.state.outboxWrites).toBe(1)
  })

  it.each(["accepted", "queued"] as const)("interrupts only a pending suspended root wait for fresh %s steering", async status => {
    const fake = fixture({ suspended: true, turnStatus: "waiting_for_dependency", targetStatus: "running", steer: { status } })
    await expect(reconcileDurableWaits(fake.pool as never, { now, ownerId: "resolver-1" })).resolves.toEqual({ scanned: 1, resolved: 1, woken: 1 })
    expect(fake.state.waits[0]).toMatchObject({ status: "interrupted", matchedTaskIds: [] })
    expect(fake.state.turns[0].status).toBe("queued")
    expect(fake.state.targetStatus).toBe("running")
    expect(fake.state.steerProbes).toBe(1)
    expect(fake.state.steerProbeParams).toEqual(["user-1", "session-1", "turn-1", "9007199254740992"])
    const probe = fake.calls.find(sql => sql.includes('FROM "agent_inputs" AS input')) ?? ""
    expect(probe).toContain('input."userId" = $1 AND input."sessionId" = $2 AND input."targetTurnId" = $3')
    expect(probe).toContain('input."delivery" = \'steer\'')
    expect(probe).toContain('input."status" IN (\'accepted\', \'queued\')')
    expect(probe).toContain('input."consumedByStepId" IS NULL AND input."consumedAt" IS NULL AND input."cancelledAt" IS NULL')
    expect(probe).toContain('input."acceptedSequence" > $4::bigint')
    expect(probe).not.toContain('input."content"')
    const parentLock = fake.calls.findIndex(sql => sql.includes('FROM "sub_agent_tasks"') && !sql.includes("ANY($1::text[])"))
    const stepLock = fake.calls.findIndex(sql => sql.includes('FROM "agent_steps"'))
    const targetRead = fake.calls.findIndex(sql => sql.includes('FROM "sub_agent_tasks"') && sql.includes("ANY($1::text[])"))
    const steerProbe = fake.calls.indexOf(probe)
    const waitUpdate = fake.calls.findIndex(sql => sql.includes('UPDATE "agent_wait_conditions"'))
    expect(parentLock).toBeGreaterThanOrEqual(0)
    expect(stepLock).toBeGreaterThan(parentLock)
    expect(targetRead).toBeGreaterThan(stepLock)
    expect(steerProbe).toBeGreaterThan(targetRead)
    expect(waitUpdate).toBeGreaterThan(steerProbe)
    expect(JSON.parse(String(fake.state.eventParams?.[6]))).toEqual({ waitId: "wait-1", turnId: "turn-1", status: "interrupted", matchedTaskIds: [] })
    expect(JSON.stringify([fake.state.eventParams, fake.state.eventOutboxParams, fake.state.outboxParams])).not.toContain(fake.state.steer.content)
    await expect(reconcileDurableWaits(fake.pool as never, { now, ownerId: "resolver-1" })).resolves.toEqual({ scanned: 0, resolved: 0, woken: 0 })
    expect(fake.state.waitUpdates).toBe(1)
    expect(fake.state.eventWrites).toBe(1)
    expect(fake.state.eventOutboxWrites).toBe(1)
    expect(fake.state.outboxWrites).toBe(1)
  })

  it.each([
    ["foreign user", { userId: "other-user" }],
    ["foreign session", { sessionId: "other-session" }],
    ["another Turn", { targetTurnId: "turn-2" }],
    ["follow-up delivery", { delivery: "follow_up" }],
    ["unsupported status", { status: "pending" }],
    ["already consumed by a step", { consumedByStepId: "step-1" }],
    ["already consumed", { consumedAt: now }],
    ["cancelled", { cancelledAt: now }],
    ["at the step checkpoint", { acceptedSequence: "9007199254740992" }],
  ] as const)("does not interrupt for %s input", async (_label, steer) => {
    const fake = fixture({ suspended: true, turnStatus: "waiting_for_dependency", targetStatus: "running", steer })
    await expect(reconcileDurableWaits(fake.pool as never, { now })).resolves.toEqual({ scanned: 1, resolved: 0, woken: 0 })
    expect(fake.state.waits[0].status).toBe("waiting")
    expect(fake.state.turns[0].status).toBe("waiting_for_dependency")
    expect(fake.state.targetStatus).toBe("running")
    expect(fake.state.waitUpdates).toBe(0)
    expect(fake.state.turnUpdates).toBe(0)
    expect(fake.state.eventWrites).toBe(0)
    expect(fake.state.outboxWrites).toBe(0)
  })

  it.each([
    { targetStatus: "completed", deadline: new Date("2026-09-09T13:00:00.000Z"), status: "ready" },
    { targetStatus: "running", deadline: new Date("2026-09-09T11:00:00.000Z"), status: "timed_out" },
  ])("keeps an already-ready or timed-out wait ahead of steering", async ({ targetStatus, deadline, status }) => {
    const fake = fixture({ suspended: true, turnStatus: "waiting_for_dependency", targetStatus, deadline })
    await expect(reconcileDurableWaits(fake.pool as never, { now })).resolves.toEqual({ scanned: 1, resolved: 1, woken: 1 })
    expect(fake.state.waits[0].status).toBe(status)
    expect(fake.state.eventParams && JSON.parse(String(fake.state.eventParams[6]))).toMatchObject({ status })
    expect(fake.state.steerProbes).toBe(0)
  })

  it("leaves paused sessions and child-owned waits untouched by a steer", async () => {
    const paused = fixture({ suspended: true, turnStatus: "waiting_for_dependency", sessionStatus: "paused", targetStatus: "running" })
    await expect(reconcileDurableWaits(paused.pool as never, { now })).resolves.toMatchObject({ woken: 0 })
    expect(paused.state.waits[0].status).toBe("waiting")
    expect(paused.state.turns[0].status).toBe("waiting_for_dependency")
    expect(paused.state.waitUpdates).toBe(0)

    const childWait = fixture({ suspended: true, turnStatus: "waiting_for_dependency", waitParentTaskId: "child-1", targetStatus: "running" })
    await expect(reconcileDurableWaits(childWait.pool as never, { now })).resolves.toMatchObject({ woken: 0 })
    expect(childWait.state.waits[0].status).toBe("waiting")
    expect(childWait.state.turnUpdates).toBe(0)

    const activeRoot = fixture({ turnStatus: "in_progress", targetStatus: "running" })
    await expect(reconcileDurableWaits(activeRoot.pool as never, { now })).resolves.toMatchObject({ woken: 0 })
    expect(activeRoot.state.waits[0].status).toBe("waiting")
    expect(activeRoot.state.turns[0].status).toBe("in_progress")
    expect(activeRoot.state.steerProbes).toBe(0)

    const terminalTurn = fixture({ suspended: true, turnStatus: "completed", targetStatus: "running" })
    await expect(reconcileDurableWaits(terminalTurn.pool as never, { now })).resolves.toEqual({ scanned: 0, resolved: 0, woken: 0 })
    expect(terminalTurn.state.waits[0].status).toBe("waiting")
    expect(terminalTurn.state.steerProbes).toBe(0)
  })

  it("observes a steer accepted after an earlier pending scan on the next scan", async () => {
    const fake = fixture({ suspended: true, turnStatus: "waiting_for_dependency", targetStatus: "running", steer: { acceptedSequence: "9007199254740992" } })
    await expect(reconcileDurableWaits(fake.pool as never, { now })).resolves.toEqual({ scanned: 1, resolved: 0, woken: 0 })
    expect(fake.state.waits[0].status).toBe("waiting")
    fake.state.steer.acceptedSequence = "9007199254740993"
    await expect(reconcileDurableWaits(fake.pool as never, { now })).resolves.toEqual({ scanned: 1, resolved: 1, woken: 1 })
    expect(fake.state.waits[0].status).toBe("interrupted")
    expect(fake.state.outboxWrites).toBe(1)
  })

  it("keeps a resolved wait durable while paused and leaves Turn dispatch for explicit resume", async () => {
    const fake = fixture({ suspended: true, turnStatus: "waiting_for_dependency", sessionStatus: "paused" })
    await expect(reconcileDurableWaits(fake.pool as never, { now, ownerId: "resolver-1" })).resolves.toEqual({ scanned: 1, resolved: 1, woken: 0 })
    expect(fake.state.waits[0].status).toBe("ready")
    expect(fake.state.waits[0].consumedAt).toBeNull()
    expect(fake.state.turns[0].status).toBe("waiting_for_dependency")
    expect(fake.state.turnUpdates).toBe(0)
    expect(fake.state.eventWrites).toBe(0)
    expect(fake.state.outboxWrites).toBe(0)
  })

  it("times out a waiting condition without claiming an in-progress lease", async () => {
    const fake = fixture({ deadline: new Date("2026-09-09T11:00:00.000Z") })
    await expect(reconcileDurableWaits(fake.pool as never, { now })).resolves.toMatchObject({ resolved: 1, woken: 0 })
    expect(fake.state.waits[0].status).toBe("timed_out")
    expect(fake.state.turnUpdates).toBe(0)
  })

  it("fails closed for foreign targets and ignores consumed or non-active parents", async () => {
    const foreign = fixture({ targetUser: "other-user" })
    await expect(reconcileDurableWaits(foreign.pool as never, { now })).resolves.toEqual({ scanned: 1, resolved: 0, woken: 0 })
    expect(foreign.state.waitUpdates).toBe(0)
    const consumed = fixture({ consumed: true })
    await expect(reconcileDurableWaits(consumed.pool as never, { now })).resolves.toEqual({ scanned: 0, resolved: 0, woken: 0 })
    const queued = fixture({ turnStatus: "queued" })
    await expect(reconcileDurableWaits(queued.pool as never, { now })).resolves.toEqual({ scanned: 0, resolved: 0, woken: 0 })
  })

  it.each(["aborted", "archived", "missing"])("does not scan or wake a %s session", async sessionStatus => {
    const fake = fixture({ sessionStatus })
    await expect(reconcileDurableWaits(fake.pool as never, { now })).resolves.toEqual({ scanned: 0, resolved: 0, woken: 0 })
    expect(fake.state.waitUpdates).toBe(0)
    expect(fake.state.turnUpdates).toBe(0)
    expect(fake.state.outboxWrites).toBe(0)
  })

  it("rolls back a wake when the session closes between wait and Turn updates", async () => {
    const fake = fixture({ suspended: true, turnStatus: "waiting_for_dependency", closeBeforeWake: true })
    await expect(reconcileDurableWaits(fake.pool as never, { now })).rejects.toThrow("wait_turn_wake_fenced")
    expect(fake.state.eventWrites).toBe(0)
    expect(fake.state.eventOutboxWrites).toBe(0)
    expect(fake.state.outboxWrites).toBe(0)
    expect(fake.calls.some(sql => sql === "ROLLBACK")).toBe(true)
  })

  it("rolls back the Turn wake when the session closes before outbox dispatch", async () => {
    const fake = fixture({ suspended: true, turnStatus: "waiting_for_dependency", closeBeforeOutbox: true })
    await expect(reconcileDurableWaits(fake.pool as never, { now })).rejects.toThrow("wait_session_closed")
    expect(fake.state.outboxWrites).toBe(0)
    expect(fake.calls.some(sql => sql === "ROLLBACK")).toBe(true)
  })

  it.each(["running", "paused", "waiting_for_user"])("keeps %s session resolution compatible", async sessionStatus => {
    const fake = fixture({ sessionStatus })
    await expect(reconcileDurableWaits(fake.pool as never, { now })).resolves.toMatchObject({ scanned: 1, resolved: 1 })
    expect(fake.state.waits[0].status).toBe("ready")
  })

  it.each(["user", "system"])("keeps ordinary %s session resolution compatible", async sessionSource => {
    const fake = fixture({ sessionSource })
    await expect(reconcileDurableWaits(fake.pool as never, { now })).resolves.toMatchObject({ scanned: 1, resolved: 1 })
    expect(fake.state.waits[0].status).toBe("ready")
  })

  it("honors the finite batch and closes an opt-in scanner", async () => {
    const fake = fixture({ turnCount: 2 })
    await expect(reconcileDurableWaits(fake.pool as never, { now, batchSize: 1 })).resolves.toEqual({ scanned: 1, resolved: 1, woken: 0 })
    const empty = fixture({ turnStatus: "queued" })
    const scanner = startDurableWaitResolver(empty.pool as never, { intervalMs: 60_000, batchSize: 1 })
    await scanner.close()
  })
})
