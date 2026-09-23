import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { drainAgentWakeups, resumeAgentTurn } from "./consumer.js"
import type { AgentTurnWakeupPayload } from "./types.js"

const wakeup: AgentTurnWakeupPayload = {
  eventId: "event_wakeup", sessionId: "session_1", turnId: "turn_1", itemId: "agent-wait:question:q1",
  waitKind: "question", waitId: "q1", toolCallId: "call_1", status: "answered", nextTurnRevision: 6,
}
const approvalWakeup: AgentTurnWakeupPayload = {
  eventId: "event_approval", sessionId: "session_1", turnId: "turn_1", itemId: "agent-wait:approval:a1",
  waitKind: "approval", waitId: "a1", toolCallId: "call_approval", status: "approved", nextTurnRevision: 6,
}

type FakeOutboxRow = { id: string; aggregateId: string; payload: unknown; publishedAt?: Date | null }
type FakeDispatchRow = { id: string; aggregateId: string; idempotencyKey: string; payload: unknown; publishedAt: Date | null; attemptCount?: number; topic?: string }
type FakeOptions = {
  payload?: AgentTurnWakeupPayload
  rows?: FakeOutboxRow[]
  dispatchRows?: FakeDispatchRow[]
  sessionStatus?: string
  sessionSequenceRows?: Array<string | bigint | null>
  turn?: { userId: string; status: string; revision: number; leaseOwnerId?: string | null; leaseExpiresAt?: string | null; leaseStartedAt?: string | null } | null
  item?: { status: string; content: unknown } | null
  event?: { sessionId: string; turnId: string; itemId: string | null; type: string; payload: unknown } | null
  execution?: { userId: string; sessionId: string; status: string; error: string | null; completedAt: string | null } | null
  failEventOnce?: boolean
  failExecutionUpdateOnce?: boolean
  failDispatchAfterWriteOnce?: boolean
  turnUpdateRows?: number
}

function wakeupEnvelope(payload = wakeup) {
  return {
    eventId: payload.eventId, sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, type: "turn.wakeup",
    payload: {
      waitKind: payload.waitKind, waitId: payload.waitId, itemId: payload.itemId, turnId: payload.turnId,
      toolCallId: payload.toolCallId, status: payload.status, nextTurnRevision: payload.nextTurnRevision,
    },
  }
}

function fakePool(options: FakeOptions = {}) {
  const calls: Array<[string, unknown[] | undefined]> = []
  const currentWakeup = options.payload ?? wakeup
  const rows = new Map((options.rows ?? [{ id: "outbox_1", aggregateId: currentWakeup.sessionId, payload: wakeupEnvelope(currentWakeup) }]).map((row) => [row.id, { ...row, publishedAt: row.publishedAt ?? null }]))
  const outboxUpdates: Array<{ id: string; lastError: unknown }> = []
  let turn = options.turn === undefined ? { userId: "user_1", status: currentWakeup.waitKind === "approval" ? "waiting_for_approval" : "waiting_for_user", revision: currentWakeup.nextTurnRevision } : options.turn
  const item = options.item === undefined
    ? currentWakeup.waitKind === "approval"
      ? { status: "completed", content: { waitKind: "approval", approvalId: "a1", toolCallId: "call_approval" } }
      : { status: "completed", content: { waitKind: "question", questionId: "q1", toolCallId: "call_1", answer: "secret-answer" } }
    : options.item
  const event = options.event === undefined ? { sessionId: currentWakeup.sessionId, turnId: currentWakeup.turnId, itemId: currentWakeup.itemId, type: "turn.wakeup", payload: wakeupEnvelope(currentWakeup).payload } : options.event
  const execution = options.execution === undefined ? { userId: "user_1", sessionId: wakeup.sessionId, status: "waiting_for_user", error: "old error", completedAt: "old completion" } : options.execution
  let failEventOnce = options.failEventOnce ?? false
  let failExecutionUpdateOnce = options.failExecutionUpdateOnce ?? false
  let failDispatchAfterWriteOnce = options.failDispatchAfterWriteOnce ?? false
  let dispatchRows = (options.dispatchRows ?? []).map(row => ({ ...row }))
  let sessionSequenceCall = 0
  let transactionSnapshot: { turn: typeof turn; execution: typeof execution; dispatchRows: FakeDispatchRow[] } | null = null
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      if (sql === "BEGIN") {
        transactionSnapshot = { turn: turn ? { ...turn } : turn, execution: execution ? { ...execution } : execution, dispatchRows: dispatchRows.map(row => ({ ...row })) }
        return { rows: [], rowCount: 0 }
      }
      if (sql === "COMMIT") {
        transactionSnapshot = null
        return { rows: [], rowCount: 0 }
      }
      if (sql === "ROLLBACK") {
        if (transactionSnapshot) {
          turn = transactionSnapshot.turn ? { ...transactionSnapshot.turn } : transactionSnapshot.turn
          if (execution && transactionSnapshot.execution) Object.assign(execution, transactionSnapshot.execution)
          dispatchRows = transactionSnapshot.dispatchRows.map(row => ({ ...row }))
        }
        transactionSnapshot = null
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes('SELECT "id", "aggregateId", "payload"') && sql.includes('"publishedAt" IS NULL')) {
        const pending = [...rows.values()].filter((row) => row.publishedAt === null).map(({ publishedAt: _publishedAt, ...row }) => row)
        return { rows: pending, rowCount: pending.length }
      }
      if (sql.includes('SELECT "id", "aggregateId", "payload", "publishedAt"')) {
        const row = rows.get(String(params?.[0]))
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
      }
      if (sql.includes('SELECT "userId", "status" FROM "agent_sessions"')) {
        return { rows: [{ userId: "user_1", status: options.sessionStatus ?? "running" }], rowCount: 1 }
      }
      if (sql.includes('FROM "agent_events"')) {
        if (failEventOnce) {
          failEventOnce = false
          throw new Error("temporary database failure")
        }
        return { rows: event ? [event] : [], rowCount: event ? 1 : 0 }
      }
      if (sql.includes('SELECT "aggregateId", "topic" FROM "agent_outbox"')) {
        const row = dispatchRows.find(candidate => candidate.idempotencyKey === String(params?.[0]))
        return row ? { rows: [{ aggregateId: row.aggregateId, topic: row.topic ?? "agent.turn.dispatch" }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (sql.includes('SELECT turn."id"') && sql.includes('FROM "agent_turns"')) return { rows: turn ? [{ id: currentWakeup.turnId }] : [], rowCount: turn ? 1 : 0 }
      if (sql.includes('SELECT turn."userId"')) return { rows: turn ? [turn] : [], rowCount: turn ? 1 : 0 }
      if (sql.includes('SELECT set_config')) return { rows: [], rowCount: 1 }
      if (sql.includes('SELECT "status", "content"')) return { rows: item ? [item] : [], rowCount: item ? 1 : 0 }
      if (sql.includes('UPDATE "agent_sessions"')) {
        const configured = options.sessionSequenceRows?.[sessionSequenceCall++]
        const eventSequence = configured === undefined ? "10" : configured
        return eventSequence === null ? { rows: [], rowCount: 0 } : { rows: [{ eventSequence }], rowCount: 1 }
      }
      if (sql.includes('UPDATE "agent_executions"')) {
        if (failExecutionUpdateOnce) {
          failExecutionUpdateOnce = false
          throw new Error("execution update failed")
        }
        const currentExecution = execution
        const matches = currentExecution !== null && currentExecution.userId === params?.[0] && currentExecution.sessionId === params?.[1] && currentExecution.status === "waiting_for_user"
        if (matches) {
          currentExecution.status = "queued"
          currentExecution.error = null
          currentExecution.completedAt = null
        }
        return { rows: [], rowCount: matches ? 1 : 0 }
      }
      if (sql.includes('UPDATE "agent_turns"')) {
        const rowCount = options.turnUpdateRows ?? 1
        if (rowCount === 1 && sql.includes("SET \"status\" = 'queued'")) turn = turn ? { ...turn, status: "queued", revision: turn.revision + 1, leaseOwnerId: null, leaseExpiresAt: null, leaseStartedAt: null } : turn
        return { rows: [], rowCount }
      }
      if (sql.includes('INSERT INTO "agent_outbox"') && params?.[1] === "agent.turn.dispatch") {
        const idempotencyKey = String(params?.[3])
        const existing = dispatchRows.find(row => row.idempotencyKey === idempotencyKey)
        const nextPayload = JSON.parse(String(params?.[4]))
        const sameScope = existing?.aggregateId === String(params?.[2]) && (existing.topic ?? "agent.turn.dispatch") === "agent.turn.dispatch"
        if (existing && sql.includes('DO UPDATE') && sameScope) {
          existing.payload = nextPayload
          existing.publishedAt = null
          existing.attemptCount = (existing.attemptCount ?? 0) + 1
        } else if (!existing) dispatchRows.push({ id: String(params?.[0]), aggregateId: String(params?.[2]), idempotencyKey, payload: nextPayload, publishedAt: null })
        if (failDispatchAfterWriteOnce) {
          failDispatchAfterWriteOnce = false
          throw new Error("dispatch write failed")
        }
        return { rows: [], rowCount: existing ? 0 : 1 }
      }
      if (sql.includes('UPDATE "agent_outbox"')) {
        const id = String(params?.[0])
        const row = rows.get(id)
        if (row && sql.includes('SET "publishedAt"')) row.publishedAt = new Date(0)
        outboxUpdates.push({ id, lastError: params?.[2] })
        return { rows: [], rowCount: row ? 1 : 0 }
      }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool
  return { pool, client, calls, outboxUpdates, rows, dispatchRows: () => dispatchRows, execution, get turn() { return turn } }
}

function hasCall(calls: Array<[string, unknown[] | undefined]>, fragment: string): boolean {
  return calls.some(([sql]) => sql.includes(fragment))
}

function hasWrite(calls: Array<[string, unknown[] | undefined]>): boolean {
  return calls.some(([sql]) => sql.includes('UPDATE "agent_turns"') || sql.includes('UPDATE "agent_sessions"') || sql.includes('INSERT INTO'))
}

describe("Agent wakeup consumer", () => {
  it("resumes the same Turn and preserves the original toolCallId", async () => {
    const fake = fakePool()
    const result = await resumeAgentTurn(fake.pool, wakeup)

    expect(result).toMatchObject({ status: "resumed", turnId: "turn_1", itemId: wakeup.itemId, toolCallId: "call_1" })
    const resumeEvent = fake.calls.find(([sql]) => sql.includes("'turn.resumed'"))
    expect(resumeEvent).toBeDefined()
    expect(JSON.stringify(fake.calls)).not.toContain("secret-answer")
    expect(fake.calls.some(([sql, params]) => sql.includes('UPDATE "agent_turns" AS turn') && sql.includes('SET "status" = \'queued\'') && params?.includes(6))).toBe(true)
    expect(fake.calls.some(([sql]) => sql.includes('session."userId" = turn."userId"'))).toBe(true)
    expect(fake.execution).toEqual({ userId: "user_1", sessionId: wakeup.sessionId, status: "queued", error: null, completedAt: null })
    expect(fake.dispatchRows()).toHaveLength(1)
    const dispatch = fake.dispatchRows()[0]
    expect(dispatch.aggregateId).toBe(wakeup.sessionId)
    expect(dispatch.idempotencyKey).toBe("turn-dispatch:turn_1")
    expect(Object.keys(dispatch.payload as object).sort()).toEqual(["ownerId", "sessionId", "turnId"])
    expect(dispatch.payload).toEqual({ turnId: wakeup.turnId, sessionId: wakeup.sessionId, ownerId: "wakeup:event_wakeup" })
  })

  it("accepts the canonical waitId used by Gmail OAuth question items", async () => {
    const fake = fakePool({ item: {
      status: "completed",
      content: { waitKind: "question", oauth: true, waitId: "q1", toolCallId: "call_1" },
    } })

    await expect(resumeAgentTurn(fake.pool, wakeup)).resolves.toMatchObject({ status: "resumed" })
    expect(fake.calls.some(([sql]) => sql.includes("SET \"status\" = 'queued'"))).toBe(true)
  })

  it("resumes an approval wait and clears stale lease ownership before queueing", async () => {
    const fake = fakePool({
      payload: approvalWakeup,
      turn: {
        userId: "user_1", status: "waiting_for_approval", revision: approvalWakeup.nextTurnRevision,
        leaseOwnerId: "stale-owner", leaseExpiresAt: "2026-09-01T00:01:00.000Z", leaseStartedAt: "2026-09-01T00:00:00.000Z",
      },
    })

    await expect(resumeAgentTurn(fake.pool, approvalWakeup)).resolves.toMatchObject({ status: "resumed", turnId: approvalWakeup.turnId, itemId: approvalWakeup.itemId })
    expect(fake.turn).toMatchObject({ status: "queued", leaseOwnerId: null, leaseExpiresAt: null, leaseStartedAt: null })
    const turnUpdate = fake.calls.find(([sql]) => sql.includes('UPDATE "agent_turns" AS turn'))?.[0] ?? ""
    expect(turnUpdate).toContain('"leaseOwnerId" = NULL')
    expect(turnUpdate).toContain('"leaseExpiresAt" = NULL')
    expect(turnUpdate).toContain('"leaseStartedAt" = NULL')
    expect(fake.dispatchRows()[0]?.payload).toEqual({ turnId: approvalWakeup.turnId, sessionId: approvalWakeup.sessionId, ownerId: "wakeup:event_approval" })
  })

  it("resets a prior dispatch once for a new wakeup and not on repeated delivery", async () => {
    const publishedAt = new Date("2026-09-22T10:00:00.000Z")
    const fake = fakePool({ dispatchRows: [{ id: "dispatch_1", aggregateId: wakeup.sessionId, idempotencyKey: "turn-dispatch:turn_1", payload: { turnId: wakeup.turnId, sessionId: wakeup.sessionId, ownerId: "old-server-owner" }, publishedAt }] })

    await expect(resumeAgentTurn(fake.pool, wakeup)).resolves.toMatchObject({ status: "resumed" })
    expect(fake.dispatchRows()[0]?.publishedAt).toBeNull()
    expect(fake.dispatchRows()[0]?.payload).toEqual({ turnId: wakeup.turnId, sessionId: wakeup.sessionId, ownerId: "wakeup:event_wakeup" })
    await expect(resumeAgentTurn(fake.pool, wakeup)).resolves.toMatchObject({ status: "already_resumed" })

    expect(fake.dispatchRows()).toHaveLength(1)
    expect(fake.calls.filter(([sql, params]) => sql.includes('INSERT INTO "agent_outbox"') && params?.[1] === "agent.turn.dispatch")).toHaveLength(1)
  })

  it("fails closed when a foreign dispatch row reuses the Turn idempotency key", async () => {
    const fake = fakePool({ dispatchRows: [{ id: "foreign_dispatch", aggregateId: "other_session", idempotencyKey: "turn-dispatch:turn_1", payload: { turnId: wakeup.turnId, sessionId: "other_session", ownerId: "foreign" }, publishedAt: null }] })

    await expect(resumeAgentTurn(fake.pool, wakeup)).rejects.toMatchObject({ code: "outbox_scope_mismatch" })
    expect(fake.turn).toMatchObject({ status: "waiting_for_user", revision: wakeup.nextTurnRevision })
    expect(fake.dispatchRows()).toHaveLength(1)
  })

  it("fails closed and leaves a foreign-topic dispatch row unchanged", async () => {
    const foreign = { id: "foreign_topic", aggregateId: wakeup.sessionId, idempotencyKey: "turn-dispatch:turn_1", payload: { turnId: "foreign_turn", sessionId: wakeup.sessionId, ownerId: "foreign" }, publishedAt: new Date("2026-09-22T10:00:00.000Z"), attemptCount: 4, topic: "agent.other.topic" }
    const fake = fakePool({ dispatchRows: [foreign] })

    await expect(resumeAgentTurn(fake.pool, wakeup)).rejects.toMatchObject({ code: "outbox_scope_mismatch" })
    expect(fake.turn).toMatchObject({ status: "waiting_for_user", revision: wakeup.nextTurnRevision })
    expect(fake.dispatchRows()).toEqual([foreign])
  })

  it("rolls back a dispatch reset when its transaction fails", async () => {
    const publishedAt = new Date("2026-09-22T10:00:00.000Z")
    const fake = fakePool({
      dispatchRows: [{ id: "dispatch_1", aggregateId: wakeup.sessionId, idempotencyKey: "turn-dispatch:turn_1", payload: { turnId: wakeup.turnId, sessionId: wakeup.sessionId, ownerId: "old-server-owner" }, publishedAt }],
      failDispatchAfterWriteOnce: true,
    })

    await expect(resumeAgentTurn(fake.pool, wakeup)).rejects.toThrow("dispatch write failed")
    expect(fake.turn).toMatchObject({ status: "waiting_for_user", revision: wakeup.nextTurnRevision })
    expect(fake.dispatchRows()[0]?.publishedAt).toBe(publishedAt)
    expect(fake.dispatchRows()[0]?.payload).toEqual({ turnId: wakeup.turnId, sessionId: wakeup.sessionId, ownerId: "old-server-owner" })
  })

  it("claims and marks durable wakeups after the same-lineage resume", async () => {
    const fake = fakePool()
    await expect(drainAgentWakeups(fake.pool, 1)).resolves.toBe(1)
    expect(fake.outboxUpdates).toEqual([{ id: "outbox_1", lastError: null }])
    const pendingSelect = fake.calls.find(([sql]) => sql.includes('FROM "agent_outbox"') && sql.includes('"publishedAt" IS NULL'))
    expect(pendingSelect?.[0]).toContain('LIMIT $2 FOR UPDATE SKIP LOCKED')
    expect(pendingSelect?.[0]).not.toContain('FOR UPDATE SKIP LOCKED LIMIT')
    expect(fake.calls.some(([sql]) => sql === "COMMIT")).toBe(true)
  })

  it.each(["aborted", "archived"])("ignores a %s session before touching its Turn", async (sessionStatus) => {
    const fake = fakePool({ sessionStatus })
    await expect(resumeAgentTurn(fake.pool, wakeup)).resolves.toMatchObject({ status: "ignored" })

    expect(hasWrite(fake.calls)).toBe(false)
    expect(hasCall(fake.calls, "SELECT set_config")).toBe(false)
  })

  it.each(["aborted", "archived"])("marks a %s wakeup consumed without resuming", async (sessionStatus) => {
    const fake = fakePool({ sessionStatus })
    await expect(drainAgentWakeups(fake.pool, 1)).resolves.toBe(1)

    expect(hasCall(fake.calls, 'UPDATE "agent_outbox" SET "publishedAt"')).toBe(true)
    expect(hasCall(fake.calls, 'UPDATE "agent_turns"')).toBe(false)
    expect(hasCall(fake.calls, 'UPDATE "agent_sessions"')).toBe(false)
    expect(hasCall(fake.calls, "INSERT INTO")).toBe(false)
  })

  it("keeps duplicate queued delivery idempotent without item or event writes", async () => {
    const fake = fakePool({ turn: { userId: "user_1", status: "queued", revision: 7 } })
    await expect(resumeAgentTurn(fake.pool, wakeup)).resolves.toMatchObject({ status: "already_resumed" })
    expect(hasCall(fake.calls, 'SELECT "status", "content"')).toBe(false)
    expect(hasCall(fake.calls, "INSERT INTO")).toBe(false)
    expect(hasCall(fake.calls, 'UPDATE "agent_executions"')).toBe(false)
  })

  it("allows a pure canonical session with no legacy execution", async () => {
    const fake = fakePool({ execution: null })

    await expect(resumeAgentTurn(fake.pool, wakeup)).resolves.toMatchObject({ status: "resumed" })
    expect(hasCall(fake.calls, 'UPDATE "agent_executions"')).toBe(true)
  })

  it.each([
    { userId: "user-1", sessionId: "other-session", status: "waiting_for_user", error: "keep", completedAt: "keep" },
    { userId: "user-1", sessionId: wakeup.sessionId, status: "paused", error: "keep", completedAt: "keep" },
    { userId: "other-user", sessionId: wakeup.sessionId, status: "waiting_for_user", error: "keep", completedAt: "keep" },
  ])("leaves a non-claimable legacy execution unchanged: %j", async execution => {
    const fake = fakePool({ execution })

    await expect(resumeAgentTurn(fake.pool, wakeup)).resolves.toMatchObject({ status: "resumed" })
    expect(fake.execution).toEqual(execution)
  })

  it("rolls back and leaves the wakeup unpublished when legacy execution reset fails", async () => {
    const fake = fakePool({ failExecutionUpdateOnce: true })

    await expect(drainAgentWakeups(fake.pool, 1)).resolves.toBe(0)
    expect(hasCall(fake.calls, "ROLLBACK")).toBe(true)
    expect(fake.outboxUpdates).toEqual([{ id: "outbox_1", lastError: "processing_error" }])
    expect(fake.execution).toEqual({ userId: "user_1", sessionId: wakeup.sessionId, status: "waiting_for_user", error: "old error", completedAt: "old completion" })
    expect(fake.dispatchRows()).toHaveLength(0)
  })

  it("treats a fenced Turn update miss as an already-resumed no-op", async () => {
    const fake = fakePool({ turnUpdateRows: 0 })
    await expect(resumeAgentTurn(fake.pool, wakeup)).resolves.toMatchObject({ status: "already_resumed" })
    expect(hasCall(fake.calls, "INSERT INTO")).toBe(false)
    expect(hasCall(fake.calls, 'UPDATE "agent_sessions"')).toBe(false)
    expect(hasCall(fake.calls, "COMMIT")).toBe(true)
  })

  it("rolls back when the session closes before the resume event sequence", async () => {
    const fake = fakePool({ sessionSequenceRows: [null] })
    await expect(resumeAgentTurn(fake.pool, wakeup)).rejects.toThrow("sequence is unavailable")
    expect(hasCall(fake.calls, "ROLLBACK")).toBe(true)
    expect(hasCall(fake.calls, 'INSERT INTO "agent_events"')).toBe(false)
    expect(hasCall(fake.calls, 'INSERT INTO "agent_outbox"')).toBe(false)
  })

  it("marks duplicate wakeup rows after one Turn resume", async () => {
    const fake = fakePool({ rows: [
      { id: "duplicate_1", aggregateId: wakeup.sessionId, payload: wakeupEnvelope() },
      { id: "duplicate_2", aggregateId: wakeup.sessionId, payload: wakeupEnvelope() },
    ] })

    await expect(drainAgentWakeups(fake.pool, 2)).resolves.toBe(2)
    expect(fake.outboxUpdates).toEqual([
      { id: "duplicate_1", lastError: null },
      { id: "duplicate_2", lastError: null },
    ])
    expect(fake.calls.filter(([sql]) => sql.includes('UPDATE "agent_turns"') && sql.includes("SET \"status\" = 'queued'")).length).toBe(1)
    expect(fake.dispatchRows()).toHaveLength(1)
  })

  it("terminalizes malformed rows and continues with later wakeups", async () => {
    const fake = fakePool({ rows: [
      { id: "bad", aggregateId: wakeup.sessionId, payload: { type: "turn.wakeup" } },
      { id: "good", aggregateId: wakeup.sessionId, payload: wakeupEnvelope() },
    ] })

    await expect(drainAgentWakeups(fake.pool, 2)).resolves.toBe(2)
    expect(fake.outboxUpdates).toEqual([
      { id: "bad", lastError: "schema_invalid_payload" },
      { id: "good", lastError: null },
    ])
  })

  it("terminalizes stale or mis-scoped wakeups without changing the Turn", async () => {
    const stale = fakePool({
      rows: [{ id: "stale", aggregateId: "other_session", payload: wakeupEnvelope() }],
      turn: { userId: "user_1", status: "waiting_for_user", revision: 7 },
    })

    await expect(drainAgentWakeups(stale.pool, 1)).resolves.toBe(1)
    expect(stale.outboxUpdates).toEqual([{ id: "stale", lastError: "outbox_scope_mismatch" }])
    expect(stale.calls.some(([sql]) => sql.includes("SET \"status\" = 'queued'"))).toBe(false)

    const revision = fakePool({ rows: [{ id: "revision", aggregateId: wakeup.sessionId, payload: wakeupEnvelope() }], turn: { userId: "user_1", status: "waiting_for_user", revision: 7 } })
    await expect(drainAgentWakeups(revision.pool, 1)).resolves.toBe(1)
    expect(revision.outboxUpdates).toEqual([{ id: "revision", lastError: "turn_revision_conflict" }])
    expect(revision.calls.some(([sql]) => sql.includes("SET \"status\" = 'queued'"))).toBe(false)

    const waitKind = fakePool({
      payload: approvalWakeup,
      turn: { userId: "user_1", status: "waiting_for_user", revision: approvalWakeup.nextTurnRevision },
    })
    await expect(resumeAgentTurn(waitKind.pool, approvalWakeup)).rejects.toMatchObject({ code: "wait_scope_mismatch" })
    expect(waitKind.outboxUpdates).toEqual([])
    expect(waitKind.calls.some(([sql]) => sql.includes("SET \"status\" = 'queued'"))).toBe(false)

    const lineage = fakePool({ rows: [{ id: "lineage", aggregateId: wakeup.sessionId, payload: wakeupEnvelope() }], event: null })
    await expect(drainAgentWakeups(lineage.pool, 1)).resolves.toBe(1)
    expect(lineage.outboxUpdates).toEqual([{ id: "lineage", lastError: "event_lineage_mismatch" }])
    expect(lineage.calls.some(([sql]) => sql.includes("SET \"status\" = 'queued'"))).toBe(false)
    expect(lineage.calls.some(([sql, params]) => sql.includes('INSERT INTO "agent_outbox"') && params?.[1] === "agent.turn.dispatch")).toBe(false)

    const tool = fakePool({ rows: [{ id: "tool", aggregateId: wakeup.sessionId, payload: wakeupEnvelope() }], item: { status: "completed", content: { waitKind: "question", questionId: "q1", toolCallId: "other_call" } } })
    await expect(drainAgentWakeups(tool.pool, 1)).resolves.toBe(1)
    expect(tool.outboxUpdates).toEqual([{ id: "tool", lastError: "tool_lineage_mismatch" }])
    expect(tool.calls.some(([sql]) => sql.includes("SET \"status\" = 'queued'"))).toBe(false)
  })

  it("records transient processing failures for retry without blocking the drain", async () => {
    const fake = fakePool({ failEventOnce: true })
    await expect(drainAgentWakeups(fake.pool, 1)).resolves.toBe(0)
    expect(fake.outboxUpdates).toEqual([{ id: "outbox_1", lastError: "processing_error" }])
    await expect(drainAgentWakeups(fake.pool, 1)).resolves.toBe(1)
    expect(fake.outboxUpdates).toEqual([
      { id: "outbox_1", lastError: "processing_error" },
      { id: "outbox_1", lastError: null },
    ])
  })
})
