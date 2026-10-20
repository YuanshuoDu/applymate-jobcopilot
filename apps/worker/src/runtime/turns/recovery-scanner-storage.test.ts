import { createHmac } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { hashAgentReceiptValue } from "@jobcopilot/shared"
import { hashApprovalNonce, hashApprovalScope } from "@jobcopilot/agent-protocol"

import type { LeasePool, TurnJobPayload } from "./lease.js"
import { persistTurnDispatch, persistTurnDispatchInTransaction, reclaimExpiredTurns } from "./recovery-scanner-storage.js"

function fakePool(handler: (sql: string, params?: unknown[]) => { rows?: unknown[]; rowCount?: number }) {
  const calls: Array<[string, unknown[]?]> = []
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      return { rows: [], rowCount: 1, ...handler(sql, params) }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as LeasePool, calls, client }
}

const payload: TurnJobPayload = { turnId: "turn-1", sessionId: "session-1", ownerId: "owner-1" }

const recoveryNow = new Date("2026-10-20T12:00:00.000Z")
const gateOwner = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 4,
  turnLeaseOwnerId: "owner-old", turnLeaseVersion: 7, executionId: "execution-1", executionAttemptCount: 2,
}
const recoverySecret = "focused-gate-recovery-test-secret"
let receiptCounter = 0

type GateReceiptOptions = {
  status?: string; projected?: boolean; expiresAt?: Date; signingOwner?: typeof gateOwner
  approvalOverrides?: Record<string, unknown>; itemOverrides?: Record<string, unknown>; contentOverrides?: Record<string, unknown>
}

async function gateReceipt(options: GateReceiptOptions = {}): Promise<Record<string, unknown>> {
  const jobId = `job-${++receiptCounter}`, status = options.status ?? "pending"
  const expiresAt = options.expiresAt ?? new Date("2026-10-20T13:00:00.000Z")
  const resourceHash = await hashAgentReceiptValue("resource", { jobId })
  const materialHash = await hashAgentReceiptValue("material", { jobId, resume: "resume-1" })
  const answersHash = await hashAgentReceiptValue("answers", null)
  const signer = options.signingOwner ?? gateOwner
  const identity = JSON.stringify([1, gateOwner.userId, gateOwner.sessionId, gateOwner.turnId, signer.executionId, signer.executionAttemptCount,
    [signer.rootTaskId, signer.rootAttemptCount, signer.executionId, signer.executionAttemptCount], jobId, "review_application", resourceHash, materialHash, answersHash])
  const derive = (label: string) => createHmac("sha256", recoverySecret).update(`applymate.gate-review-replay.v1:${label}\0${identity}`).digest("hex")
  const approvalId = `gate_review_${derive("approval-id")}`, toolCallId = `application-review:${derive("tool-call-id")}`
  const nonceHash = await hashApprovalNonce(derive("receipt-nonce")), revision = 3
  const scopeHash = await hashApprovalScope({ userId: gateOwner.userId, sessionId: gateOwner.sessionId, turnId: gateOwner.turnId,
    jobId, toolCallId, action: "review_application", resourceHash, materialHash, answersHash, revision, nonceHash, expiresAt: expiresAt.toISOString() })
  const title = "Review application: Example", body = "Review the job and materials.", impact = { externalSubmission: false, jobId }
  const decidedAt = ["approved", "rejected", "consumed"].includes(status) ? new Date("2026-10-20T11:50:00.000Z") : null
  const completed = status !== "pending"
  const row: Record<string, unknown> = {
    ...gateOwner, approvalId, approvalUserId: gateOwner.userId, approvalSessionId: gateOwner.sessionId, approvalTurnId: gateOwner.turnId,
    approvalJobId: jobId, approvalAction: "review_application", approvalStatus: status, approvalToolCallId: toolCallId,
    approvalTitle: title, approvalBody: body, approvalImpact: impact, approvalPayloadJobId: jobId,
    resourceHash, materialHash, answersHash, scopeHash, nonceHash, approvalRevision: revision,
    approvalExpiresAt: expiresAt, approvalExpiresAtUtc: expiresAt.toISOString(), decidedAt,
    consumedAt: status === "consumed" ? decidedAt : null,
  }
  const itemContent: Record<string, unknown> = {
    waitKind: "approval", approvalId, toolCallId, action: "review_application", scopeHash, receiptRevision: revision,
    title, body, impact,
    expiresAt: expiresAt.toISOString(), decision: status === "approved" ? "approved" : status === "rejected" ? "rejected" : null,
    responseAvailable: completed, ...(completed ? { respondedAt: decidedAt?.toISOString() } : {}),
    ...options.contentOverrides,
  }
  const item: Record<string, unknown> = {
    waitItemId: `agent-wait:approval:${approvalId}`, waitSessionId: gateOwner.sessionId, waitTurnId: gateOwner.turnId,
    waitType: "approval_request", waitStatus: completed ? "completed" : "started", waitRevision: completed ? 1 : 0,
    waitStartedAt: new Date("2026-10-20T11:40:00.000Z"), waitContent: itemContent,
    waitCompletedAt: completed ? decidedAt : null,
    ...options.itemOverrides,
  }
  if (options.projected === false) Object.assign(item, {
    waitItemId: null, waitSessionId: null, waitTurnId: null, waitType: null, waitStatus: null,
    waitRevision: null, waitStartedAt: null, waitContent: null, waitCompletedAt: null,
  })
  return { ...row, ...item, ...options.approvalOverrides }
}

function gatePool(rows: Record<string, unknown>[], checkpoint = "gate", nextStage = "gate") {
  return fakePool(sql => {
    if (sql.includes("JOIN LATERAL")) return { rows: checkpoint === "gate" && nextStage === "gate" ? rows : [] }
    if (sql.startsWith('UPDATE "agent_turns"')) return { rows: [{ id: gateOwner.turnId, sessionId: gateOwner.sessionId, leaseVersion: 8 }] }
    return {}
  })
}

describe("recovery scanner persistence helpers", () => {
  it("locks an open session and verifies Turn lineage before persisting a reset dispatch", async () => {
    const fake = fakePool(() => ({ rows: [{ id: "turn-1" }], rowCount: 1 }))
    await persistTurnDispatch(fake.pool, payload, true)

    const sql = fake.calls.map(([text]) => text)
    expect(sql[0]).toBe("BEGIN")
    expect(sql[1]).toContain('session."status" NOT IN (\'aborted\', \'archived\')')
    expect(sql[2]).toContain('session."userId" = turn."userId"')
    expect(sql[3]).toContain('WHERE "agent_outbox"."topic" = EXCLUDED."topic"')
    expect(fake.calls[3]?.[1]).toEqual(expect.arrayContaining(["session-1", "turn-dispatch:turn-1"]))
    expect(sql.at(-1)).toBe("COMMIT")
  })

  it("rejects mismatched lineage before writing a dispatch", async () => {
    const fake = fakePool(() => ({ rows: [], rowCount: 0 }))
    await expect(persistTurnDispatchInTransaction(fake.client as unknown as Pick<pg.PoolClient, "query">, payload)).rejects.toThrow("turn_dispatch_lineage_mismatch")
    expect(fake.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  it("locks the session before checking Turn lineage on an ordinary dispatch", async () => {
    const fake = fakePool(sql => sql.includes('FROM "agent_turns" AS turn')
      ? { rows: [{ id: "turn-1" }], rowCount: 1 }
      : { rows: [{ id: "session-1" }], rowCount: 1 })
    await persistTurnDispatch(fake.pool, payload)

    const sessionLock = fake.calls.findIndex(([sql]) => sql.includes('FROM "agent_sessions" AS session') && sql.includes("FOR UPDATE"))
    const turnLineage = fake.calls.findIndex(([sql]) => sql.includes('FROM "agent_turns" AS turn'))
    expect(sessionLock).toBeGreaterThan(-1)
    expect(sessionLock).toBeLessThan(turnLineage)
    expect(fake.calls[sessionLock]?.[0]).not.toContain("status")
  })

  it("keeps a non-runnable reset session as a quiet skip", async () => {
    const fake = fakePool(sql => sql.includes('FROM "agent_sessions" AS session')
      ? { rows: [], rowCount: 0 }
      : { rows: [{ id: "turn-1" }], rowCount: 1 })

    await expect(persistTurnDispatch(fake.pool, payload, true)).resolves.toBeUndefined()
    expect(fake.calls.some(([sql]) => sql.includes('FROM "agent_sessions" AS session'))).toBe(true)
    expect(fake.calls.some(([sql]) => sql.includes('FROM "agent_turns" AS turn'))).toBe(false)
    expect(fake.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
    expect(fake.calls.at(-1)?.[0]).toBe("COMMIT")
  })

  it("maps reclaimed leases to their prior fencing version", async () => {
    const fake = fakePool(sql => sql.includes("WITH stale")
      ? { rows: [{ id: "turn-1", sessionId: "session-1", leaseVersion: 8 }], rowCount: 1 }
      : {})
    await expect(reclaimExpiredTurns(fake.pool, new Date("2026-09-23T12:00:00Z"), 10)).resolves.toEqual([
      { turnId: "turn-1", sessionId: "session-1", previousLeaseVersion: 7 },
    ])
    const stale = fake.calls.find(([sql]) => sql.includes("WITH stale"))?.[0] ?? ""
    expect(stale).toContain("SKIP LOCKED")
    expect(stale).toContain('(turn."source" <> \'automation\' OR turn."executionMode" = \'canonical_task_graph\')')
    expect(fake.calls.some(([sql]) => sql.includes('WHERE turn."id" = stale."id"'))).toBe(true)
  })

  it("leaves unresolved and legacy automation Turns to their AgentRun retry", async () => {
    const fake = fakePool(sql => sql.includes("WITH stale") ? { rows: [], rowCount: 0 } : {})

    await expect(reclaimExpiredTurns(fake.pool, new Date("2026-09-23T12:00:00Z"), 10)).resolves.toEqual([])

    const stale = fake.calls.find(([sql]) => sql.includes("WITH stale"))?.[0] ?? ""
    expect(stale).toContain('turn."executionMode" = \'canonical_task_graph\'')
  })

  describe("stale scheduled Gate recovery", () => {
    const previousSecret = process.env.AGENT_WORKER_SECRET
    beforeEach(() => { process.env.AGENT_WORKER_SECRET = recoverySecret; receiptCounter = 0 })
    afterEach(() => {
      if (previousSecret === undefined) delete process.env.AGENT_WORKER_SECRET
      else process.env.AGENT_WORKER_SECRET = previousSecret
    })

    it("requeues the same Turn for an exact pending receipt and allows other untouched pending receipts", async () => {
      const fake = gatePool([await gateReceipt(), await gateReceipt({ projected: false })])
      await expect(reclaimExpiredTurns(fake.pool, recoveryNow, 5)).resolves.toEqual([
        { turnId: gateOwner.turnId, sessionId: gateOwner.sessionId, previousLeaseVersion: gateOwner.turnLeaseVersion },
      ])
      const gateSql = fake.calls.find(([sql]) => sql.includes("JOIN LATERAL"))?.[0] ?? ""
      expect(gateSql).toContain('execution."checkpoint" = \'gate\'')
      expect(gateSql).toContain('execution."state"->>\'nextStage\' = \'gate\'')
      expect(gateSql).toContain('LEFT JOIN "agent_approvals" AS approval ON approval."turnId" = stale."turnId"')
      expect(gateSql).toContain('LEFT JOIN "agent_items" AS item ON item."id" = \'agent-wait:approval:\' || approval."id"')
      expect(gateSql).not.toContain('approval."status" IN')
      expect(gateSql).not.toContain('approval."type" =')
      expect(gateSql).not.toContain('item."sessionId" =')
      const update = fake.calls.find(([sql]) => sql.startsWith('UPDATE "agent_turns"'))
      expect(update?.[0]).toContain('"status" = \'queued\'')
      expect(update?.[0]).toContain('"leaseOwnerId" = NULL')
      expect(update?.[0]).toContain('"leaseExpiresAt" = NULL')
      expect(update?.[0]).toContain('"leaseVersion" = "leaseVersion" + 1')
      expect(update?.[0]).toContain('"revision" = "revision" + 1')
      expect(update?.[1]).toEqual([gateOwner.turnId, gateOwner.turnLeaseOwnerId, gateOwner.turnLeaseVersion, recoveryNow])
      expect(fake.calls.filter(([sql]) => sql.startsWith("UPDATE ")).map(([sql]) => sql)).toEqual([update?.[0]])
    })

    it("replays an approved receipt only with its explicit approved canonical wait decision", async () => {
      const fake = gatePool([await gateReceipt({ status: "approved" })])
      await expect(reclaimExpiredTurns(fake.pool, recoveryNow, 5)).resolves.toHaveLength(1)
    })

    for (const [name, approvalOverrides] of [
      ["approvalId", { approvalId: "tampered-approval-id" }],
      ["toolCallId", { approvalToolCallId: "tampered-tool-call-id" }],
    ] as const) {
      it(`rejects a receipt when only ${name} is altered`, async () => {
        const fake = gatePool([await gateReceipt(), await gateReceipt({ approvalOverrides })])
        await expect(reclaimExpiredTurns(fake.pool, recoveryNow, 5)).resolves.toEqual([])
        expect(fake.calls.some(([sql]) => sql.startsWith('UPDATE "agent_turns"'))).toBe(false)
      })
    }

    for (const [name, makeInvalid] of [
      ["rejected current receipt", () => gateReceipt({ status: "rejected" })],
      ["expired current receipt", () => gateReceipt({ expiresAt: new Date("2026-10-20T11:59:59.999Z") })],
      ["consumed current receipt", () => gateReceipt({ status: "consumed" })],
      ["approval subject mismatch", () => gateReceipt({ approvalOverrides: { approvalUserId: "other-user" } })],
      ["approval payload job mismatch", () => gateReceipt({ approvalOverrides: { approvalPayloadJobId: "other-job" } })],
      ["receipt scope mismatch", () => gateReceipt({ approvalOverrides: { scopeHash: "f".repeat(64) } })],
      ["wait title mismatch", () => gateReceipt({ contentOverrides: { title: "Other title" } })],
      ["wait body mismatch", () => gateReceipt({ contentOverrides: { body: "Other body" } })],
      ["wait impact mismatch", () => gateReceipt({ contentOverrides: { impact: { externalSubmission: true } } })],
      ["wait item binding mismatch", () => gateReceipt({ contentOverrides: { toolCallId: "other-tool-call" } })],
    ] as const) {
      it(`rejects a valid receipt set when it also contains a ${name}`, async () => {
        const fake = gatePool([await gateReceipt(), await makeInvalid()])
        await expect(reclaimExpiredTurns(fake.pool, recoveryNow, 5)).resolves.toEqual([])
        expect(fake.calls.some(([sql]) => sql.startsWith('UPDATE "agent_turns"'))).toBe(false)
      })
    }

    it("requires at least one projected canonical wait item", async () => {
      const fake = gatePool([await gateReceipt({ projected: false })])
      await expect(reclaimExpiredTurns(fake.pool, recoveryNow, 5)).resolves.toEqual([])
      expect(fake.calls.some(([sql]) => sql.startsWith('UPDATE "agent_turns"'))).toBe(false)
    })

    it("ignores a rejected receipt only when its HMAC is for a prior root attempt", async () => {
      const prior = { ...gateOwner, rootAttemptCount: gateOwner.rootAttemptCount - 1 }
      const fake = gatePool([await gateReceipt(), await gateReceipt({ status: "rejected", signingOwner: prior })])
      await expect(reclaimExpiredTurns(fake.pool, recoveryNow, 5)).resolves.toHaveLength(1)
    })

    it("does not authorize recovery with a receipt HMACed for another execution attempt", async () => {
      const prior = { ...gateOwner, executionAttemptCount: gateOwner.executionAttemptCount - 1 }
      const fake = gatePool([await gateReceipt({ signingOwner: prior })])
      await expect(reclaimExpiredTurns(fake.pool, recoveryNow, 5)).resolves.toEqual([])
    })

    it("does not treat an ordinary approval at a later checkpoint as a stale Gate", async () => {
      const fake = gatePool([await gateReceipt()], "execute", "execute")
      await expect(reclaimExpiredTurns(fake.pool, recoveryNow, 5)).resolves.toEqual([])
      const gateSql = fake.calls.find(([sql]) => sql.includes("JOIN LATERAL"))?.[0] ?? ""
      expect(gateSql).toContain('execution."checkpoint" = \'gate\'')
      expect(gateSql).toContain('execution."state"->>\'nextStage\' = \'gate\'')
      expect(fake.calls.some(([sql]) => sql.startsWith('UPDATE "agent_turns"'))).toBe(false)
    })
  })
})
