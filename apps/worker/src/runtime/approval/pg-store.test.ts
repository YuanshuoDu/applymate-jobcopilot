import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { hashApprovalNonce, hashApprovalScope } from "@jobcopilot/agent-protocol"

import { createPgApprovalStore } from "./pg-store.js"
import { protocolScope, type ApprovalScopeInput } from "./types.js"

const TEST_NOW_MS = Date.parse("2026-09-01T00:00:00.000Z")
const timeAt = (minutes: number): Date => new Date(TEST_NOW_MS + minutes * 60_000)

const scope: ApprovalScopeInput = {
  userId: "user_1", sessionId: "session_1", turnId: "turn_1", jobId: "job_1", toolCallId: "call_1", action: "submit_application",
  resourceHash: "a".repeat(64), materialHash: "b".repeat(64), answersHash: "c".repeat(64), revision: 1,
  expiresAt: timeAt(60),
}

async function makeRow(): Promise<Record<string, unknown>> {
  const nonceHash = await hashApprovalNonce("nonce_1")
  const scopeHash = await hashApprovalScope(protocolScope(scope, nonceHash))
  return {
    id: "approval_1", sessionId: scope.sessionId, taskId: "task_1", userId: scope.userId, turnId: scope.turnId, toolCallId: scope.toolCallId,
    jobId: scope.jobId, type: scope.action, status: "approved", title: "Submit", body: "Review", payload: { jobId: scope.jobId },
    resourceHash: scope.resourceHash, materialHash: scope.materialHash, answersHash: scope.answersHash, scopeHash, nonceHash,
    revision: scope.revision, expiresAt: scope.expiresAt, decidedAt: new Date(), consumedAt: null, createdAt: new Date(),
  }
}

function fakePool(row: Record<string, unknown>, sessionStatus = "running", sessionSource = "automation", rejectLockedSession = false, revisionType: "goal.revision" | null = null, requestEventPresent = true) {
  const calls: string[] = []
  const client = {
    query: vi.fn(async (text: string, _params?: unknown[]) => {
      calls.push(text)
      if (text.includes('FROM "agent_sessions"') && (["aborted", "archived"].includes(sessionStatus) || rejectLockedSession && text.includes("FOR UPDATE"))) return { rows: [], rowCount: 0 }
      if (text.includes('FROM "agent_events"') && text.includes("approval.requested")) return { rows: [{ hasRequest: requestEventPresent, hasGoalRevision: revisionType !== null }], rowCount: 1 }
      if (text.includes('SELECT "id", "sessionId"')) return { rows: [row], rowCount: 1 }
      if (text.includes('FROM "agent_sessions"')) return { rows: [{ id: scope.sessionId, status: sessionStatus, source: sessionSource }], rowCount: 1 }
      if (text.includes('SELECT "id", "status", "revision" FROM "agent_turns"')) return { rows: [{ id: scope.turnId, status: "in_progress", revision: scope.revision }], rowCount: 1 }
      if (text.includes('SELECT "id" FROM "agent_turns"')) return { rows: [{ id: scope.turnId }], rowCount: 1 }
      if (text.includes('SELECT "id" FROM "Job"')) return { rows: [{ id: scope.jobId }], rowCount: 1 }
      if (text.includes('INSERT INTO "agent_approvals"')) return { rows: [row], rowCount: 1 }
      if (text.includes('UPDATE "agent_sessions"')) return { rows: [{ eventSequence: "10" }], rowCount: 1 }
      if (text.includes('UPDATE "agent_approvals"')) return { rows: [], rowCount: 1 }
      if (text.includes('INSERT INTO "agent_action_reservations"')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool
  return { pool, client, calls }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(timeAt(0))
})

afterEach(() => {
  vi.useRealTimers()
})

describe("Worker PG approval store", () => {
  it("uses the tenant transaction and persists a scoped receipt", async () => {
    const row = await makeRow()
    const { pool, client, calls } = fakePool(row)
    const store = createPgApprovalStore(pool, { userId: scope.userId })
    const result = await store.issue({ approvalId: row.id as string, scope, title: "Submit", body: "Review", payload: { jobId: scope.jobId, sensitiveAnswer: "secret-answer" }, nonce: "nonce_1" })

    expect(result.nonce).toBe("nonce_1")
    expect(pool.connect).toHaveBeenCalledOnce()
    expect(calls[0]).toBe("BEGIN")
    expect(calls).toContain("COMMIT")
    expect((client.query.mock.calls as Array<[string, unknown[]?]>).some(([, params]) => Array.isArray(params) && params.includes("approval.requested"))).toBe(true)
    const auditCalls = (client.query.mock.calls as Array<[string, unknown[]?]>).filter(([text]) => text.includes('INSERT INTO "agent_events"') || text.includes('INSERT INTO "agent_outbox"'))
    expect(JSON.stringify(auditCalls)).not.toContain("secret-answer")
  })

  it.each(["running", "paused", "waiting_for_user"] as const)("keeps approval reads compatible with a %s session", async sessionStatus => {
    const row = await makeRow()
    const { pool } = fakePool(row, sessionStatus)
    const store = createPgApprovalStore(pool, { userId: scope.userId })
    await expect(store.validate(row.id as string, { ...scope, nonce: "nonce_1" })).resolves.toMatchObject({ id: row.id, status: "approved" })
  })

  it.each(["user", "system"] as const)("keeps approval reads compatible with an ordinary %s session", async sessionSource => {
    const row = await makeRow()
    const { pool } = fakePool(row, "running", sessionSource)
    const store = createPgApprovalStore(pool, { userId: scope.userId })
    await expect(store.validate(row.id as string, { ...scope, nonce: "nonce_1" })).resolves.toMatchObject({ id: row.id, status: "approved" })
  })

  it.each(["aborted", "archived"] as const)("fails closed for every approval action in a %s session", async sessionStatus => {
    const row = await makeRow()
    const { pool, client } = fakePool(row, sessionStatus)
    const store = createPgApprovalStore(pool, { userId: scope.userId })
    const submission = { userId: scope.userId, jobId: scope.jobId, scopeHash: row.scopeHash as string }

    await expect(store.issue({ scope, title: "Submit", body: "Review", payload: {}, nonce: "nonce_1" })).rejects.toMatchObject({ code: "approval_scope_mismatch" })
    await expect(store.validate(row.id as string, { ...scope, nonce: "nonce_1" })).rejects.toMatchObject({ code: "approval_not_found" })
    await expect(store.inspectSubmission(row.id as string, submission)).rejects.toMatchObject({ code: "approval_not_found" })
    await expect(store.resolve({ id: row.id as string, sessionId: scope.sessionId, decision: "approved" })).rejects.toMatchObject({ code: "approval_not_found" })
    await expect(store.consumeSubmission(row.id as string, submission)).rejects.toMatchObject({ code: "approval_not_found" })
    await expect(store.consume(row.id as string, { ...scope, nonce: "nonce_1" })).rejects.toMatchObject({ code: "approval_not_found" })
    await expect(store.consumeAndReserve(row.id as string, { ...scope, nonce: "nonce_1" }, { idempotencyKey: "submit:task_1" })).rejects.toMatchObject({ code: "approval_not_found" })

    const calls = (client.query.mock.calls as Array<[string, unknown[]?]>).map(([text]) => text)
    expect(calls.some(text => text.includes('session."status" NOT IN (\'aborted\', \'archived\')'))).toBe(true)
    expect(calls.some(text => text.includes('INSERT INTO "agent_approvals"'))).toBe(false)
    expect(calls.some(text => text.includes('INSERT INTO "agent_action_reservations"'))).toBe(false)
    expect(calls.some(text => text.includes('INSERT INTO "agent_events"') || text.includes('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  it("rolls back issue when projectApprovalWait loses the open-session fence", async () => {
    const row = await makeRow()
    const { pool, client } = fakePool(row, "running", "automation", true)
    const store = createPgApprovalStore(pool, { userId: scope.userId })
    await expect(store.issue({ scope, title: "Submit", body: "Review", payload: {}, nonce: "nonce_1" })).rejects.toMatchObject({ code: "approval_scope_mismatch" })
    const calls = (client.query.mock.calls as Array<[string, unknown[]?]>).map(([text]) => text)
    expect(calls).toContain("ROLLBACK")
    expect(calls).not.toContain("COMMIT")
    expect(calls.some(text => text.includes('INSERT INTO "agent_items"') || text.includes('INSERT INTO "agent_events"') || text.includes('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  it("rejects a mismatched tool before the consume update", async () => {
    const row = await makeRow()
    const { pool, client } = fakePool(row)
    const store = createPgApprovalStore(pool, { userId: scope.userId })
    await expect(store.consume(row.id as string, { ...scope, toolCallId: "call_2", nonce: "nonce_1" })).rejects.toMatchObject({ code: "approval_scope_mismatch" })
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining("SET \"status\" = 'consumed'"), expect.any(Array))
  })

  it("rejects stale revisions and expired receipts", async () => {
    const row = await makeRow()
    const { pool } = fakePool(row)
    const store = createPgApprovalStore(pool, { userId: scope.userId })
    await expect(store.validate(row.id as string, { ...scope, revision: 2, nonce: "nonce_1" }, timeAt(1))).rejects.toMatchObject({ code: "approval_revision_mismatch" })
    await expect(store.validate(row.id as string, { ...scope, nonce: "nonce_1" }, timeAt(60))).rejects.toMatchObject({ code: "approval_expired" })
  })

  it("rejects an actionable approval after a goal revision event", async () => {
    const row = await makeRow()
    const { pool, client } = fakePool(row, "running", "automation", false, "goal.revision")
    const store = createPgApprovalStore(pool, { userId: scope.userId })
    const expected = { ...scope, nonce: "nonce_1" }
    const submission = { userId: scope.userId, jobId: scope.jobId, scopeHash: row.scopeHash as string }

    await expect(store.validate(row.id as string, expected)).rejects.toMatchObject({ code: "approval_revision_mismatch" })
    await expect(store.inspectSubmission(row.id as string, submission)).rejects.toMatchObject({ code: "approval_revision_mismatch" })
    await expect(store.consumeAndReserve(row.id as string, expected, { idempotencyKey: "submit:task_1" })).rejects.toMatchObject({ code: "approval_revision_mismatch" })
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE "agent_approvals"'), expect.any(Array))
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO "agent_action_reservations"'), expect.any(Array))
  })

  it("fails closed when the durable approval request event is missing", async () => {
    const row = await makeRow()
    const { pool, client } = fakePool(row, "running", "automation", false, null, false)
    const store = createPgApprovalStore(pool, { userId: scope.userId })

    await expect(store.validate(row.id as string, { ...scope, nonce: "nonce_1" })).rejects.toMatchObject({ code: "approval_integrity_error" })
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE "agent_approvals"'), expect.any(Array))
  })

  it("rejects resolving a pending approval after a goal revision", async () => {
    const row = await makeRow()
    row.status = "pending"
    row.decidedAt = null
    const { pool, client } = fakePool(row, "running", "automation", false, "goal.revision")
    const store = createPgApprovalStore(pool, { userId: scope.userId })

    await expect(store.resolve({ id: row.id as string, sessionId: scope.sessionId, decision: "approved" })).rejects.toMatchObject({ code: "approval_revision_mismatch" })
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE "agent_approvals"'), expect.any(Array))
  })

  it("keeps consumed submission receipts replayable after a later goal revision", async () => {
    const row = await makeRow()
    row.status = "consumed"
    row.consumedAt = timeAt(1)
    const { pool } = fakePool(row, "running", "automation", false, "goal.revision")
    const store = createPgApprovalStore(pool, { userId: scope.userId })
    const submission = { userId: scope.userId, jobId: scope.jobId, scopeHash: row.scopeHash as string }

    await expect(store.inspectSubmission(row.id as string, submission)).resolves.toMatchObject({ id: row.id, status: "consumed" })
    await expect(store.consumeSubmission(row.id as string, submission)).rejects.toMatchObject({ code: "approval_already_consumed" })
  })

  it("consumes and reserves the external action in the same transaction", async () => {
    const row = await makeRow()
    const { pool, client, calls } = fakePool(row)
    const store = createPgApprovalStore(pool, { userId: scope.userId })
    const result = await store.consumeAndReserve(row.id as string, { ...scope, nonce: "nonce_1" }, { idempotencyKey: "submit:task_1" }, timeAt(1))

    expect(result.reservationId).toEqual(expect.any(String))
    expect(calls).toContain("COMMIT")
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO \"agent_action_reservations\""), expect.any(Array))
    expect(calls.filter((call) => call.includes("INSERT INTO \"agent_events\"")).length).toBe(2)
  })

  it("supports the locked submit input without exposing the approval nonce", async () => {
    const row = await makeRow()
    const { pool } = fakePool(row)
    const store = createPgApprovalStore(pool, { userId: scope.userId })
    const expected = { userId: scope.userId, jobId: scope.jobId, scopeHash: row.scopeHash as string }

    await expect(store.inspectSubmission(row.id as string, expected, timeAt(1))).resolves.toMatchObject({ id: row.id, status: "approved", scope: { jobId: scope.jobId, resourceHash: scope.resourceHash } })
    await expect(store.consumeSubmission(row.id as string, expected, timeAt(1))).resolves.toMatchObject({ id: row.id, status: "consumed" })
  })
})
