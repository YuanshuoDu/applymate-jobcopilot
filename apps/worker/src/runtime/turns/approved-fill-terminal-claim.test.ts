import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LeasePool, TurnJobPayload } from "./lease.js"
import type { CanonicalApprovedApplicationSubmitResumeProof } from "../canonical-approved-application-submit-resume-proof.js"

const { readProof } = vi.hoisted(() => ({ readProof: vi.fn() }))
vi.mock("../canonical-approved-application-submit-resume-proof.js", () => ({ readCanonicalApprovedApplicationSubmitResumeProof: readProof }))

import {
  approvedFillTerminalClaimRequeue, claimApprovedFillTerminalLease, getApprovedFillTerminalClaim,
  isApprovedFillTerminalClaimRequeue,
} from "./approved-fill-terminal-claim.js"

const payload: TurnJobPayload = { turnId: "turn-1", sessionId: "session-1", ownerId: "wakeup:event-1" }
const proof = { userId: "user-1", sessionId: payload.sessionId, turnId: payload.turnId, rootTaskId: "root-1",
  applicationTaskId: "application-1", approvalId: "approval-1", waitItemId: "agent-wait:approval:application-1:turn-1",
  state: "form_filled", workerTaskId: null, outboxId: null } as CanonicalApprovedApplicationSubmitResumeProof
const wakePayload = { answerAvailable: false, itemId: proof.waitItemId, nextTurnRevision: 5, status: "approved",
  toolCallId: "tool-1", turnId: payload.turnId, waitId: proof.approvalId, waitKind: "approval" }

describe("approved Fill terminal claim", () => {
  beforeEach(() => readProof.mockReset().mockResolvedValue(proof))

  it("claims only the exact queued, approved wake replay before or after publisher acknowledgement", async () => {
    for (const dispatch of [dispatchRow(null, 0), dispatchRow(new Date("2026-11-22T10:00:01Z"), 1)]) {
      const pool = fixture(dispatch)
      const lease = await claimApprovedFillTerminalLease({ pool: pool.pool, payload, now: new Date("2026-11-22T10:00:00Z"), leaseMs: 60_000, dispatchGeneration: 0 })
      expect(lease).toMatchObject({ turnId: payload.turnId, sessionId: payload.sessionId, userId: "user-1", ownerId: payload.ownerId, leaseVersion: 4 })
      expect(getApprovedFillTerminalClaim(lease!)).toEqual(proof)
      expect(pool.client.query).toHaveBeenCalledWith("COMMIT")
      const sql = pool.client.query.mock.calls.map(([statement]) => statement)
      const sessionLock = sql.findIndex(statement => statement.includes('SELECT session."userId"'))
      const turnClaim = sql.findIndex(statement => statement.includes('UPDATE "agent_turns"'))
      expect(sessionLock).toBeGreaterThan(-1)
      expect(turnClaim).toBeGreaterThan(sessionLock)
      expect(sql[turnClaim]).toContain('session."status" = \'waiting_for_user\'')
      expect(sql[turnClaim]).toContain('"type" = \'session.pause_requested\'')
    }
  })

  it("rejects a durable dispatch payload whose owner was changed by another generation", async () => {
    const changed = dispatchRow(null, 0)
    changed.payload = { ownerId: "other-owner", sessionId: payload.sessionId, turnId: payload.turnId }
    const pool = fixture(changed)
    expect(await claimApprovedFillTerminalLease({ pool: pool.pool, payload, now: new Date("2026-11-22T10:00:00Z"), leaseMs: 60_000, dispatchGeneration: 0 })).toBeNull()
    expect(getApprovedFillTerminalClaim({} as never)).toBeUndefined()
    expect(pool.client.query).toHaveBeenCalledWith("ROLLBACK")
    expect(pool.client.query).not.toHaveBeenCalledWith("COMMIT")
  })

  it("rejects stale generations and any initial proof beyond form_filled", async () => {
    const staleGeneration = fixture(dispatchRow(null, 2))
    expect(await claimApprovedFillTerminalLease({ pool: staleGeneration.pool, payload, now: new Date("2026-11-22T10:00:00Z"), leaseMs: 60_000, dispatchGeneration: 0 })).toBeNull()
    readProof.mockResolvedValueOnce({ ...proof, state: "submission_authorized", workerTaskId: "worker-1", outboxId: "outbox-1" })
    const authorized = fixture(dispatchRow(null, 0))
    expect(await claimApprovedFillTerminalLease({ pool: authorized.pool, payload, now: new Date("2026-11-22T10:00:00Z"), leaseMs: 60_000, dispatchGeneration: 0 })).toBeNull()
  })

  it("brands proof-drift requeue to the exact claimed lease object", async () => {
    const pool = fixture(dispatchRow(null, 0))
    const lease = await claimApprovedFillTerminalLease({ pool: pool.pool, payload, now: new Date("2026-11-22T10:00:00Z"), leaseMs: 60_000, dispatchGeneration: 0 })
    const error = approvedFillTerminalClaimRequeue(lease!)
    expect(isApprovedFillTerminalClaimRequeue(error, lease!)).toBe(true)
    expect(isApprovedFillTerminalClaimRequeue(error, { ...lease! })).toBe(false)
    expect(() => approvedFillTerminalClaimRequeue({ ...lease! })).toThrow("approved_fill_terminal_claim_marker_missing")
  })
})

function dispatchRow(publishedAt: Date | null, attemptCount: number) {
  return { topic: "agent.turn.dispatch", aggregateId: payload.sessionId, idempotencyKey: `turn-dispatch:${payload.turnId}`,
    payload: { ownerId: payload.ownerId, sessionId: payload.sessionId, turnId: payload.turnId }, publishedAt, attemptCount }
}

function fixture(dispatch: ReturnType<typeof dispatchRow>) {
  const wake = { id: "event-wakeup-1", sessionId: payload.sessionId, turnId: payload.turnId, itemId: proof.waitItemId,
    taskId: null, sequence: "11", type: "turn.wakeup", actor: "user", correlationId: payload.turnId,
    causationId: "event-resolved-1", idempotencyKey: "agent-wait-command:command-1:wakeup", payload: wakePayload }
  const resolved = { ...wake, id: "event-resolved-1", sequence: "10", type: "approval.resolved",
    taskId: proof.applicationTaskId, correlationId: proof.approvalId, causationId: proof.waitItemId,
    idempotencyKey: "agent-wait-command:command-1" }
  const resumed = { ...wake, id: "event-resumed-1", sequence: "12", type: "turn.resumed", actor: "system",
    taskId: null, correlationId: payload.turnId, causationId: wake.id, idempotencyKey: `agent-wakeup:${wake.id}:resumed`,
    payload: { itemId: proof.waitItemId, resumedFromEventId: wake.id, status: "approved", toolCallId: "tool-1",
      turnId: payload.turnId, waitId: proof.approvalId, waitKind: "approval" } }
  const client = { query: vi.fn(async (sql: string) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: null }
    if (sql.includes("SELECT set_config")) return { rows: [], rowCount: 1 }
    if (sql.includes('SELECT session."userId"')) return { rows: [{ userId: "user-1" }], rowCount: 1 }
    if (sql.includes('UPDATE "agent_turns"')) return { rows: [{ id: payload.turnId, sessionId: payload.sessionId, userId: "user-1",
      rootTaskId: proof.rootTaskId, leaseOwnerId: payload.ownerId, leaseVersion: 4, leaseStartedAt: new Date("2026-11-22T10:00:00Z"),
      leaseExpiresAt: new Date("2026-11-22T10:01:00Z") }], rowCount: 1 }
    if (sql.includes("'turn.wakeup'")) return { rows: [wake], rowCount: 1 }
    if (sql.includes('FROM "agent_approvals"')) return { rows: [{ toolCallId: "tool-1" }], rowCount: 1 }
    if (sql.includes("'approval.resolved'")) return { rows: [resolved], rowCount: 1 }
    if (sql.includes("'turn.resumed'")) return { rows: [resumed], rowCount: 1 }
    if (sql.includes("'agent.turn.dispatch'")) return { rows: [dispatch], rowCount: 1 }
    throw new Error(`Unexpected claim query: ${sql}`)
  }), release: vi.fn() }
  const pool = { connect: vi.fn(async () => client) } as unknown as LeasePool
  return { pool, client }
}
