import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { SessionPauseRequestedError } from "../session-gate.js"
import { claimSubagentTask, matchesPublishedSubagentDispatch } from "./pg-store-claim.js"
import { PAUSE_DEFERRED_MARKER, normalizeSubagentPolicy, type SubagentJobPayload } from "./types.js"
import { parseSubagentDispatchJobId, SUBAGENT_DISPATCH_IDENTITY_MISMATCH, subagentDispatchJobId } from "./dispatch-identity.js"

const input = {
  taskId: "child-1", sessionId: "session-1", ownerId: "worker-1", rootTaskId: "root-1",
  policy: normalizeSubagentPolicy({ maxConcurrency: 2 }), now: new Date("2026-10-06T10:00:00Z"),
}

type DeferredFence = { lastError: string | null; payload?: unknown; publishedAt?: unknown; attemptCount?: unknown }
function poolFixture(options: { pause?: boolean; rootInterrupted?: boolean; turnUnavailable?: boolean; childWaitResumable?: boolean; taskAttemptCount?: number; maxAttempts?: number; outbox?: DeferredFence } = {}) {
  const calls: string[] = []
  const parameters: Array<unknown[] | undefined> = []
  const outbox = options.outbox ? { id: "dispatch-1", ...options.outbox, payload: options.outbox.payload ?? { taskId: "child-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "worker-1" } } : null
  const task = { id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
    path: "/root-1/child-1", depth: 1, role: "analyst", taskType: "test", status: "running", goal: "inspect", constraints: [],
    successCriteria: [], allowedActions: [], context: {}, expectedOutputSchema: {}, attemptCount: options.taskAttemptCount ?? 1, maxAttempts: options.maxAttempts ?? 3,
    leaseOwner: "worker-1", leaseExpiresAt: new Date("2026-10-06T10:01:00Z"), interruptRequestedAt: null }
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push(sql)
      parameters.push(params)
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 1 }
      if (sql.includes('SELECT "userId" FROM "agent_sessions"')) return { rows: [{ userId: "user-1" }], rowCount: 1 }
      if (sql.includes('FROM "agent_outbox" AS dispatch') && sql.includes('JOIN "agent_sessions" AS session')) return outbox
        ? { rows: [{ payload: outbox.payload, attemptCount: outbox.attemptCount, publishedAt: outbox.publishedAt }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_sessions" AS session') && sql.includes("FOR UPDATE")) return { rows: [{ id: "session-1", userId: "user-1", status: "running" }], rowCount: 1 }
      if (sql.includes('SELECT set_config')) return { rows: [], rowCount: 1 }
      if (sql.includes('SELECT "turnId", "rootTaskId"')) return { rows: [{ turnId: "turn-1", rootTaskId: "root-1" }], rowCount: 1 }
      if (sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE")) return options.turnUnavailable
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id: "turn-1" }], rowCount: 1 }
      if (sql.includes('SELECT "id", "turnId", "status", "interruptRequestedAt"')) return { rows: [{ id: "root-1", turnId: "turn-1", status: "running", interruptRequestedAt: options.rootInterrupted ? new Date() : null }], rowCount: 1 }
      if (sql.includes('SELECT "id", "turnId", "rootTaskId", "status", "interruptRequestedAt"')) return { rows: [{ id: "child-1", turnId: "turn-1", rootTaskId: "root-1", status: "queued", interruptRequestedAt: null }], rowCount: 1 }
      if (sql.includes('SELECT session."id" FROM "agent_sessions"')) return options.pause ? { rows: [], rowCount: 0 } : { rows: [{ id: "session-1" }], rowCount: 1 }
      if (sql.includes('FROM "agent_outbox" AS dispatch') && sql.includes("FOR UPDATE")) return outbox ? { rows: [outbox], rowCount: 1 } : { rows: [], rowCount: 0 }
      if (sql.includes("COUNT(*)::int")) return { rows: [{ count: 0 }], rowCount: 1 }
      if (sql.includes('SELECT task."turnId", task."rootTaskId"')) return { rows: [{ turnId: "turn-1", rootTaskId: "root-1", parentTaskId: null, attemptCount: 0, userId: "user-1" }], rowCount: 1 }
      if (sql.startsWith('UPDATE "sub_agent_tasks"')) {
        const exactWait = options.childWaitResumable === true
        const currentDispatch = params?.[7] === true
        const exhausted = (options.taskAttemptCount ?? 1) >= (options.maxAttempts ?? 3)
        return { rows: [], rowCount: exactWait && !currentDispatch || exhausted && !currentDispatch ? 0 : 1 }
      }
      if (sql.startsWith('UPDATE "agent_outbox" SET "lastError" = NULL')) { if (outbox) outbox.lastError = null; return { rows: [], rowCount: 1 } }
      if (sql.startsWith("SELECT task.*")) return { rows: [task], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as Pick<pg.Pool, "connect">, calls, parameters, client, outbox }
}

describe("atomic child claim pause fence", () => {
  it("locks Session and Turn, checks fresh admission, then locks root and child before incrementing attempt", async () => {
    const fake = poolFixture()
    await expect(claimSubagentTask(fake.pool, input, 60_000)).resolves.toMatchObject({ id: "child-1", attemptCount: 1 })
    const at = (part: string) => fake.calls.findIndex(sql => sql.includes(part))
    const session = at('FROM "agent_sessions" AS session')
    const turn = at('FROM "agent_turns"')
    const admission = at('SELECT session."id" FROM "agent_sessions"')
    const root = at('SELECT "id", "turnId", "status", "interruptRequestedAt"')
    const child = at('SELECT "id", "turnId", "rootTaskId", "status", "interruptRequestedAt"')
    const update = fake.calls.findIndex(sql => sql.startsWith('UPDATE "sub_agent_tasks"'))
    expect(session).toBeLessThan(turn)
    expect(turn).toBeLessThan(admission)
    expect(admission).toBeLessThan(root)
    expect(root).toBeLessThan(child)
    expect(admission).toBeLessThan(update)
  })

  it("does not claim or spend an attempt when pause admission is denied", async () => {
    const fake = poolFixture({ pause: true })
    await expect(claimSubagentTask(fake.pool, input, 60_000)).rejects.toBeInstanceOf(SessionPauseRequestedError)
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.at(-1)).toBe("ROLLBACK")
  })

  it("returns the existing non-admission result for an unavailable Turn before claim writes", async () => {
    const fake = poolFixture({ turnUnavailable: true })
    await expect(claimSubagentTask(fake.pool, input, 60_000)).resolves.toBeNull()
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.some(sql => sql.includes("COUNT(*)::int"))).toBe(false)
    expect(fake.calls.at(-1)).toBe("COMMIT")
  })

  it("does not claim a child after the locked root has been interrupted", async () => {
    const fake = poolFixture({ rootInterrupted: true })
    await expect(claimSubagentTask(fake.pool, input, 60_000)).resolves.toBeNull()
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
  })

  it("rejects a stale deferred delivery owner atomically before spending an attempt", async () => {
    const payload: SubagentJobPayload = { taskId: "child-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "new-generation-owner" }
    const fake = poolFixture({ outbox: { lastError: PAUSE_DEFERRED_MARKER, payload } })
    await expect(claimSubagentTask(fake.pool, input, 60_000)).resolves.toBeNull()
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
    const task = fake.calls.findIndex(sql => sql.includes('SELECT "id", "turnId", "rootTaskId", "status", "interruptRequestedAt"'))
    const fence = fake.calls.findIndex(sql => sql.includes('FROM "agent_outbox" AS dispatch'))
    expect(fence).toBeGreaterThan(task)
    expect(fake.calls.at(-1)).toBe("COMMIT")
  })

  it("allows the current deferred owner and retains its fence across the claim", async () => {
    const fake = poolFixture({ outbox: { lastError: PAUSE_DEFERRED_MARKER } })
    await expect(claimSubagentTask(fake.pool, input, 60_000)).resolves.toMatchObject({ id: "child-1", attemptCount: 1 })
    expect(fake.outbox?.lastError).toBe(PAUSE_DEFERRED_MARKER)
    const fence = fake.calls.findIndex(sql => sql.includes('FROM "agent_outbox" AS dispatch'))
    const claim = fake.calls.findIndex(sql => sql.startsWith('UPDATE "sub_agent_tasks"'))
    expect(fence).toBeLessThan(claim)
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "agent_outbox" SET "lastError" = NULL'))).toBe(false)
  })

  it("resumes an exact durable child wait at the current attempt and keeps the outbox generation separate", async () => {
    const identity = parseSubagentDispatchJobId(subagentDispatchJobId(input.taskId, 3), input.taskId)
    if (!identity) throw new Error("Fixture dispatch ID did not parse")
    const fake = poolFixture({ childWaitResumable: true, taskAttemptCount: 3, maxAttempts: 3,
      outbox: { lastError: null, publishedAt: new Date("2026-10-06T09:59:00Z"), attemptCount: 4 } })
    await expect(claimSubagentTask(fake.pool, { ...input, dispatchIdentity: identity }, 60_000)).resolves.toMatchObject({ id: "child-1", attemptCount: 3 })
    const update = fake.calls.find(sql => sql.startsWith('UPDATE "sub_agent_tasks"')) ?? ""
    expect(update).toContain('"attemptCount" = CASE WHEN $8::boolean AND (SELECT COUNT(*) = 1')
    expect(update).toContain('task."parentTaskId" IS NOT NULL AND task."status" = \'queued\'')
    expect(update).toContain('step."attempt" = task."attemptCount"')
    expect(update).toContain('step."status" = \'waiting_for_tool\'')
    expect(update).toContain('step."ordinal" = (SELECT MAX(currentStep."ordinal")')
    expect(update).toContain('currentStep."attempt" = task."attemptCount"')
    expect(update).not.toContain(`task."attemptCount'`)
    expect(update).toContain('continuation."ordinal" = step."ordinal" + 1')
    expect(update).toContain('step."ordinal" + 1 = (SELECT MAX(currentStep."ordinal")')
    expect(update).toContain('step."status" IN (\'waiting_for_tool\', \'completed\')')
    expect(update).toContain('wait."id" = (SELECT currentWait."id"')
    expect(update).toContain('wait."status" IN (\'ready\', \'timed_out\') AND wait."suspendedAt" IS NOT NULL')
    expect(update).toContain('wait."consumedAt" IS NULL AND step."status" = \'waiting_for_tool\'')
    expect(update.match(/wait\."consumedAt" IS NULL/g)).toHaveLength(3)
    expect(update).toContain('"attemptCount" < "maxAttempts" OR ($8::boolean AND (SELECT COUNT(*) = 1')
    expect(update).toContain('AND (NOT (SELECT COUNT(*) = 1')
    expect(fake.parameters[fake.calls.indexOf(update)]).toEqual(["child-1", "session-1", "worker-1", 60_000, "turn-1", "root-1", "user-1", true])
    expect(fake.outbox).toMatchObject({ attemptCount: 4 })
  })

  it("does not let a direct claim resume a persisted wait without the current published dispatch identity", async () => {
    const fake = poolFixture({ childWaitResumable: true, taskAttemptCount: 3, maxAttempts: 3 })
    await expect(claimSubagentTask(fake.pool, input, 60_000)).resolves.toBeNull()
    const update = fake.calls.find(sql => sql.startsWith('UPDATE "sub_agent_tasks"')) ?? ""
    expect(update).toContain('AND (NOT (SELECT COUNT(*) = 1')
    expect(fake.parameters[fake.calls.indexOf(update)]?.[7]).toBe(false)
  })

  it("preserves ordinary outbox and direct-claim owner compatibility", async () => {
    const fake = poolFixture({ outbox: { lastError: "queue_add_failed", payload: { taskId: "child-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "normal-outbox-owner" } } })
    await expect(claimSubagentTask(fake.pool, input, 60_000)).resolves.toMatchObject({ id: "child-1" })
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(true)
  })

  it("accepts only the exact published outbox generation before counting or mutating a task", async () => {
    const identity = parseSubagentDispatchJobId(subagentDispatchJobId(input.taskId, 2), input.taskId)
    if (!identity) throw new Error("Fixture dispatch ID did not parse")
    const fake = poolFixture({ outbox: { lastError: null, publishedAt: new Date("2026-10-06T09:59:00Z"), attemptCount: 3 } })

    await expect(claimSubagentTask(fake.pool, { ...input, dispatchIdentity: identity }, 60_000))
      .resolves.toMatchObject({ id: "child-1", attemptCount: 1 })
    const dispatch = fake.calls.findIndex(sql => sql.includes('FROM "agent_outbox" AS dispatch'))
    const running = fake.calls.findIndex(sql => sql.includes("COUNT(*)::int"))
    const update = fake.calls.findIndex(sql => sql.startsWith('UPDATE "sub_agent_tasks"'))
    expect(dispatch).toBeGreaterThan(-1)
    expect(dispatch).toBeLessThan(running)
    expect(running).toBeLessThan(update)
    expect(fake.outbox).toMatchObject({ attemptCount: 3, lastError: null, publishedAt: new Date("2026-10-06T09:59:00Z") })
  })

  it.each([
    { label: "missing outbox", identityTaskId: input.taskId },
    { label: "unpublished outbox", identityTaskId: input.taskId, outbox: { lastError: null, publishedAt: null, attemptCount: 3 } },
    { label: "stale generation", identityTaskId: input.taskId, outbox: { lastError: null, publishedAt: new Date("2026-10-06T09:59:00Z"), attemptCount: 2 } },
    { label: "wrong published owner", identityTaskId: input.taskId, outbox: { lastError: null, publishedAt: new Date("2026-10-06T09:59:00Z"), attemptCount: 3, payload: { taskId: "child-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "other-worker" } } },
    { label: "malformed published payload", identityTaskId: input.taskId, outbox: { lastError: null, publishedAt: new Date("2026-10-06T09:59:00Z"), attemptCount: 3, payload: { taskId: "child-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "worker-1", extra: true } } },
    { label: "wrong task identity", identityTaskId: "other-task", outbox: { lastError: null, publishedAt: new Date("2026-10-06T09:59:00Z"), attemptCount: 3 } },
  ] as const)("rejects $label before claim writes", async ({ identityTaskId, outbox }) => {
    const identity = parseSubagentDispatchJobId(subagentDispatchJobId(identityTaskId, 2), identityTaskId)
    if (!identity) throw new Error("Fixture dispatch ID did not parse")
    const fake = poolFixture(outbox ? { outbox } : {})
    const originalOutbox = fake.outbox ? { ...fake.outbox } : null

    await expect(claimSubagentTask(fake.pool, { ...input, dispatchIdentity: identity }, 60_000))
      .rejects.toMatchObject({ code: SUBAGENT_DISPATCH_IDENTITY_MISMATCH })
    expect(fake.calls.some(sql => sql.includes("COUNT(*)::int"))).toBe(false)
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(fake.outbox).toEqual(originalOutbox)
    expect(fake.calls.at(-1)).toBe("ROLLBACK")
  })

  it("uses a SELECT-only owner-scoped read to recognize the current published generation", async () => {
    const identity = parseSubagentDispatchJobId(subagentDispatchJobId(input.taskId, 2), input.taskId)
    if (!identity) throw new Error("Fixture dispatch ID did not parse")
    const fake = poolFixture({ outbox: { lastError: null, publishedAt: new Date("2026-10-06T09:59:00Z"), attemptCount: 3 } })
    const payload: SubagentJobPayload = { taskId: input.taskId, sessionId: input.sessionId, rootTaskId: input.rootTaskId, ownerId: input.ownerId }

    await expect(matchesPublishedSubagentDispatch(fake.pool, { payload, dispatchIdentity: identity })).resolves.toBe(true)
    expect(fake.calls.some(sql => sql.includes('SELECT "userId" FROM "agent_sessions"'))).toBe(true)
    const dispatchIndex = fake.calls.findIndex(sql => sql.includes('FROM "agent_outbox" AS dispatch') && sql.includes('JOIN "agent_sessions" AS session'))
    expect(dispatchIndex).toBeGreaterThan(-1)
    expect(fake.parameters[dispatchIndex]).toEqual([input.sessionId, input.taskId, input.rootTaskId, "user-1"])
    expect(fake.calls[dispatchIndex]).toMatch(/JOIN "sub_agent_tasks" AS task[\s\S]*JOIN "agent_turns" AS turn/)
    expect(fake.calls.every(sql => !/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(true)
    expect(fake.calls.at(-1)).toBe("COMMIT")
  })

  it.each([
    { label: "missing dispatch", outbox: undefined },
    { label: "stale generation", outbox: { lastError: null, publishedAt: new Date("2026-10-06T09:59:00Z"), attemptCount: 2 } },
    { label: "unpublished dispatch", outbox: { lastError: null, publishedAt: null, attemptCount: 3 } },
    { label: "different owner tuple", outbox: { lastError: null, publishedAt: new Date("2026-10-06T09:59:00Z"), attemptCount: 3, payload: { taskId: "child-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "other-worker" } } },
    { label: "malformed payload", outbox: { lastError: null, publishedAt: new Date("2026-10-06T09:59:00Z"), attemptCount: 3, payload: { taskId: "child-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "worker-1", extra: true } } },
  ] as const)("returns false for a read-only $label mismatch", async ({ outbox }) => {
    const identity = parseSubagentDispatchJobId(subagentDispatchJobId(input.taskId, 2), input.taskId)
    if (!identity) throw new Error("Fixture dispatch ID did not parse")
    const fake = poolFixture(outbox ? { outbox } : {})
    const payload: SubagentJobPayload = { taskId: input.taskId, sessionId: input.sessionId, rootTaskId: input.rootTaskId, ownerId: input.ownerId }

    await expect(matchesPublishedSubagentDispatch(fake.pool, { payload, dispatchIdentity: identity })).resolves.toBe(false)
    expect(fake.calls.every(sql => !/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(true)
    expect(fake.calls.at(-1)).toBe("COMMIT")
  })
})
