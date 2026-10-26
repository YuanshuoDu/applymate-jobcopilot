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
type CandidateRow = Readonly<{ id: string; sessionId: string; rootTaskId: string | null; turnId: string | null; userId: string;
  cursorRootIsNull: boolean; cursorRootKey: string }>
type FixtureOptions = { pendingCall?: boolean; candidate?: boolean; childWaitResumable?: boolean; attemptCount?: number;
  maxAttempts?: number; child?: boolean; outboxOwnerId?: string; dispatchPublished?: boolean; rearmCount?: number;
  registeredWait?: boolean; targetStatus?: string; callMatches?: boolean; recoveryLeaseLost?: boolean; continuationWait?: boolean;
  exactWaitCall?: boolean; unrelatedPendingCall?: boolean; preinsertWaitCall?: boolean; unconsumedContinuation?: boolean;
  unconsumedNoContinuation?: boolean; pendingModelStart?: "exact" | "wrong-correlation" | "wrong-actor" | "wrong-item" | "wrong-key" | "wrong-payload";
  pendingToolStart?: boolean; waitCallStatus?: string; candidatePages?: readonly (readonly CandidateRow[])[]; blockedCandidateIds?: readonly string[];
  missingSessionCandidateIds?: readonly string[]; missingPreviewCandidateIds?: readonly string[]; throwCandidateIds?: readonly string[];
  waitStepStatus?: "streaming" | "waiting_for_tool" }
function scanCandidate(id: string, sessionId = "session-1", rootTaskId: string | null = "root-1", turnId: string | null = "turn-1"): CandidateRow {
  return { id, sessionId, rootTaskId, turnId, userId: "user-1", cursorRootIsNull: rootTaskId === null, cursorRootKey: rootTaskId ?? "" }
}
function fixture(options: FixtureOptions = {}) {
  const calls: string[] = []
  const task = { id: options.child ? "child-1" : "task-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1" as string | null, rootTaskId: (options.child ? "root-1" : "task-1") as string | null, parentTaskId: options.child ? "root-1" : null,
    path: "/task-1", depth: 0, role: "scout", taskType: "scout", status: "running", goal: "inspect", constraints: [], successCriteria: [],
    allowedActions: [], context: {}, expectedOutputSchema: {}, result: null, failureReason: null, attemptCount: options.attemptCount ?? 1, maxAttempts: options.maxAttempts ?? 3,
    leaseOwner: "worker-1" as string | null, leaseExpiresAt: new Date(checkedAt.getTime() - 1_000) as Date | null, nextAttemptAt: null as Date | null, interruptRequestedAt: null,
    budgetSnapshot: {}, toolPolicySnapshot: {} }
  const outbox = { id: "dispatch-1", topic: "agent.subagent.dispatch", aggregateId: task.sessionId,
    idempotencyKey: `subagent-dispatch:${task.id}`, payload: { taskId: task.id, sessionId: task.sessionId,
      rootTaskId: task.rootTaskId, ownerId: options.outboxOwnerId ?? task.leaseOwner }, attemptCount: 4,
    publishedAt: options.dispatchPublished === false ? null : new Date(checkedAt.getTime() - 1_000), lastError: "previous_error" as string | null }
  const wait: { id: string; userId: string; sessionId: string; turnId: string | null; parentTaskId: string; stepId: string; idempotencyKey: string;
    targetTaskIds: string[]; mode: string; status: string; createdAt: Date; deadlineAt: Date; resolvedAt: Date | null; matchedTaskIds: string[]; suspendedAt: Date | null;
    consumedAt: Date | null; result: Record<string, unknown> } = { id: "wait-1", userId: task.userId, sessionId: task.sessionId, turnId: task.turnId, parentTaskId: task.id,
    stepId: "step-1", idempotencyKey: "wait-key-1", targetTaskIds: ["target-1"], mode: "any", status: options.continuationWait || options.unconsumedContinuation || options.unconsumedNoContinuation ? "ready" : "waiting",
    createdAt: checkedAt, deadlineAt: new Date(checkedAt.getTime() + 10_000), resolvedAt: null, matchedTaskIds: [] as string[],
    suspendedAt: options.continuationWait || options.unconsumedContinuation || options.unconsumedNoContinuation ? checkedAt : null as Date | null,
    consumedAt: options.continuationWait ? checkedAt : null as Date | null,
    result: { request: { targetTaskIds: ["target-1"], mode: "any", timeoutMs: 10_000 }, outcome: { status: "waiting" } } }
  if (options.childWaitResumable && !options.continuationWait) {
    wait.status = "ready"; wait.resolvedAt = checkedAt; wait.suspendedAt = checkedAt; wait.matchedTaskIds = ["target-1"]
    wait.result = { request: { targetTaskIds: ["target-1"], mode: "any", timeoutMs: 10_000 }, outcome: {
      waitId: wait.id, status: "ready", taskIds: ["target-1"], deadlineAt: wait.deadlineAt.toISOString(), matchedTaskIds: ["target-1"],
      tasks: [{ taskId: "target-1", status: options.targetStatus ?? "completed", role: "writer", result: null, failureReason: null }],
    } }
  }
  const candidatePageCalls: Array<{ sql: string; values: unknown[] }> = []
  const queuedCandidates: CandidateRow[] = []
  let pageIndex = 0
  const defaultCandidate = (): CandidateRow => ({ id: task.id, sessionId: task.sessionId, rootTaskId: task.rootTaskId,
    turnId: task.turnId, userId: task.userId, cursorRootIsNull: task.rootTaskId === null, cursorRootKey: task.rootTaskId ?? "" })
  const client = { query: vi.fn(async (sql: string, _values?: unknown[]) => {
    calls.push(sql)
    if (["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT subagent_expiry_recovery_candidate",
      "ROLLBACK TO SAVEPOINT subagent_expiry_recovery_candidate", "RELEASE SAVEPOINT subagent_expiry_recovery_candidate"].includes(sql)
      || sql.includes("set_config")) return { rows: [], rowCount: 1 }
    if (sql.startsWith('SELECT clock_timestamp() AS "scanHorizon"')) return { rows: [{ scanHorizon: checkedAt }], rowCount: 1 }
    if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("LIMIT $8")) {
      const values = [...(_values ?? [])]
      candidatePageCalls.push({ sql, values })
      const page = options.candidatePages ? options.candidatePages[pageIndex++] ?? []
        : options.candidate === false ? [] : [defaultCandidate()]
      queuedCandidates.push(...page)
      return { rows: page, rowCount: page.length }
    }
    if (sql.startsWith('SELECT "id", "userId", "status" FROM "agent_sessions"') && sql.includes("FOR UPDATE")) {
      const candidate = queuedCandidates.shift()
      if (candidate) {
        task.id = candidate.id; task.sessionId = candidate.sessionId; task.turnId = candidate.turnId
        task.rootTaskId = candidate.rootTaskId; task.parentTaskId = options.child ? candidate.rootTaskId : null
        task.status = "running"; task.leaseOwner = "worker-1"; task.leaseExpiresAt = new Date(checkedAt.getTime() - 1_000); task.nextAttemptAt = null
      }
      if (candidate && options.missingSessionCandidateIds?.includes(candidate.id)) return { rows: [], rowCount: 0 }
      return { rows: [{ id: task.sessionId, userId: task.userId, status: "running" }], rowCount: 1 }
    }
    if (sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE")) return { rows: [{ id: task.turnId }], rowCount: 1 }
    if (sql.includes('session."status" AS "sessionStatus"')) {
      if (options.missingPreviewCandidateIds?.includes(String(_values?.[0]))) return { rows: [], rowCount: 0 }
      return { rows: [{ ...task, sessionStatus: "running", rootStatus: "running", rootInterruptRequestedAt: null,
      childWaitResumable: options.childWaitResumable ?? false, childWaitContinuationId: options.continuationWait ? "continuation-1" : null }], rowCount: 1 }
    }
    if (sql.startsWith('SELECT task.*') && sql.includes("FOR UPDATE OF task")) return { rows: [{ ...task, sessionStatus: "running", rootStatus: "running", rootInterruptRequestedAt: null,
      childWaitResumable: options.childWaitResumable ?? false, childWaitContinuationId: options.continuationWait ? "continuation-1" : null }], rowCount: 1 }
    if (sql.includes('SELECT task."id", task."parentTaskId"') && sql.includes("FOR UPDATE OF task")) return options.recoveryLeaseLost
      ? { rows: [], rowCount: 0 } : { rows: [{ ...task, turnStatus: "in_progress", rootStatus: "running" }], rowCount: 1 }
    if (sql.startsWith('SELECT wait.*, task."status" AS "repairTaskStatus"')) return options.childWaitResumable && !options.continuationWait ? { rows: [{ ...wait,
      repairTaskStatus: "running", repairLeaseOwner: task.leaseOwner, repairTaskAttempt: task.attemptCount, repairLeaseExpiresAt: task.leaseExpiresAt,
      repairInterruptAt: null, repairNextAttemptAt: null, repairUserId: task.userId, repairSessionStatus: "running", repairTurnStatus: "in_progress",
      repairRootStatus: "running", repairRootInterruptAt: null, repairAttempt: task.attemptCount, repairOrdinal: 4,
      repairLatestOrdinal: options.unconsumedContinuation ? 5 : 4, repairNextStatus: options.unconsumedContinuation ? "streaming" : null,
      repairNextOrdinal: options.unconsumedContinuation ? 5 : null, repairStepStatus: options.unconsumedContinuation ? "completed" : "waiting_for_tool",
    }], rowCount: 1 } : { rows: [], rowCount: 0 }
    if (sql.includes('FROM "agent_items" AS call') && sql.includes('AS "eventCreatedAt"')) return { rows: options.exactWaitCall ? [{
      callId: "wait-call-item", callSessionId: task.sessionId, callTurnId: task.turnId, callTaskId: task.id, callStepId: wait.stepId, status: options.waitCallStatus ?? "started",
      content: { toolCallId: "wait-call-1", toolName: "wait_subagents", toolVersion: "1", input: { idempotencyKey: wait.idempotencyKey,
        mode: wait.mode, taskIds: wait.targetTaskIds, timeoutMs: 10_000 } }, eventId: "start-event", eventSessionId: task.sessionId,
      eventTurnId: task.turnId, eventTaskId: task.id, eventItemId: "wait-call-item", eventCorrelationId: "wait-call-1",
      eventCreatedAt: new Date(checkedAt.getTime() - 5_000),
    }] : [], rowCount: options.exactWaitCall ? 1 : 0 }
    if (sql.includes('FROM "sub_agent_tasks" AS child') && sql.includes("ANY($1::text[])")) return { rows: [{
      id: "target-1", parentTaskId: task.id, rootTaskId: task.rootTaskId, turnId: task.turnId, sessionId: task.sessionId,
      status: options.targetStatus ?? (options.childWaitResumable ? "completed" : "running"), role: "writer", result: null, failureReason: null, userId: task.userId,
    }], rowCount: 1 }
    if (sql.includes('FROM "agent_wait_conditions" AS wait JOIN "agent_steps" AS step') && sql.includes('wait."status" = \'waiting\'')) return options.registeredWait
      ? { rows: [{ ...wait, attempt: task.attemptCount, ordinal: 4, latestOrdinal: 4, stepStatus: options.waitStepStatus ?? "waiting_for_tool" }], rowCount: 1 } : { rows: [], rowCount: 0 }
    if (sql.includes('started."createdAt"') && sql.includes("FOR UPDATE OF task, step, call")) return options.preinsertWaitCall ? { rows: [{
      eventId: "start-event", createdAt: new Date(checkedAt.getTime() - 5_000), role: task.role, allowedActions: ["wait_subagents"], stepId: "step-1",
      content: { toolCallId: "wait-call-1", toolName: "wait_subagents", toolVersion: "1", input: { idempotencyKey: "wait-key-1", mode: "any", taskIds: ["target-1"], timeoutMs: 10_000 } },
    }], rowCount: 1 } : { rows: [], rowCount: 0 }
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
    if (sql.includes('FROM "agent_events" AS started')) {
      if (options.throwCandidateIds?.includes(String(_values?.[1]))) throw new Error("candidate_failure")
      const blockedById = options.blockedCandidateIds?.includes(String(_values?.[1])) ?? false
      const exactWait = (options.continuationWait || options.unconsumedContinuation || options.unconsumedNoContinuation || options.registeredWait)
        && options.exactWaitCall && _values?.[8] !== "start-event"
      const exactModel = options.pendingModelStart === "exact" && _values?.[9] === "continuation-1"
      return blockedById || options.unrelatedPendingCall || options.recoveryLeaseLost || options.pendingToolStart
        || options.pendingModelStart && !exactModel
        || options.pendingCall && !exactWait && !exactModel && _values?.[8] !== "start-event"
        ? { rows: [{ id: "started-event" }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (sql.includes('FROM "agent_outbox" AS dispatch') && sql.includes("FOR UPDATE")) return { rows: [outbox], rowCount: 1 }
    if (sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $3')) {
      task.status = String(_values?.[2]); task.leaseOwner = null; task.leaseExpiresAt = null; task.nextAttemptAt = _values?.[3] as Date | null
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('UPDATE "agent_outbox" SET "payload"')) {
      if (options.rearmCount === 0) return { rows: [], rowCount: 0 }
      outbox.payload = JSON.parse(String(_values?.[0])) as typeof outbox.payload
      outbox.publishedAt = null
      outbox.lastError = null
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 1 }
  }), release: vi.fn() }
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as Pick<pg.Pool, "connect">, calls, candidatePageCalls, client, task, outbox, wait }
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
    const scan = fake.calls.find(sql => sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("LIMIT $8")) ?? ""
    expect(scan).toContain('task."leaseExpiresAt" <= $1')
    expect(scan).toContain('task."nextAttemptAt" <= $1')
    expect(scan).not.toContain('task."leaseExpiresAt" IS NULL')
    const eligibility = fake.calls.find(sql => sql.startsWith("SELECT task.*") && sql.includes("FOR UPDATE OF task")) ?? ""
    expect(eligibility).toContain('currentStep."attempt" = task."attemptCount"))))\n    AND wait."status" IN')
  })

  it("keeps an expired lease as a blocker when a model or tool start has no terminal event", async () => {
    const fake = fixture({ pendingCall: true })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toEqual([])
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.at(-1)).toBe("COMMIT")
  })

  it("pages past a safely blocked candidate, preserves filters, and caps successful recoveries", async () => {
    const fake = fixture({ child: true, blockedCandidateIds: ["blocked-1"], candidatePages: [
      [scanCandidate("blocked-1")], [scanCandidate("recovered-2")], [scanCandidate("not-scanned-3")],
    ] })
    await expect(recoverExpired(fake.pool as PgSubagentPool, {
      now: checkedAt, limit: 1, sessionId: "session-1", turnId: "turn-1",
    })).resolves.toMatchObject([{ id: "recovered-2", status: "queued" }])

    expect(fake.candidatePageCalls).toHaveLength(2)
    const [first, second] = fake.candidatePageCalls
    expect(first?.values).toEqual([checkedAt, "session-1", "turn-1", null, null, null, null, 1])
    expect(second?.values).toEqual([checkedAt, "session-1", "turn-1", "session-1", false, "root-1", "blocked-1", 1])
    for (const page of [first, second]) {
      expect(page?.sql).toContain('task."sessionId" = $2')
      expect(page?.sql).toContain('task."turnId" = $3')
      expect(page?.sql).toContain('task."leaseExpiresAt" <= $1')
      expect(page?.sql).toContain('task."nextAttemptAt" <= $1')
      expect(page?.sql).toContain('task."sessionId", (task."rootTaskId" IS NULL), COALESCE(task."rootTaskId", \'\'), task."id")')
    }
    expect(fake.calls.filter(sql => sql.startsWith('SELECT clock_timestamp() AS "scanHorizon"'))).toHaveLength(1)
    const taskUpdates = fake.client.query.mock.calls.filter(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $3'))
    expect(taskUpdates).toHaveLength(1)
    expect(taskUpdates[0]?.[1]?.[0]).toBe("recovered-2")
    expect(fake.calls.filter(sql => sql.includes("SAVEPOINT"))).toEqual([
      "SAVEPOINT subagent_expiry_recovery_candidate", "ROLLBACK TO SAVEPOINT subagent_expiry_recovery_candidate",
      "RELEASE SAVEPOINT subagent_expiry_recovery_candidate", "SAVEPOINT subagent_expiry_recovery_candidate",
      "RELEASE SAVEPOINT subagent_expiry_recovery_candidate",
    ])
  })

  it("advances through every rejected page and terminates when the fixed candidate scan is exhausted", async () => {
    const fake = fixture({ child: true, blockedCandidateIds: ["blocked-1", "blocked-2"], candidatePages: [
      [scanCandidate("blocked-1")], [scanCandidate("blocked-2")], [],
    ] })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 1 })).resolves.toEqual([])
    expect(fake.candidatePageCalls).toHaveLength(3)
    expect(fake.candidatePageCalls.map(page => page.values.slice(3, 7))).toEqual([
      [null, null, null, null],
      ["session-1", false, "root-1", "blocked-1"],
      ["session-1", false, "root-1", "blocked-2"],
    ])
    expect(fake.candidatePageCalls.every(page => page.values[0] === checkedAt && page.values[7] === 1)).toBe(true)
    expect(fake.client.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(fake.client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT")
  })

  it("traces bounded production candidate pages and a fixed target rejection stage only for a test target", async () => {
    const taskId = "synthetic-trace-target"
    const blockers = Array.from({ length: 10 }, (_, index) => `blocked-${index}`)
    const fake = fixture({ blockedCandidateIds: blockers, missingPreviewCandidateIds: [taskId], candidatePages: [
      blockers.map(id => scanCandidate(id)), [scanCandidate(taskId)],
    ] })
    const previousNodeEnv = process.env.NODE_ENV
    const previousTraceTarget = process.env.AGENT_RUNTIME_PG_TEST_RECOVERY_TRACE_TASK_ID
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined)
    process.env.NODE_ENV = "test"
    process.env.AGENT_RUNTIME_PG_TEST_RECOVERY_TRACE_TASK_ID = taskId
    try {
      await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toEqual([])
      const line = output.mock.calls.map(([value]) => String(value)).find(value => value.startsWith("WORKER_B_RECOVERY_PREDICATE_TRACE "))
      expect(line).toBeDefined()
      const trace = JSON.parse(line!.slice("WORKER_B_RECOVERY_PREDICATE_TRACE ".length))
      expect(trace).not.toHaveProperty("taskId")
      expect(trace).toMatchObject({ rejectionStage: "expiry_preview_rejected", childWaitResumable: null, waitProjectionDisposition: "skipped",
        pages: [{ page: 1, candidates: 10, targetSeen: false, cursorUsed: false },
          { page: 2, candidates: 1, targetSeen: true, cursorUsed: true }],
      })
    } finally {
      output.mockRestore()
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previousNodeEnv
      if (previousTraceTarget === undefined) delete process.env.AGENT_RUNTIME_PG_TEST_RECOVERY_TRACE_TASK_ID
      else process.env.AGENT_RUNTIME_PG_TEST_RECOVERY_TRACE_TASK_ID = previousTraceTarget
    }
  })

  it("adds wait-projection disposition and rejection stage to the test-only recovery trace", async () => {
    const previousNodeEnv = process.env.NODE_ENV
    const previousTraceTarget = process.env.AGENT_RUNTIME_PG_TEST_RECOVERY_TRACE_TASK_ID
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined)
    process.env.NODE_ENV = "test"
    process.env.AGENT_RUNTIME_PG_TEST_RECOVERY_TRACE_TASK_ID = "child-1"
    try {
      const fake = fixture({ child: true, childWaitResumable: true, targetStatus: "running" })
      await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toEqual([])
      const line = output.mock.calls.map(([value]) => String(value)).find(value => value.startsWith("WORKER_B_RECOVERY_PREDICATE_TRACE "))
      expect(line).toBeDefined()
      const trace = JSON.parse(line!.slice("WORKER_B_RECOVERY_PREDICATE_TRACE ".length))
      expect(trace).toMatchObject({
        rejectionStage: "durable_wait_graph_blocked",
        waitProjectionDisposition: "rejected",
        waitProjectionStage: "target_match_validation",
      })
      expect(trace).not.toHaveProperty("waitProjectionResult")
      expect(trace).not.toHaveProperty("taskId")
    } finally {
      output.mockRestore()
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previousNodeEnv
      if (previousTraceTarget === undefined) delete process.env.AGENT_RUNTIME_PG_TEST_RECOVERY_TRACE_TASK_ID
      else process.env.AGENT_RUNTIME_PG_TEST_RECOVERY_TRACE_TASK_ID = previousTraceTarget
    }
  })

  it("uses a non-null normalized root cursor for legacy candidates", async () => {
    const fake = fixture({ missingPreviewCandidateIds: ["legacy-orphan"], candidatePages: [
      [scanCandidate("legacy-orphan", "a-session", null)], [scanCandidate("recovered-2", "z-session", "root-z")],
    ] })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 1 })).resolves.toMatchObject([
      { id: "recovered-2", status: "queued" },
    ])
    expect(fake.candidatePageCalls).toHaveLength(2)
    expect(fake.candidatePageCalls[1]?.values.slice(3, 7)).toEqual(["a-session", true, "", "legacy-orphan"])
    expect(fake.candidatePageCalls[1]?.sql).toContain('ORDER BY task."sessionId", (task."rootTaskId" IS NULL), COALESCE(task."rootTaskId", \'\'), task."id"')
    expect(fake.candidatePageCalls[1]?.sql).toContain('COALESCE(task."rootTaskId", \'\') AS "cursorRootKey"')
  })

  it("rolls back the whole recovery batch when a later candidate throws", async () => {
    const fake = fixture({ throwCandidateIds: ["failure-2"], candidatePages: [
      [scanCandidate("recovered-1"), scanCandidate("failure-2")],
    ] })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 2 })).rejects.toThrow("candidate_failure")
    expect(fake.calls.filter(sql => sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $3'))).toHaveLength(1)
    expect(fake.calls.filter(sql => sql === "COMMIT")).toHaveLength(0)
    expect(fake.calls.at(-1)).toBe("ROLLBACK")
    expect(fake.calls.filter(sql => sql.includes("SAVEPOINT"))).toEqual([
      "SAVEPOINT subagent_expiry_recovery_candidate", "RELEASE SAVEPOINT subagent_expiry_recovery_candidate",
      "SAVEPOINT subagent_expiry_recovery_candidate",
    ])
  })

  it("exempts only the exact consumed durable wait call from a later expiry scan", async () => {
    const fake = fixture({ child: true, childWaitResumable: true, continuationWait: true, pendingCall: true, exactWaitCall: true })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toMatchObject([{ id: "child-1", status: "queued" }])
    const pending = fake.calls.find(sql => sql.includes('FROM "agent_events" AS started')) ?? ""
    expect(pending).toContain('started."itemId" = call."id"')
    expect(pending).toContain("(call.\"content\"->'input') - 'taskIds'::text = jsonb_build_object")
    expect(pending).toContain('wait."consumedAt" IS NOT NULL')
    expect(pending).toContain('owner."leaseOwner" = $5')
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $3'))).toBe(true)
  })

  it("replays the exact unconsumed wait only while its streaming continuation is latest", async () => {
    const fake = fixture({ child: true, childWaitResumable: true, unconsumedContinuation: true, pendingCall: true, exactWaitCall: true })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toMatchObject([
      { id: "child-1", status: "queued", attemptCount: 1, nextAttemptAt: null },
    ])
    expect(fake.wait).toMatchObject({ status: "ready", suspendedAt: checkedAt, consumedAt: null })
    const pending = fake.calls.find(sql => sql.includes('FROM "agent_events" AS started')) ?? ""
    expect(pending).toContain('wait."consumedAt" IS NOT NULL OR next."status" = \'streaming\'')
    expect(pending).toContain('next."ordinal" = (SELECT MIN(later."ordinal")')
    expect(pending).toContain('next."ordinal" = (SELECT MAX(current."ordinal")')
    expect(pending).toContain('owner."leaseOwner" = $5 AND owner."attemptCount" = $6 AND owner."leaseExpiresAt" = $7')
    expect(fake.outbox.payload.ownerId).not.toBe("worker-1")
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "agent_outbox" SET "payload"'))).toBe(true)
  })

  it("rearms an exact ready unconsumed wait when its waiting source is latest and has no continuation", async () => {
    const fake = fixture({ child: true, childWaitResumable: true, unconsumedNoContinuation: true, pendingCall: true, exactWaitCall: true })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toMatchObject([
      { id: "child-1", status: "queued", attemptCount: 1, nextAttemptAt: null },
    ])
    expect(fake.task).toMatchObject({ status: "queued", attemptCount: 1 })
    expect(fake.wait).toMatchObject({ status: "ready", suspendedAt: checkedAt, consumedAt: null })
    const pending = fake.calls.find(sql => sql.includes('FROM "agent_events" AS started')) ?? ""
    expect(pending).toContain('wait."status" IN (\'ready\', \'timed_out\') AND wait."suspendedAt" IS NOT NULL AND wait."consumedAt" IS NULL')
    expect(pending).toContain('source."status" = \'waiting_for_tool\' AND source."ordinal" = (SELECT MAX(current."ordinal")')
    expect(pending).toContain('owner."leaseOwner" = $5 AND owner."attemptCount" = $6 AND owner."leaseExpiresAt" = $7')
    expect(fake.outbox).toMatchObject({ attemptCount: 4, publishedAt: null })
    expect(fake.outbox.payload.ownerId).not.toBe("worker-1")

    for (const blocker of [{ exactWaitCall: false }, { exactWaitCall: true, unrelatedPendingCall: true }]) {
      const blocked = fixture({ child: true, childWaitResumable: true, unconsumedNoContinuation: true, pendingCall: true, ...blocker })
      await expect(recoverExpired(blocked.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toEqual([])
      expect(blocked.task.status).toBe("running")
      expect(blocked.calls.some(sql => sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $3'))).toBe(false)
      expect(blocked.calls.some(sql => sql.startsWith('UPDATE "agent_outbox" SET "payload"'))).toBe(false)
    }
  })

  it("keeps an unconsumed wait blocked when another unmatched call remains", async () => {
    const fake = fixture({ child: true, childWaitResumable: true, unconsumedContinuation: true, pendingCall: true,
      exactWaitCall: true, unrelatedPendingCall: true })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toEqual([])
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $3'))).toBe(false)
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "agent_outbox" SET "payload"'))).toBe(false)
  })

  it("continues blocking a consumed wait when an unrelated unmatched call remains", async () => {
    const fake = fixture({ child: true, childWaitResumable: true, continuationWait: true, pendingCall: true, exactWaitCall: false })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toEqual([])
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
  })

  it("blocks an unconsumed wait handoff when a separate unmatched call remains", async () => {
    const fake = fixture({ child: true, registeredWait: true, pendingCall: true, exactWaitCall: true, unrelatedPendingCall: true })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toEqual([])
    expect(fake.calls.find(sql => sql.includes('FROM "agent_events" AS started'))).toContain('source."status" IN (\'streaming\', \'waiting_for_tool\')')
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "agent_steps"'))).toBe(false)
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "agent_wait_conditions"'))).toBe(false)
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
  })

  it("rolls back speculative wait-step promotion when the graph rejects recovery", async () => {
    graphMocks.prepare.mockReturnValueOnce({ blocked: true })
    const fake = fixture({ child: true, registeredWait: true, pendingCall: true, exactWaitCall: true, waitStepStatus: "streaming" })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toEqual([])
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "agent_steps" SET "status" = \'waiting_for_tool\''))).toBe(true)
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "agent_wait_conditions"'))).toBe(false)
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $3'))).toBe(false)
    expect(fake.calls.filter(sql => sql.includes("SAVEPOINT"))).toEqual([
      "SAVEPOINT subagent_expiry_recovery_candidate", "ROLLBACK TO SAVEPOINT subagent_expiry_recovery_candidate",
      "RELEASE SAVEPOINT subagent_expiry_recovery_candidate",
    ])
  })

  it("terminally closes an inadmissible pre-insert wait without retry and still blocks other pending calls", async () => {
    const rejected = fixture({ child: true, pendingCall: true, preinsertWaitCall: true })
    await expect(recoverExpired(rejected.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toMatchObject([
      { id: "child-1", status: "failed", attemptCount: 1, nextAttemptAt: null },
    ])
    expect(rejected.task.status).toBe("failed")
    const blocker = rejected.client.query.mock.calls.find(([sql]) => sql.includes('FROM "agent_events" AS started'))
    expect(blocker?.[0]).toContain('started."id" <> $9')
    expect(blocker?.[1]?.[8]).toBe("start-event")
    expect(rejected.client.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_wait_conditions"'))).toBe(false)

    const unrelated = fixture({ child: true, pendingCall: true, preinsertWaitCall: true, unrelatedPendingCall: true })
    await expect(recoverExpired(unrelated.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toEqual([])
    expect(unrelated.task.status).toBe("running")
    expect(unrelated.client.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $3'))).toBe(false)
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
    expect(waitProof).toContain('currentStep."attempt" = task."attemptCount"')
    expect(waitProof).not.toContain(`task."attemptCount'`)
    expect(waitProof).toContain('continuation."attempt" = task."attemptCount"')
    expect(waitProof).toContain('continuation."ordinal" = (SELECT MIN(later."ordinal")')
    expect(waitProof).toContain('continuation."ordinal" = (SELECT MAX(currentStep."ordinal")')
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
    expect(fake.calls.filter(sql => sql.includes("SAVEPOINT"))).toEqual([
      "SAVEPOINT subagent_expiry_recovery_candidate", "RELEASE SAVEPOINT subagent_expiry_recovery_candidate",
    ])
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
    expect(proof).toContain('continuation."attempt" = task."attemptCount"')
    expect(proof).toContain('continuation."ordinal" = (SELECT MIN(later."ordinal")')
    expect(proof).toContain('continuation."ordinal" = (SELECT MAX(currentStep."ordinal")')
    expect(proof).toContain('currentWaitStep."taskId" = task."id" AND currentWaitStep."attempt" = task."attemptCount"')
    expect(proof).not.toContain('currentWait."status" IN')
    expect(proof).not.toContain('currentWait."stepId" = step."id"')
    expect(proof).toContain('ORDER BY currentWaitStep."ordinal" DESC, currentWait."createdAt" DESC, currentWait."id" DESC LIMIT 1')
    expect(fake.calls.some(sql => sql.includes('FROM "agent_events" AS started'))).toBe(true)
  })

  it("replays only the exact unsettled model start for a consumed same-attempt continuation", async () => {
    const fake = fixture({ child: true, childWaitResumable: true, continuationWait: true, pendingModelStart: "exact", attemptCount: 3, maxAttempts: 3 })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toMatchObject([
      { id: "child-1", status: "queued", attemptCount: 3, nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null },
    ])
    expect(fake.task).toMatchObject({ status: "queued", attemptCount: 3, nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null })
    expect(fake.wait.consumedAt).toEqual(checkedAt)
    expect(fake.outbox).toMatchObject({ id: "dispatch-1", attemptCount: 4, publishedAt: null, lastError: null })
    expect(fake.outbox.payload.ownerId).not.toBe("worker-1")
    const taskUpdate = fake.client.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $3'))
    const rearm = fake.client.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE "agent_outbox" SET "payload"'))
    expect(taskUpdate?.[0]).toContain('"leaseOwner" = NULL, "leaseExpiresAt" = NULL')
    expect(taskUpdate?.[0].split("WHERE")[0]).not.toContain('"attemptCount"')
    expect(taskUpdate?.[1]?.[2]).toBe("queued")
    expect(rearm?.[0]).toContain('"attemptCount" = $5')
    expect(rearm?.[1]?.[4]).toBe(4)
    expect(fake.client.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_events"'))).toBe(false)
    expect(fake.client.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
    expect(fake.client.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
    expect(fake.client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT")

    const proof = fake.calls.find(sql => sql.includes('AS "childWaitContinuationId"')) ?? ""
    const consumedProof = proof.slice(proof.indexOf("CASE WHEN COUNT(*)"), proof.indexOf('AS "childWaitContinuationId"'))
    expect(consumedProof).toContain('THEN MAX(continuation."id"::text) END')
    expect(consumedProof).not.toContain("= true")
    expect(proof).toContain('waitTurn."rootTaskId" = task."rootTaskId"')
    expect(proof).toContain('wait."sessionId" = task."sessionId" AND wait."turnId" = task."turnId"')
    expect(proof).toContain('continuation."sessionId" = source."sessionId"')
    expect(consumedProof).toContain('currentWaitStep."taskId" = task."id" AND currentWaitStep."attempt" = task."attemptCount"')
    expect(consumedProof).not.toContain('currentWait."stepId" = source."id"')
    expect(consumedProof).toContain('ORDER BY currentWaitStep."ordinal" DESC, currentWait."createdAt" DESC, currentWait."id" DESC LIMIT 1')
    expect(proof).toContain('continuation."turnId" = source."turnId" AND continuation."taskId" = source."taskId"')
    expect(proof).toContain('continuation."status" = \'streaming\'')
    expect(proof).toContain('source."attempt" = task."attemptCount"')
    expect(proof).toContain('continuation."attempt" = source."attempt"')
    expect(proof).toContain('continuation."ordinal" = (SELECT MIN(later."ordinal")')
    expect(proof).toContain('continuation."ordinal" = (SELECT MAX(currentStep."ordinal")')
    const pendingCalls = fake.client.query.mock.calls.filter(([sql]) => sql.includes('FROM "agent_events" AS started'))
    expect(pendingCalls).toHaveLength(2)
    expect(pendingCalls.every(([, values]) => values?.[9] === "continuation-1")).toBe(true)
    const blocker = pendingCalls[0]?.[0] ?? ""
    expect(blocker).toContain('started."actor" = \'subagent\'')
    expect(blocker).toContain('started."sessionId" = $1 AND started."taskId" = $2')
    expect(blocker).toContain('started."itemId" IS NULL')
    expect(blocker).toContain('started."turnId" = $3 AND started."correlationId" = $10')
    expect(blocker).toContain('started."idempotencyKey" = \'task:\' || $2 || \':event:model-started:\' || $10')
    expect(blocker).toContain('jsonb_build_object(\'taskId\', $2, \'provider\', started."payload"->>\'provider\', \'model\', started."payload"->>\'model\')')
  })

  it.each(["wrong-correlation", "wrong-actor", "wrong-item", "wrong-key", "wrong-payload"] as const)(
    "keeps a consumed continuation blocked for an unsettled model start with %s",
    async pendingModelStart => {
      const fake = fixture({ child: true, childWaitResumable: true, continuationWait: true, pendingModelStart, attemptCount: 3, maxAttempts: 3 })
      await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toEqual([])
      expect(fake.task.status).toBe("running")
      expect(fake.client.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $3'))).toBe(false)
      expect(fake.client.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE "agent_outbox" SET "payload"'))).toBe(false)
    },
  )

  it("keeps a consumed continuation blocked when an unmatched tool call remains", async () => {
    const fake = fixture({ child: true, childWaitResumable: true, continuationWait: true, pendingToolStart: true, attemptCount: 3, maxAttempts: 3 })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toEqual([])
    expect(fake.task.status).toBe("running")
    expect(fake.client.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $3'))).toBe(false)
    expect(fake.client.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE "agent_outbox" SET "payload"'))).toBe(false)
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
    const fake = fixture({ child: true, attemptCount: 3, maxAttempts: 3, registeredWait: true, pendingCall: true, exactWaitCall: true })
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
    const external = fake.calls.find(sql => sql.includes('FROM "agent_events" AS started')) ?? ""
    expect(external).toContain('wait."consumedAt" IS NULL')
    expect(external).toContain('source."status" IN (\'streaming\', \'waiting_for_tool\')')
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

  it("does not fall through to generic continuation for a streaming wait call", async () => {
    const fake = fixture({ child: true, childWaitResumable: true, pendingCall: true, exactWaitCall: true, waitCallStatus: "streaming" })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toEqual([])
    expect(fake.client.query.mock.calls.some(([sql]) => sql.startsWith('SELECT wait.*, task."status" AS "repairTaskStatus"'))).toBe(true)
    expect(fake.client.query.mock.calls.some(([sql]) => sql.includes('FROM "agent_items" AS call') && sql.includes('AS "eventCreatedAt"'))).toBe(true)
    expect(fake.task.status).toBe("running")
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $3'))).toBe(false)
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "agent_outbox" SET "payload"'))).toBe(false)
  })

  it("falls through when the expired owner fence no longer matches", async () => {
    const fake = fixture({ child: true, attemptCount: 3, maxAttempts: 3, registeredWait: true, recoveryLeaseLost: true, pendingCall: true, exactWaitCall: true })
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
    const scan = fake.calls.find(sql => sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("LIMIT $8")) ?? ""
    expect(scan).toContain('task."sessionId" = $2')
    expect(scan).toContain('task."turnId" = $3')
    const scanCall = fake.client.query.mock.calls.find(([sql]) => sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("LIMIT $8"))
    expect(scanCall?.[1]).toEqual([checkedAt, "session-1", "turn-1", null, null, null, null, 10])
  })
})
