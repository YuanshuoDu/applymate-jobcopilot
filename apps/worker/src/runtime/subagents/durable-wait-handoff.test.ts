import { describe, expect, it } from "vitest"

import { TurnLeaseError, type TurnLease } from "../turns/lease.js"
import { suspendAndReleaseWait } from "./durable-wait-handoff.js"

const lease: TurnLease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 3,
  leaseStartedAt: new Date("2026-09-09T10:00:00.000Z"), leaseExpiresAt: new Date("2026-09-09T10:01:00.000Z"),
}
const now = new Date("2026-09-09T10:00:30.000Z")

function fixture(waitStatus: string, turnStatus = "in_progress", suspendedAt: Date | null = null) {
  const state = {
    wait: { id: "wait-1", userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, parentTaskId: "root-1", stepId: "step-1", status: waitStatus, suspendedAt },
    turn: { id: lease.turnId, userId: lease.userId, sessionId: lease.sessionId, rootTaskId: "root-1", status: turnStatus, leaseOwnerId: turnStatus === "in_progress" ? lease.ownerId : null, leaseVersion: lease.leaseVersion, leaseExpiresAt: turnStatus === "in_progress" ? lease.leaseExpiresAt : null, leaseStartedAt: turnStatus === "in_progress" ? lease.leaseStartedAt : null },
    step: { id: "step-1", taskId: "root-1", attempt: 1, status: "waiting_for_tool" },
    outbox: false,
    published: false,
    outboxWrites: 0,
    conflictResets: 0,
    updates: [] as string[],
  }
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 1 }
      if (sql.includes('FROM "agent_turns"')) return { rows: [state.turn], rowCount: 1 }
      if (sql.includes('FROM "agent_wait_conditions"')) return { rows: [state.wait], rowCount: 1 }
      if (sql.includes('FROM "agent_steps"')) return { rows: [state.step], rowCount: 1 }
      if (sql.includes('FROM "agent_outbox"')) return { rows: state.outbox ? [{ id: "outbox-1" }] : [], rowCount: state.outbox ? 1 : 0 }
      if (sql.includes('UPDATE "agent_wait_conditions"')) {
        state.wait.suspendedAt = params?.[1] as Date
        state.updates.push("wait")
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes("SET \"status\" = 'waiting_for_dependency'")) {
        state.turn.status = "waiting_for_dependency"; state.turn.leaseOwnerId = null; state.turn.leaseExpiresAt = null
        state.updates.push("suspend")
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes("SET \"status\" = 'queued'")) {
        state.turn.status = "queued"; state.turn.leaseOwnerId = null; state.turn.leaseExpiresAt = null
        state.updates.push("queue")
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO "agent_outbox"')) {
        if (state.outbox && state.published && sql.includes('DO UPDATE')) state.conflictResets += 1
        state.outbox = true; state.published = false; state.outboxWrites += 1
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    },
    release() {},
  }
  return { pool: { connect: async () => client }, state }
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
  })

  it("resets a previously published dispatch when the wait becomes ready", async () => {
    const fake = fixture("ready")
    fake.state.outbox = true
    fake.state.published = true
    await suspendAndReleaseWait(fake.pool as never, { lease, waitId: "wait-1", now })
    expect(fake.state.published).toBe(false)
    expect(fake.state.conflictResets).toBe(1)
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
})
