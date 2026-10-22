import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
const graphMocks = vi.hoisted(() => ({ prepare: vi.fn(), persist: vi.fn() }))
vi.mock("./task-graph-pg-lifecycle.js", async importOriginal => ({
  ...await importOriginal<typeof import("./task-graph-pg-lifecycle.js")>(),
  prepareGraphTransition: graphMocks.prepare,
  persistGraphTransition: graphMocks.persist,
}))
import { recoverExpired } from "./pg-store-expiry-recovery.js"
import type { PgSubagentPool } from "./types.js"

const checkedAt = new Date("2026-10-06T10:00:00Z")
type FixtureOptions = { pendingCall?: boolean; candidate?: boolean; childWaitResumable?: boolean; attemptCount?: number;
  maxAttempts?: number; child?: boolean; outboxOwnerId?: string; dispatchPublished?: boolean; rearmCount?: number;
  registeredWait?: boolean; targetStatus?: string; callMatches?: boolean; recoveryLeaseLost?: boolean; continuationWait?: boolean }
function fixture(options: FixtureOptions = {}) {
  const calls: string[] = []
  const task = { id: options.child ? "child-1" : "task-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: options.child ? "root-1" : "task-1", parentTaskId: options.child ? "root-1" : null,
    path: "/task-1", depth: 0, role: "scout", taskType: "scout", status: "running", goal: "inspect", constraints: [], successCriteria: [],
    allowedActions: [], context: {}, expectedOutputSchema: {}, result: null, failureReason: null, attemptCount: options.attemptCount ?? 1, maxAttempts: options.maxAttempts ?? 3,
    leaseOwner: "worker-1", leaseExpiresAt: new Date(checkedAt.getTime() - 1_000), nextAttemptAt: null, interruptRequestedAt: null,
    budgetSnapshot: {}, toolPolicySnapshot: {} }
  const outbox = { id: "dispatch-1", topic: "agent.subagent.dispatch", aggregateId: task.sessionId,
    idempotencyKey: `subagent-dispatch:${task.id}`, payload: { taskId: task.id, sessionId: task.sessionId,
      rootTaskId: task.rootTaskId, ownerId: options.outboxOwnerId ?? task.leaseOwner }, attemptCount: 4,
    publishedAt: options.dispatchPublished === false ? null : new Date(checkedAt.getTime() - 1_000), lastError: "previous_error" as string | null }
  const wait = { id: "wait-1", userId: task.userId, sessionId: task.sessionId, turnId: task.turnId, parentTaskId: task.id,
    stepId: "step-1", idempotencyKey: "wait-key-1", targetTaskIds: ["target-1"], mode: "any", status: options.continuationWait ? "ready" : "waiting",
    deadlineAt: new Date(checkedAt.getTime() + 10_000), matchedTaskIds: [] as string[],
    suspendedAt: options.continuationWait ? checkedAt : null as Date | null,
    consumedAt: options.continuationWait ? checkedAt : null as Date | null,
    result: { request: { targetTaskIds: ["target-1"], mode: "any", timeoutMs: 10_000 }, outcome: { status: "waiting" } } }
  const client = { query: vi.fn(async (sql: string, _values?: unknown[]) => {
    calls.push(sql)
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
    if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("LIMIT $1")) return options.candidate === false ? { rows: [], rowCount: 0 } : { rows: [{ id: task.id, sessionId: task.sessionId, rootTaskId: task.rootTaskId, turnId: task.turnId, userId: task.userId }], rowCount: 1 }
    if (sql.startsWith('SELECT "id", "userId", "status" FROM "agent_sessions"') && sql.includes("FOR UPDATE")) return { rows: [{ id: task.sessionId, userId: task.userId, status: "running" }], rowCount: 1 }
    if (sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE")) return { rows: [{ id: task.turnId }], rowCount: 1 }
    if (sql.includes('session."status" AS "sessionStatus"')) return { rows: [{ ...task, sessionStatus: "running", rootStatus: "running", rootInterruptRequestedAt: null,
      childWaitResumable: options.childWaitResumable ?? false, childWaitConsumed: options.continuationWait ?? false }], rowCount: 1 }
    if (sql.startsWith('SELECT task.*') && sql.includes("FOR UPDATE OF task")) return { rows: [{ ...task, sessionStatus: "running", rootStatus: "running", rootInterruptRequestedAt: null,
      childWaitResumable: options.childWaitResumable ?? false, childWaitConsumed: options.continuationWait ?? false }], rowCount: 1 }
    if (sql.includes('SELECT task."id", task."parentTaskId"') && sql.includes("FOR UPDATE OF task")) return options.recoveryLeaseLost
      ? { rows: [], rowCount: 0 } : { rows: [{ ...task, turnStatus: "in_progress", rootStatus: "running" }], rowCount: 1 }
    if (sql.includes('FROM "agent_wait_conditions" AS wait JOIN "agent_steps" AS step') && sql.includes('wait."status" = \'waiting\'')) return options.registeredWait
      ? { rows: [{ ...wait, attempt: task.attemptCount, ordinal: 4, latestOrdinal: 4, stepStatus: "waiting_for_tool" }], rowCount: 1 } : { rows: [], rowCount: 0 }
    if (sql.includes('FROM "agent_items" AS call')) return { rows: [{ status: "started", content: {
      toolCallId: "wait-call-1", toolName: "wait_subagents", toolVersion: "1",
      input: { idempotencyKey: options.callMatches === false ? "other-key" : wait.idempotencyKey, mode: wait.mode,
        taskIds: wait.targetTaskIds, timeoutMs: 10_000 },
    } }], rowCount: 1 }
    if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("ANY($1::text[])")) return { rows: [{
      id: "target-1", parentTaskId: task.id, rootTaskId: task.rootTaskId, turnId: task.turnId, sessionId: task.sessionId,
      status: options.targetStatus ?? "running", role: "writer", result: null, failureReason: null,
    }], rowCount: 1 }
    if (sql.startsWith('UPDATE "agent_wait_conditions"')) {
      wait.status = String(_values?.[0]); wait.matchedTaskIds = JSON.parse(String(_values?.[1])) as string[]
      wait.result = JSON.parse(String(_values?.[2])) as typeof wait.result; wait.suspendedAt = _values?.[3] as Date
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $1')) { task.status = String(_values?.[0]); return { rows: [], rowCount: 1 } }
    if (sql.startsWith('INSERT INTO "agent_outbox"')) { outbox.payload = JSON.parse(String(_values?.[3])) as typeof outbox.payload; return { rows: [{ idempotencyKey: _values?.[2] }], rowCount: 1 } }
    if (sql.startsWith("SELECT clock_timestamp()")) return { rows: [{ checkedAt }], rowCount: 1 }
    if (sql.includes('FROM "agent_events" AS started')) return options.pendingCall ? { rows: [{ id: "started-event" }], rowCount: 1 } : { rows: [], rowCount: 0 }
    if (sql.includes('FROM "agent_outbox" AS dispatch') && sql.includes("FOR UPDATE")) return { rows: [outbox], rowCount: 1 }
    if (sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $3')) { task.status = String(_values?.[2]); return { rows: [], rowCount: 1 } }
    if (sql.startsWith('UPDATE "agent_outbox" SET "payload"')) {
      if (options.rearmCount === 0) return { rows: [], rowCount: 0 }
      outbox.payload = JSON.parse(String(_values?.[0])) as typeof outbox.payload
      outbox.publishedAt = null
      outbox.lastError = null
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 1 }
  }), release: vi.fn() }
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as Pick<pg.Pool, "connect">, calls, client, task, outbox, wait }
}

describe("expired subagent recovery fence", () => {
  it("recovers only an explicitly expired lease with no unmatched model or tool start", async () => {
    const fake = fixture()
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toMatchObject([{ id: "task-1", status: "queued" }])
    const session = fake.calls.findIndex(sql => sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE"))
    const turn = fake.calls.findIndex(sql => sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE"))
    const taskLock = fake.calls.findIndex(sql => sql.includes("FOR UPDATE OF task"))
    const external = fake.calls.findIndex(sql => sql.includes('FROM "agent_events" AS started'))
    const update = fake.calls.findIndex(sql => sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $3'))
    expect(session).toBeLessThan(turn)
    expect(turn).toBeLessThan(taskLock)
    expect(taskLock).toBeLessThan(external)
    expect(external).toBeLessThan(update)
    const scan = fake.calls.find(sql => sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("LIMIT $1")) ?? ""
    expect(scan).toContain('task."leaseExpiresAt" <= clock_timestamp()')
    expect(scan).not.toContain('task."leaseExpiresAt" IS NULL')
  })

  it("keeps an expired lease as a blocker when a model or tool start has no terminal event", async () => {
    const fake = fixture({ pendingCall: true })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toEqual([])
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.at(-1)).toBe("COMMIT")
  })

  it("does not scan a task without an explicit lease expiry", async () => {
    const fake = fixture({ candidate: false })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toEqual([])
    expect(fake.calls.some(sql => sql.includes("FOR UPDATE OF task"))).toBe(false)
  })

  it("requeues a max-attempt child wait on the same attempt and rearms only the current published generation", async () => {
    const fake = fixture({ child: true, childWaitResumable: true, attemptCount: 3, maxAttempts: 3 })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toMatchObject([
      { id: "child-1", status: "queued", attemptCount: 3, nextAttemptAt: null },
    ])
    expect(fake.task).toMatchObject({ attemptCount: 3, status: "queued" })
    expect(fake.outbox).toMatchObject({ attemptCount: 4, publishedAt: null, lastError: null,
      payload: { taskId: "child-1", ownerId: expect.stringMatching(/^expired-child-wait-/) } })
    const waitProof = fake.calls.find(sql => sql.includes('AS "childWaitResumable"')) ?? ""
    expect(waitProof).toContain('task."status" = \'running\'')
    expect(waitProof).toContain('step."attempt" = task."attemptCount"')
    expect(waitProof).toContain('continuation."attempt" = task."attemptCount" AND continuation."ordinal" = step."ordinal" + 1')
    expect(waitProof).toContain('step."ordinal" + 1 = (SELECT MAX(currentStep."ordinal")')
    expect(waitProof).toContain('wait."status" IN (\'ready\', \'timed_out\') AND wait."suspendedAt" IS NOT NULL')
    expect(waitProof).toContain('wait."consumedAt" IS NULL AND step."status" = \'waiting_for_tool\'')
    expect(waitProof.match(/wait\."consumedAt" IS NULL/g)).toHaveLength(1)
    expect(waitProof).toContain('waitTurn."userId" = $3 AND waitTurn."rootTaskId" = task."rootTaskId"')
    const taskUpdate = fake.calls.find(sql => sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $3')) ?? ""
    expect(taskUpdate.split("WHERE")[0]).not.toContain('"attemptCount"')
    const dispatchUpdate = fake.calls.find(sql => sql.startsWith('UPDATE "agent_outbox" SET "payload"')) ?? ""
    expect(dispatchUpdate).toContain('"attemptCount" = $5')
    expect(dispatchUpdate).toContain('"publishedAt" IS NOT NULL')
    expect(dispatchUpdate).toContain('"payload" = $6::jsonb')
    expect(dispatchUpdate).not.toContain('SET "attemptCount"')
  })

  it("keeps ordinary expired tasks terminal at the attempt ceiling", async () => {
    const fake = fixture({ child: true, attemptCount: 3, maxAttempts: 3 })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toMatchObject([
      { id: "child-1", status: "failed", attemptCount: 3 },
    ])
    expect(fake.calls.some(sql => sql.includes('FROM "agent_outbox" AS dispatch') && sql.includes("FOR UPDATE"))).toBe(false)
  })

  it("does not bypass an unsettled call when the exact continuation outbox fence is stale", async () => {
    const fake = fixture({ child: true, childWaitResumable: true, pendingCall: true, outboxOwnerId: "stale-owner", attemptCount: 3, maxAttempts: 3 })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toEqual([])
    expect(fake.calls.some(sql => sql.includes('FROM "agent_events" AS started'))).toBe(true)
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "agent_outbox" SET "payload"'))).toBe(false)
  })

  it("replays an acknowledged same-attempt continuation at maxAttempts without ordinary retry", async () => {
    const fake = fixture({ child: true, childWaitResumable: true, continuationWait: true, attemptCount: 3, maxAttempts: 3 })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toMatchObject([
      { id: "child-1", status: "queued", attemptCount: 3, nextAttemptAt: null },
    ])
    expect(fake.wait).toMatchObject({ status: "ready", suspendedAt: checkedAt, consumedAt: checkedAt })
    expect(fake.outbox.payload.ownerId).not.toBe("worker-1")
    const proof = fake.calls.find(sql => sql.includes('AS "childWaitResumable"')) ?? ""
    expect(proof).toContain('step."attempt" = task."attemptCount"')
    expect(proof).toContain('continuation."attempt" = task."attemptCount" AND continuation."ordinal" = step."ordinal" + 1')
    expect(proof).toContain('step."ordinal" + 1 = (SELECT MAX(currentStep."ordinal")')
    expect(fake.calls.some(sql => sql.includes('FROM "agent_events" AS started'))).toBe(true)
  })

  it("does not replay a consumed continuation while a model call remains unsettled", async () => {
    const fake = fixture({ child: true, childWaitResumable: true, continuationWait: true, pendingCall: true, attemptCount: 3, maxAttempts: 3 })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toEqual([])
    expect(fake.calls.some(sql => sql.includes('FROM "agent_events" AS started'))).toBe(true)
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "agent_outbox" SET "payload"'))).toBe(false)
  })

  it("does not grant attempt-neutral replay to a prior-attempt consumed wait", async () => {
    const fake = fixture({ child: true, childWaitResumable: false, continuationWait: true, attemptCount: 3, maxAttempts: 3 })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toMatchObject([
      { id: "child-1", status: "failed", attemptCount: 3 },
    ])
    expect(fake.wait.consumedAt).toEqual(checkedAt)
    const proof = fake.calls.find(sql => sql.includes('AS "childWaitResumable"')) ?? ""
    expect(proof).toContain('step."attempt" = task."attemptCount"')
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "agent_outbox" SET "payload"'))).toBe(false)
  })

  it("suspends the exact unsuspended wait after a crash before finish without consuming an attempt", async () => {
    const fake = fixture({ child: true, attemptCount: 3, maxAttempts: 3, registeredWait: true, pendingCall: true })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toMatchObject([
      { id: "child-1", status: "waiting", attemptCount: 3, nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null },
    ])
    expect(fake.task).toMatchObject({ status: "waiting", attemptCount: 3 })
    expect(fake.wait).toMatchObject({ status: "waiting", suspendedAt: checkedAt, consumedAt: null })
    expect(fake.wait.result).toMatchObject({ request: { targetTaskIds: ["target-1"], mode: "any", timeoutMs: 10_000 }, outcome: { waitId: "wait-1", status: "waiting" } })
    const persistedCallRead = fake.client.query.mock.calls.find(([sql]) => sql.includes('FROM "agent_items" AS call'))
    expect(persistedCallRead?.[0]).toContain('call."type" = \'tool_call\'')
    expect(persistedCallRead?.[0]).toContain('call."stepId" = $4')
    expect(fake.client.query.mock.calls.filter(([sql]) => sql.includes('FROM "agent_items" AS call'))).toHaveLength(1)
    expect(fake.calls.some(sql => sql.includes('FROM "agent_events" AS started'))).toBe(false)
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "agent_outbox" SET "payload"'))).toBe(false)
    const repair = fake.client.query.mock.calls.find(([sql]) => sql.includes('SELECT task."id", task."parentTaskId"'))
    expect(repair?.[0]).toContain('task."leaseOwner" = $6 AND task."attemptCount" = $7 AND task."leaseExpiresAt" = $8')
    expect(repair?.[1]).toEqual(["child-1", "session-1", "turn-1", "root-1", "user-1", "worker-1", 3, fake.task.leaseExpiresAt])
    const taskUpdate = fake.client.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $1'))
    expect(taskUpdate?.[1]?.slice(0, 1)).toEqual(["waiting"])
    expect(taskUpdate?.[0]).toContain('"leaseOwner" = $7 AND "attemptCount" = $8 AND "leaseExpiresAt" = $9')
    expect(taskUpdate?.[1]).toEqual(["waiting", checkedAt, "child-1", "session-1", "turn-1", "root-1", "worker-1", 3, fake.task.leaseExpiresAt])
  })

  it.each([
    { label: "resolved target", targetStatus: "completed", expected: "ready" },
    { label: "elapsed timeout", deadlineElapsed: true, expected: "timed_out" },
  ])("requeues a recovered $label with a new dispatch owner and the same attempt", async ({ targetStatus, deadlineElapsed, expected }) => {
    const fake = fixture({ child: true, attemptCount: 3, maxAttempts: 3, registeredWait: true, targetStatus })
    if (deadlineElapsed) fake.wait.deadlineAt = new Date(checkedAt.getTime() - 1)
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toMatchObject([
      { id: "child-1", status: "queued", attemptCount: 3, nextAttemptAt: null },
    ])
    expect(fake.task).toMatchObject({ status: "queued", attemptCount: 3 })
    expect(fake.wait).toMatchObject({ status: expected, suspendedAt: checkedAt, consumedAt: null })
    expect(fake.outbox.payload).toMatchObject({ taskId: "child-1", sessionId: "session-1", rootTaskId: "root-1" })
    expect(fake.outbox.payload.ownerId).not.toBe("worker-1")
    expect(fake.calls.some(sql => sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(true)
    expect(fake.client.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE "agent_outbox" SET "payload"'))).toBe(false)
  })

  it("does not repair a wait when the persisted call identity is different", async () => {
    const fake = fixture({ child: true, attemptCount: 3, maxAttempts: 3, registeredWait: true, callMatches: false, pendingCall: true })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toEqual([])
    expect(fake.wait.suspendedAt).toBeNull()
    expect(fake.task.status).toBe("running")
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "agent_wait_conditions"'))).toBe(false)
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
  })

  it("falls through when the expired owner fence no longer matches", async () => {
    const fake = fixture({ child: true, attemptCount: 3, maxAttempts: 3, registeredWait: true, recoveryLeaseLost: true, pendingCall: true })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toEqual([])
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "agent_wait_conditions"'))).toBe(false)
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.some(sql => sql.includes('FROM "agent_events" AS started'))).toBe(true)
  })

  it.each([
    { label: "a stale owner", options: { outboxOwnerId: "old-owner" } },
    { label: "an unpublished generation", options: { dispatchPublished: false } },
  ])("does not requeue an exhausted child wait with $label", async ({ options }) => {
    const fake = fixture({ child: true, childWaitResumable: true, attemptCount: 3, maxAttempts: 3, ...options })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toMatchObject([
      { id: "child-1", status: "failed", attemptCount: 3 },
    ])
    expect(fake.task.status).toBe("failed")
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "agent_outbox"'))).toBe(false)
    expect(fake.outbox.publishedAt === null).toBe(options.dispatchPublished === false)
  })

  it("bounds pause recovery to the exact Session and Turn", async () => {
    const fake = fixture()
    await recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10, sessionId: "session-1", turnId: "turn-1" })
    const scan = fake.calls.find(sql => sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("LIMIT $1")) ?? ""
    expect(scan).toContain('task."sessionId" = $2')
    expect(scan).toContain('task."turnId" = $3')
    const scanCall = fake.client.query.mock.calls.find(([sql]) => sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("LIMIT $1"))
    expect(scanCall?.[1]).toEqual([10, "session-1", "turn-1"])
  })
})
