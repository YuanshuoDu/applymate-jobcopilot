import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type pg from "pg"
import type { ObjectiveApplicationApprovalSetIssueInput } from "./objective-application-approval-set-store.js"
import { createPgObjectiveApplicationApprovalSetStore } from "./objective-application-approval-set-store.js"

const now = new Date("2026-11-24T10:00:00.000Z")
const expiresAt = new Date("2026-11-24T11:00:00.000Z")
const hash = (digit: string) => digit.repeat(64)

function input(count = 6): ObjectiveApplicationApprovalSetIssueInput {
  return {
    setId: "set-objective-1", sourceTurnId: "turn-objective-source-1", intentHash: hash("d"), expiresAt, now,
    members: Array.from({ length: count }, (_, index) => ({ slotOrdinal: index + 1, receipt: {
      approvalId: `approval-${index + 1}`, taskId: `task-${index + 1}`, title: `Review job ${index + 1}`,
      body: `Review the prepared materials for job ${index + 1}.`, impact: { jobIndex: index + 1 },
      payload: { jobId: `job-${index + 1}`, sourceDigest: hash(String(index + 1)) },
      scope: {
        userId: "owner-1", sessionId: "session-1", turnId: "turn-review-group-1", jobId: `job-${index + 1}`,
        toolCallId: `review-call-${index + 1}`, action: "review_application" as const,
        resourceHash: hash(String(index + 1)), materialHash: hash("a"), answersHash: hash("b"), revision: 4, expiresAt,
      },
    } })),
  }
}

function fakePool(failOnApprovalInsert = 0, sourceTurnCompleted = true) {
  const calls: Array<{ sql: string; params?: unknown[] }> = []
  const approvals = new Map<string, Record<string, unknown>>()
  let item: Record<string, unknown> | null = null
  let eventSequence = 0
  let approvalInsertCount = 0
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params })
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SELECT set_config(") || sql.startsWith("SAVEPOINT ")
      || sql.startsWith("RELEASE SAVEPOINT ") || sql.startsWith("ROLLBACK TO SAVEPOINT ")) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
    if (sql.includes('FROM "agent_turns"') && sql.includes('"status", "revision"')) {
      return { rows: [{ id: "turn-review-group-1", status: "in_progress", revision: 4 }], rowCount: 1 }
    }
    if (sql.includes('FROM "agent_turns"') && sql.includes("'completed'")) return { rows: sourceTurnCompleted ? [{ id: "turn-objective-source-1" }] : [], rowCount: sourceTurnCompleted ? 1 : 0 }
    if (sql.includes('FROM "agent_turns"')) return { rows: [{ id: "turn-review-group-1" }], rowCount: 1 }
    if (sql.includes('FROM "Job"')) return { rows: [{ id: params?.[0] }], rowCount: 1 }
    if (sql.includes('FROM "agent_items"')) return { rows: item ? [item] : [], rowCount: item ? 1 : 0 }
    if (sql.includes('FROM "agent_approvals"')) {
      const ids = params?.[0] as string[]
      return { rows: ids.map(id => approvals.get(id)).filter((row): row is Record<string, unknown> => !!row), rowCount: ids.length }
    }
    if (sql.startsWith('INSERT INTO "agent_approvals"')) {
      approvalInsertCount += 1
      if (approvalInsertCount === failOnApprovalInsert) throw new Error("synthetic approval insert failure")
      const values = params ?? []
      const row = {
        id: values[0], sessionId: values[1], taskId: values[2], userId: values[3], turnId: values[4], toolCallId: values[5],
        jobId: values[6], type: values[7], status: "pending", title: values[8], body: values[9], impact: JSON.parse(String(values[10])),
        payload: JSON.parse(String(values[11])), resourceHash: values[12], materialHash: values[13], answersHash: values[14],
        scopeHash: values[15], nonceHash: values[16], revision: values[17], expiresAt: values[18], decidedAt: null,
        consumedAt: null, createdAt: now,
      }
      approvals.set(String(row.id), row)
      return { rows: [row], rowCount: 1 }
    }
    if (sql.startsWith('INSERT INTO "agent_items"')) {
      item = { id: params?.[0], sessionId: params?.[1], turnId: params?.[2], type: "approval_request", content: JSON.parse(String(params?.[3])) }
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('UPDATE "agent_turns" SET "status" = \'waiting_for_approval\'')) return { rows: [], rowCount: 1 }
    if (sql.startsWith('UPDATE "agent_sessions" SET "eventSequence"')) return { rows: [{ eventSequence: String(++eventSequence) }], rowCount: 1 }
    if (sql.startsWith('INSERT INTO "agent_events"') || sql.startsWith('INSERT INTO "agent_outbox"')) return { rows: [], rowCount: 1 }
    throw new Error(`Unexpected SQL in approval-set test: ${sql}`)
  })
  const client = { query, release: vi.fn() }
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool
  return { pool, client, calls, approvals, get item() { return item } }
}

describe("Worker objective application approval-set store", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(now)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("issues six private review receipts and one durable group wait on the same client", async () => {
    const fake = fakePool()
    const store = createPgObjectiveApplicationApprovalSetStore(fake.pool, { userId: "owner-1" })
    const result = await store.issue(input())
    const writes = fake.calls.map(call => call.sql)
    expect(writes[0]).toBe("BEGIN")
    expect(writes).toContain("COMMIT")
    expect(result).toMatchObject({ disposition: "created", approvalSet: { schema: "objective-application-approval-set.v1", waitKind: "approval_set", sourceTurnId: "turn-objective-source-1", members: Array.from({ length: 6 }, (_, i) => ({ slotOrdinal: i + 1, approvalId: `approval-${i + 1}` })) } })
    expect(writes.filter(sql => sql.startsWith('INSERT INTO "agent_approvals"'))).toHaveLength(6)
    expect(writes.filter(sql => sql.startsWith('INSERT INTO "agent_items"'))).toHaveLength(1)
    expect(writes.filter(sql => sql.startsWith('UPDATE "agent_turns" SET "status" = \'waiting_for_approval\''))).toHaveLength(1)
    expect(fake.calls.filter(call => call.sql.includes("'item.started'") && call.sql.startsWith('INSERT INTO "agent_events"'))).toHaveLength(1)
    expect(fake.calls.filter(call => call.params?.includes("approval.requested"))).toHaveLength(6)
    expect(fake.calls.find(call => call.sql.includes("'completed'"))?.params).toEqual(["turn-objective-source-1", "session-1", "owner-1"])
    expect(writes.some(sql => sql.includes('agent_action_reservations'))).toBe(false)
    for (const [index, row] of [...fake.approvals.values()].entries()) {
      expect(row.payload).toEqual({ schema: "objective-application-approval-set-member.v1", setId: "set-objective-1", sourceTurnId: "turn-objective-source-1", slotOrdinal: index + 1, proof: input().members[index]!.receipt.payload })
    }
    const publicContent = JSON.stringify(fake.item?.content)
    expect(publicContent).not.toContain("sourceDigest")
    expect(publicContent).not.toContain("nonce")
    expect(publicContent).not.toContain("review-call")
  })

  it("replays the exact set without issuing receipts or changing the Turn again", async () => {
    const fake = fakePool()
    const store = createPgObjectiveApplicationApprovalSetStore(fake.pool, { userId: "owner-1" })
    await store.issue(input())
    const writesBeforeReplay = fake.calls.length
    const replayInput = input()
    const replay = await store.issue({ ...replayInput, now: new Date(expiresAt.getTime() + 1) })
    const replayCalls = fake.calls.slice(writesBeforeReplay).map(call => call.sql)
    expect(replay.disposition).toBe("duplicate")
    expect(replayCalls.some(sql => sql.startsWith('INSERT INTO "agent_approvals"'))).toBe(false)
    expect(replayCalls.some(sql => sql.startsWith('INSERT INTO "agent_items"'))).toBe(false)
    expect(replayCalls.some(sql => sql.startsWith('UPDATE "agent_turns"'))).toBe(false)
    expect(fake.approvals.size).toBe(6)
  })

  it("uses a caller transaction without opening a nested transaction", async () => {
    const fake = fakePool()
    const store = createPgObjectiveApplicationApprovalSetStore(fake.pool, { userId: "owner-1" })
    await store.issueInTransaction(fake.client as unknown as pg.PoolClient, input(2))
    const writes = fake.calls.map(call => call.sql)
    expect(fake.pool.connect).not.toHaveBeenCalled()
    expect(writes).not.toContain("BEGIN")
    expect(writes).not.toContain("COMMIT")
    expect(writes.filter(sql => sql.startsWith('INSERT INTO "agent_items"'))).toHaveLength(1)
  })

  it("rejects a replay whose private member proof changed", async () => {
    const fake = fakePool()
    const store = createPgObjectiveApplicationApprovalSetStore(fake.pool, { userId: "owner-1" })
    await store.issue(input())
    const changed = input()
    const members = [...changed.members]
    members[0] = { ...members[0]!, receipt: { ...members[0]!.receipt, payload: { different: true } } }
    await expect(store.issue({ ...changed, members })).rejects.toMatchObject({ code: "approval_reservation_conflict" })
    expect(fake.calls.filter(call => call.sql.startsWith('INSERT INTO "agent_approvals"'))).toHaveLength(6)
  })

  it("rejects repeated Job or tool-call scope before any durable writes", async () => {
    const fake = fakePool()
    const store = createPgObjectiveApplicationApprovalSetStore(fake.pool, { userId: "owner-1" })
    const duplicatedJob = input(2)
    const members = [...duplicatedJob.members]
    members[1] = { ...members[1]!, receipt: { ...members[1]!.receipt, scope: { ...members[1]!.receipt.scope, jobId: "job-1" } } }
    await expect(store.issue({ ...duplicatedJob, members })).rejects.toMatchObject({ code: "approval_scope_mismatch" })
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "agent_approvals"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "agent_items"'))).toBe(false)
    const duplicatedCall = input(2)
    const calls = [...duplicatedCall.members]
    calls[1] = { ...calls[1]!, receipt: { ...calls[1]!.receipt, scope: { ...calls[1]!.receipt.scope, toolCallId: "review-call-1" } } }
    await expect(store.issue({ ...duplicatedCall, members: calls })).rejects.toMatchObject({ code: "approval_scope_mismatch" })
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "agent_approvals"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "agent_items"'))).toBe(false)
  })

  it("rejects a non-review member before writing any receipts", async () => {
    const fake = fakePool()
    const store = createPgObjectiveApplicationApprovalSetStore(fake.pool, { userId: "owner-1" })
    const invalid = input(1)
    const members = [{ ...invalid.members[0]!, receipt: { ...invalid.members[0]!.receipt, scope: { ...invalid.members[0]!.receipt.scope, action: "submit_application" as const } } }]
    await expect(store.issue({ ...invalid, members })).rejects.toMatchObject({ code: "approval_scope_mismatch" })
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "agent_approvals"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "agent_items"'))).toBe(false)
  })

  it("requires a distinct completed source Turn in the exact owned Session", async () => {
    const sameTurnPool = fakePool()
    const sameTurnStore = createPgObjectiveApplicationApprovalSetStore(sameTurnPool.pool, { userId: "owner-1" })
    const sameTurn = input(1)
    const sameTurnMembers = [{ ...sameTurn.members[0]!, receipt: { ...sameTurn.members[0]!.receipt, scope: { ...sameTurn.members[0]!.receipt.scope, turnId: sameTurn.sourceTurnId } } }]
    await expect(sameTurnStore.issue({ ...sameTurn, members: sameTurnMembers })).rejects.toMatchObject({ code: "approval_scope_mismatch" })
    expect(sameTurnPool.calls.some(call => call.sql.startsWith('INSERT INTO "agent_approvals"'))).toBe(false)

    const incompletePool = fakePool(0, false)
    const incompleteStore = createPgObjectiveApplicationApprovalSetStore(incompletePool.pool, { userId: "owner-1" })
    await expect(incompleteStore.issue(input(1))).rejects.toMatchObject({ code: "approval_scope_mismatch" })
    expect(incompletePool.calls.some(call => call.sql.startsWith('INSERT INTO "agent_approvals"'))).toBe(false)
  })

  it("rolls back member writes when a later receipt cannot be persisted", async () => {
    const fake = fakePool(2)
    const store = createPgObjectiveApplicationApprovalSetStore(fake.pool, { userId: "owner-1" })
    await expect(store.issue(input(3))).rejects.toThrow("synthetic approval insert failure")
    const writes = fake.calls.map(call => call.sql)
    expect(writes.some(sql => sql.startsWith("ROLLBACK TO SAVEPOINT "))).toBe(true)
    expect(writes).toContain("ROLLBACK")
    expect(writes.some(sql => sql.startsWith('INSERT INTO "agent_items"'))).toBe(false)
    expect(writes.some(sql => sql.startsWith('UPDATE "agent_turns"'))).toBe(false)
  })
})
