import { describe, expect, it, vi } from "vitest"

import { reconcileDurableWaits, startDurableWaitResolver } from "./durable-wait-resolver.js"

const now = new Date("2026-09-09T12:00:00.000Z")

function fixture(input: { turnStatus?: string; waitStatus?: string; suspended?: boolean; deadline?: Date; targetStatus?: string; targetUser?: string; consumed?: boolean; turnCount?: number }) {
  const turn = { id: "turn-1", userId: "user-1", sessionId: "session-1", rootTaskId: "root-1", status: input.turnStatus ?? "in_progress", leaseOwnerId: null }
  const wait = { id: "wait-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "root-1", stepId: "step-1", targetTaskIds: ["child-1"], mode: "any", status: input.waitStatus ?? "waiting", deadlineAt: input.deadline ?? new Date("2026-09-09T13:00:00.000Z"), suspendedAt: input.suspended ? now : null, consumedAt: input.consumed ? now : null, matchedTaskIds: [] }
  const secondTurn = { ...turn, id: "turn-2", rootTaskId: "root-2", sessionId: "session-2", userId: "user-2" }
  const secondWait = { ...wait, id: "wait-2", turnId: "turn-2", parentTaskId: "root-2", stepId: "step-2", userId: "user-2", sessionId: "session-2", targetTaskIds: ["child-2"] }
  const turns = input.turnCount === 2 ? [turn, secondTurn] : [turn]
  const waits = input.turnCount === 2 ? [wait, secondWait] : [wait]
  const state = { turns, waits, targetUser: input.targetUser ?? "user-1", targetStatus: input.targetStatus ?? "completed", waitUpdates: 0, turnUpdates: 0, outboxWrites: 0, outboxPublished: false, conflictResets: 0 }
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 1 }
      if (sql.includes('FROM "agent_turns"')) return { rows: state.turns.filter(candidate => candidate.status === "in_progress" || candidate.status === "waiting_for_dependency"), rowCount: state.turns.length }
      if (sql.includes('FROM "agent_wait_conditions"')) {
        const turnId = String(params?.[2]); const limit = Number(params?.[3])
        return { rows: state.waits.filter(candidate => candidate.turnId === turnId && !candidate.consumedAt && ["waiting", "ready", "timed_out"].includes(candidate.status)).slice(0, limit), rowCount: 1 }
      }
      if (sql.includes('FROM "sub_agent_tasks"') && sql.includes('ANY($1::text[])')) {
        const turnId = String(params?.[2]); const userId = String(params?.[3]); const id = turnId === "turn-2" ? "child-2" : "child-1"
        return { rows: state.targetUser === userId ? [{ id, rootTaskId: turnId === "turn-2" ? "root-2" : "root-1", turnId, sessionId: String(params?.[1]), userId, status: state.targetStatus }] : [], rowCount: 1 }
      }
      if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [{ id: String(params?.[0]), rootTaskId: String(params?.[0]), turnId: String(params?.[2]), sessionId: String(params?.[1]), userId: String(params?.[3]) }], rowCount: 1 }
      if (sql.includes('FROM "agent_steps"')) return { rows: [{ id: "step-1", taskId: "root-1", attempt: 1, status: "waiting_for_tool" }], rowCount: 1 }
      if (sql.includes('UPDATE "agent_wait_conditions"')) {
        const found = state.waits.find(candidate => candidate.id === String(params?.[3]))
        if (found) { found.status = String(params?.[0]); found.matchedTaskIds = JSON.parse(String(params?.[1])); state.waitUpdates += 1 }
        return { rows: [], rowCount: found ? 1 : 0 }
      }
      if (sql.includes('UPDATE "agent_turns"')) {
        const found = state.turns.find(candidate => candidate.id === String(params?.[0]))
        if (found) { found.status = "queued"; state.turnUpdates += 1 }
        return { rows: [], rowCount: found ? 1 : 0 }
      }
      if (sql.includes('INSERT INTO "agent_outbox"')) { if (state.outboxPublished && sql.includes("DO UPDATE")) state.conflictResets += 1; state.outboxWrites += 1; state.outboxPublished = false; return { rows: [], rowCount: 1 } }
      return { rows: [], rowCount: 1 }
    },
    release() {},
  }
  return { pool: { connect: async () => client }, state }
}

describe("durable wait resolver", () => {
  it("marks an early terminal match ready without waking an unsuspended parent", async () => {
    const fake = fixture({})
    await expect(reconcileDurableWaits(fake.pool as never, { now })).resolves.toEqual({ scanned: 1, resolved: 1, woken: 0 })
    expect(fake.state.waits[0].status).toBe("ready")
    expect(fake.state.turns[0].status).toBe("in_progress")
    expect(fake.state.outboxWrites).toBe(0)
  })

  it("wakes a suspended parent and creates one dispatch outbox row", async () => {
    const fake = fixture({ suspended: true, turnStatus: "waiting_for_dependency" })
    fake.state.outboxPublished = true
    await expect(reconcileDurableWaits(fake.pool as never, { now, ownerId: "resolver-1" })).resolves.toEqual({ scanned: 1, resolved: 1, woken: 1 })
    expect(fake.state.turns[0].status).toBe("queued")
    expect(fake.state.outboxWrites).toBe(1)
    expect(fake.state.conflictResets).toBe(1)
    await expect(reconcileDurableWaits(fake.pool as never, { now, ownerId: "resolver-1" })).resolves.toEqual({ scanned: 0, resolved: 0, woken: 0 })
    expect(fake.state.outboxWrites).toBe(1)
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

  it("honors the finite batch and closes an opt-in scanner", async () => {
    const fake = fixture({ turnCount: 2 })
    await expect(reconcileDurableWaits(fake.pool as never, { now, batchSize: 1 })).resolves.toEqual({ scanned: 1, resolved: 1, woken: 0 })
    const empty = fixture({ turnStatus: "queued" })
    const scanner = startDurableWaitResolver(empty.pool as never, { intervalMs: 60_000, batchSize: 1 })
    await scanner.close()
  })
})
