import { beforeEach, describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { createPgTurnEngineStore } from "./turn-engine-store.js"
import { steeringMarkerIdempotencyKey, type SteeringMarkerPayload } from "../context/steering-marker.js"
import { SessionPauseRequestedError, SESSION_WORK_ADMISSION } from "../session-gate.js"
import { TASK_GRAPH_DENIAL_CHECKPOINT_SCHEMA, type TaskGraphDenialCheckpoint } from "./task-graph-terminal-assessment.js"
import { ROOT_TASK_HISTORY_CHRONOLOGY_WITNESS_EVENT_TYPE } from "../context/root-task-history-chronology-witness.js"

const { updateRootObjectiveHistoryProjectionMock, cleanupFailedRootTaskGraphMock } = vi.hoisted(() => ({
  updateRootObjectiveHistoryProjectionMock: vi.fn(async () => true), cleanupFailedRootTaskGraphMock: vi.fn(async () => undefined),
}))
vi.mock("../context/objective-history-projection.js", () => ({ updateRootObjectiveHistoryProjection: updateRootObjectiveHistoryProjectionMock }))
vi.mock("../subagents/task-graph-pg-root-failure-cleanup.js", () => ({ cleanupFailedRootTaskGraph: cleanupFailedRootTaskGraphMock }))
beforeEach(() => {
  updateRootObjectiveHistoryProjectionMock.mockReset().mockResolvedValue(true)
  cleanupFailedRootTaskGraphMock.mockReset().mockResolvedValue(undefined)
})

const lease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "owner-1", userId: "user-1", leaseVersion: 3,
  leaseStartedAt: new Date("2026-09-01T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-01T00:01:00.000Z"),
}
const now = new Date("2026-09-01T00:00:10.000Z")
const owner = {
  kind: "turn" as const, userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId,
  taskId: "root-turn-1", rootTaskId: "root-turn-1", ownerId: lease.ownerId, leaseVersion: lease.leaseVersion,
  leaseExpiresAt: lease.leaseExpiresAt,
}
const childOwner = {
  kind: "task" as const, userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId,
  taskId: "child-1", rootTaskId: owner.taskId, ownerId: "child-worker", attemptCount: 2, leaseExpiresAt: lease.leaseExpiresAt,
}
const scheduledPrepareStepId = "scheduled-prepare-model:0123456789abcdef"
const markerPayload = (stepId: string, changes: Partial<SteeringMarkerPayload> = {}): SteeringMarkerPayload => ({
  schemaVersion: "agent-harness.steering-marker.v1", kind: "observed", status: "observed", sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.taskId,
  stepId, inputId: "steer-1", idempotencyKey: steeringMarkerIdempotencyKey(owner.sessionId, owner.turnId, "steer-1"), obligationId: "plan-replan:plan-1:1", goalRevision: 1, planRevision: 1, acceptedSequence: "2", ...changes,
})
function assertDenseBindings(calls: Array<{ sql: string; values?: readonly unknown[] }>) {
  for (const call of calls) {
    if (!call.values) continue
    const indexes = [...call.sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1]))
    if (indexes.length === 0) continue
    expect(call.values.length).toBe(Math.max(...indexes))
  }
}

function turnStartBudgetFixture(input: {
  readonly budgetSnapshot: unknown
  readonly usage?: Record<string, unknown>
  readonly existingStep?: boolean
  readonly pauseAdmissionDenied?: boolean
}) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
  const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
    calls.push({ sql, values })
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 1 }
    if (sql.includes(SESSION_WORK_ADMISSION)) return input.pauseAdmissionDenied ? { rows: [], rowCount: 0 } : { rows: [{ id: owner.sessionId }], rowCount: 1 }
    if (sql.includes('SELECT root_task."budgetSnapshot"')) return { rows: [{ budgetSnapshot: input.budgetSnapshot }], rowCount: 1 }
    if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: owner.sessionId }], rowCount: 1 }
    if (sql.includes('SELECT turn."id"')) return { rows: [{ id: owner.turnId }], rowCount: 1 }
    if (sql.includes('SELECT "id", "ordinal", "taskId"')) return input.existingStep
      ? { rows: [{ id: "replayed-step", ordinal: 4, taskId: owner.taskId, attempt: 1, inputThroughSequence: "0", consumedInputIds: [], modelProfileSnapshot: {} }], rowCount: 1 }
      : { rows: [], rowCount: 0 }
    if (sql.includes('COUNT(*)::bigint AS "used"')) return { rows: [{ used: "0" }], rowCount: 1 }
    if (sql.includes('SUM(usage_row.')) return { rows: [input.usage ?? { inputTokens: "0", outputTokens: "0", estimatedCostUsd: "0" }], rowCount: 1 }
    if (sql.includes('MAX("ordinal")')) return { rows: [{ ordinal: 0 }], rowCount: 1 }
    if (sql.includes('INSERT INTO "agent_steps"')) return { rows: [{ id: "new-step" }], rowCount: 1 }
    return { rows: [], rowCount: 1 }
  }), release: vi.fn() }
  const pool = { connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">
  return { calls, client, pool }
}

type InterruptedTaskOwnerState = Pick<typeof childOwner, "userId" | "sessionId" | "turnId" | "taskId" | "rootTaskId" | "ownerId" | "attemptCount">
  & { status: string; leaseOwner: string | null; leaseExpiresAt: Date | null }
type InterruptedStepState = Pick<InterruptedTaskOwnerState, "sessionId" | "turnId" | "taskId" | "attemptCount"> & { id: string; status: string }

function interruptedStepFixture(input: {
  readonly persistedOwner?: Partial<InterruptedTaskOwnerState>
  readonly interruptRequestedAt?: Date | null
  readonly persistedStep?: Partial<InterruptedStepState>
}) {
  const persistedOwner: InterruptedTaskOwnerState = {
    ...childOwner, status: "running", leaseOwner: childOwner.ownerId, leaseExpiresAt: childOwner.leaseExpiresAt, ...input.persistedOwner,
  }
  const persistedStep: InterruptedStepState = {
    id: scheduledPrepareStepId, sessionId: childOwner.sessionId, turnId: childOwner.turnId,
    taskId: childOwner.taskId, attemptCount: childOwner.attemptCount, status: "streaming", ...input.persistedStep,
  }
  const interruptRequestedAt = input.interruptRequestedAt === undefined ? now : input.interruptRequestedAt
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
  const stepUpdateRowCounts: number[] = []
  const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
    calls.push({ sql, values })
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
    if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: childOwner.sessionId }], rowCount: 1 }
    if (sql.includes('FROM "agent_turns" AS turn') && sql.includes('interruptRequestedAt" IS NOT NULL')) {
      const lineageMatches = values?.[0] === persistedOwner.userId && values[1] === persistedOwner.sessionId
        && values[2] === persistedOwner.turnId && values[3] === persistedOwner.taskId && values[4] === persistedOwner.rootTaskId
        && values[6] === persistedOwner.attemptCount
      const liveLeaseMatches = sql.includes('owner_task."status" = \'running\'')
        && persistedOwner.status === "running" && values?.[5] === persistedOwner.leaseOwner
        && persistedOwner.leaseExpiresAt instanceof Date && values?.[7] instanceof Date
        && values[7].getTime() === persistedOwner.leaseExpiresAt.getTime() && persistedOwner.leaseExpiresAt > now
      const clearedInterruptedLeaseMatches = sql.includes('owner_task."status" = \'interrupted\'')
        && sql.includes('owner_task."leaseOwner" IS NULL AND owner_task."leaseExpiresAt" IS NULL')
        && persistedOwner.status === "interrupted" && persistedOwner.leaseOwner === null && persistedOwner.leaseExpiresAt === null
      return lineageMatches && (liveLeaseMatches || clearedInterruptedLeaseMatches) && interruptRequestedAt !== null
        ? { rows: [{ id: persistedOwner.turnId }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (sql.includes('UPDATE "agent_steps" AS step')) {
      const matches = values?.[4] === persistedStep.id && values[5] === persistedStep.sessionId
        && values[6] === persistedStep.turnId && values[7] === persistedStep.taskId
        && values[8] === persistedStep.attemptCount && persistedStep.status === "streaming"
      const rowCount = matches ? 1 : 0
      stepUpdateRowCounts.push(rowCount)
      return { rows: [], rowCount }
    }
    return { rows: [], rowCount: 1 }
  }), release: vi.fn() }
  const pool = { connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">
  return { calls, client, pool, stepUpdateRowCounts }
}

describe("PostgreSQL TurnEngine store", () => {
  it("projects only the persisted root-owned terminal event and reuses its id on replay", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
    const events = new Map<string, Record<string, unknown>>()
    const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 1 }
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: owner.sessionId }], rowCount: 1 }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: owner.turnId }], rowCount: 1 }
      if (sql.includes('FROM "agent_events"')) {
        const row = events.get(String(values?.[1]))
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
      }
      if (sql.includes('UPDATE "agent_sessions"')) return { rows: [{ eventSequence: 12n }], rowCount: 1 }
      if (sql.includes('INSERT INTO "agent_events"')) {
        const [id, sessionId, turnId, itemId, taskId, sequence, type, actor, correlationId, causationId, key, payload] = values ?? []
        events.set(String(key), { id, sessionId, turnId, itemId, taskId, sequence, type, actor, correlationId, causationId, payload: JSON.parse(String(payload)) })
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    const input = { owner, id: "terminal-event-1", itemId: null, type: "turn.interrupted", correlationId: owner.turnId, causationId: null,
      idempotencyKey: "turn:turn-1:event:turn-interrupted", payload: { turnId: owner.turnId, taskId: owner.taskId, errorCode: "stopped" } }

    await store.appendEvent(input)
    await store.appendEvent(input)

    expect(updateRootObjectiveHistoryProjectionMock).toHaveBeenNthCalledWith(1, client, {
      userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    }, { terminalEventId: "terminal-event-1" })
    expect(updateRootObjectiveHistoryProjectionMock).toHaveBeenNthCalledWith(2, client, {
      userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    }, { terminalEventId: "terminal-event-1" })
    expect(calls.filter(call => call.sql.includes('INSERT INTO "agent_events"'))).toHaveLength(1)
    expect(calls.filter(call => call.sql.includes('UPDATE "agent_sessions"'))).toHaveLength(1)
    const eventInsertOrder = client.query.mock.invocationCallOrder[calls.findIndex(call => call.sql.includes('INSERT INTO "agent_events"'))]!
    expect(updateRootObjectiveHistoryProjectionMock.mock.invocationCallOrder[0]).toBeGreaterThan(eventInsertOrder)
  })

  it("rolls back a terminal event when its expected root projection is ineligible", async () => {
    updateRootObjectiveHistoryProjectionMock.mockResolvedValueOnce(false)
    const calls: string[] = []
    const client = { query: vi.fn(async (sql: string) => {
      calls.push(sql)
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: owner.sessionId }], rowCount: 1 }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: owner.turnId }], rowCount: 1 }
      if (sql.includes('FROM "agent_events"')) return { rows: [], rowCount: 0 }
      if (sql.includes('UPDATE "agent_sessions"')) return { rows: [{ eventSequence: 12n }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)

    await expect(store.appendEvent({ owner, id: "terminal-event-2", itemId: null, type: "turn.failed", correlationId: owner.turnId, causationId: null,
      idempotencyKey: "turn:turn-1:event:turn-failed:provider_error", payload: { turnId: owner.turnId, taskId: owner.taskId, errorCode: "provider_error", finalItemId: null, final: {} } })).rejects.toThrow(/terminal objective history/)
    expect(calls).toContain("ROLLBACK")
    expect(calls).not.toContain("COMMIT")
  })

  it("keeps flag-off mode resolution in the owner-scoped transaction without probing the new ledger", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
    const client = {
      query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
        calls.push({ sql, values })
        if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: owner.sessionId }], rowCount: 1 }
        if (sql.includes('SELECT turn."id"')) return { rows: [{ id: owner.turnId }], rowCount: 1 }
        if (sql.includes("to_jsonb(turn)")) return { rows: [{ mode: null }], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    const resolveMode = store.resolveNativeSemanticProgressMode
    expect(resolveMode).toBeTypeOf("function")
    await expect(resolveMode!({ owner, requestedEnabled: false, now })).resolves.toBe("legacy_v1")
    expect(calls.map(call => call.sql)).toEqual([
      "BEGIN", "SELECT set_config($1, $2, true)",
      expect.stringContaining('FROM "agent_sessions"'), expect.stringContaining('SELECT turn."id"'),
      expect.stringContaining("to_jsonb(turn)"), "COMMIT",
    ])
    expect(calls[1]?.values).toEqual(["app.user_id", owner.userId])
    expect(calls.some(call => call.sql.includes("agent_native_semantic_rejections") || call.sql.includes("information_schema"))).toBe(false)
    expect(client.release).toHaveBeenCalledOnce()
  })

  it("composes the durable native question methods into the production store", () => {
    const { pool } = turnStartBudgetFixture({ budgetSnapshot: {} })
    const store = createPgTurnEngineStore(pool)
    expect(store.stageQuestionUsage).toEqual(expect.any(Function))
    expect(store.cancelPausedQuestion).toEqual(expect.any(Function))
    expect(store.waitForQuestion).toEqual(expect.any(Function))
    expect(store.readPendingQuestion).toEqual(expect.any(Function))
  })

  it("linearizes tool start against pause on the locked Session before writing its started event", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
    const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
      if (sql.includes("SESSION_WORK_ADMISSION") || sql.includes(SESSION_WORK_ADMISSION)) return { rows: [{ id: owner.sessionId }], rowCount: 1 }
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: owner.sessionId }], rowCount: 1 }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: owner.turnId }], rowCount: 1 }
      if (sql.includes('FROM "agent_events"') && sql.includes('"idempotencyKey" = $2')) return { rows: [], rowCount: 0 }
      if (sql.includes('UPDATE "agent_sessions" SET "eventSequence"')) return { rows: [{ eventSequence: "1" }], rowCount: 1 }
      if (sql.includes('INSERT INTO "agent_events"')) return { rows: [], rowCount: 1 }
      if (sql.includes('INSERT INTO "agent_outbox"')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)

    await store.appendEvent({ owner, id: "tool-start-event", itemId: null, type: "tool_call.started", correlationId: "call-1", causationId: null,
      idempotencyKey: "tool-start:call-1", payload: { toolCallId: "call-1" } })

    const sessionLock = calls.findIndex(call => call.sql.includes('FROM "agent_sessions"') && call.sql.includes("FOR UPDATE"))
    const turnLock = calls.findIndex(call => call.sql.includes('SELECT turn."id"'))
    const admission = calls.findIndex(call => call.sql.includes(SESSION_WORK_ADMISSION))
    const eventWrite = calls.findIndex(call => call.sql.includes('INSERT INTO "agent_events"'))
    expect(sessionLock).toBeLessThan(turnLock)
    expect(turnLock).toBeLessThan(admission)
    expect(admission).toBeLessThan(eventWrite)
    expect(calls[admission]?.values).toEqual([owner.sessionId, owner.userId, owner.turnId])
  })

  it("denies a tool-start event when pause won the Session lock first", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
    const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
      if (sql.includes(SESSION_WORK_ADMISSION)) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: owner.sessionId }], rowCount: 1 }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: owner.turnId }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)

    await expect(store.appendEvent({ owner, id: "tool-start-event", itemId: null, type: "tool_call.started", correlationId: "call-1", causationId: null,
      idempotencyKey: "tool-start:call-1", payload: { toolCallId: "call-1" } })).rejects.toBeInstanceOf(SessionPauseRequestedError)
    expect(calls.some(call => call.sql.includes('INSERT INTO "agent_events"'))).toBe(false)
    expect(calls.some(call => call.sql === "ROLLBACK")).toBe(true)
  })

  it("fences new Steps and Items with the active lease and current time", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
    const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      if (sql === "BEGIN" || sql === "COMMIT" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: "turn-1" }], rowCount: 1 }
      if (sql.includes('SELECT "id", "ordinal", "taskId"')) return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT "id" FROM "agent_steps"')) return { rows: [{ id: "step-1" }], rowCount: 1 }
      if (sql.includes('MAX("ordinal")')) return { rows: [{ ordinal: 0 }], rowCount: 1 }
      if (sql.includes("INSERT INTO \"agent_steps\"")) return { rows: [{ id: "step-1" }], rowCount: 1 }
      if (sql.includes("INSERT INTO \"agent_items\"")) return { rows: [{ id: "item-1", revision: 0 }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await expect(store.startStep({ owner, stepId: "step-1", ordinal: 0, attempt: 1, inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: {}, now })).resolves.toEqual({ id: "step-1", ordinal: 0 })
    await expect(store.createItem({ owner, itemId: "item-1", stepId: "step-1", type: "agent_message", status: "started", phase: "commentary", content: { text: "" }, now })).resolves.toEqual({ id: "item-1", revision: 0 })
    const createItem = calls.find(({ sql }) => sql.includes('INSERT INTO "agent_items"'))
    expect(createItem?.sql).toContain('AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM "agent_steps" AS owner_step')
    expect(createItem?.sql).toContain('WHERE owner_step."id" = $4::text')
    const sessionLocks = calls.filter(({ sql }) => sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE"))
    expect(sessionLocks).toHaveLength(2)
    expect(sessionLocks.every(({ sql }) => sql.includes('"status" NOT IN (\'aborted\', \'archived\')') && sql.includes("FOR UPDATE"))).toBe(true)
    const firstTurnLock = calls.findIndex(({ sql }) => sql.includes('SELECT turn."id"'))
    expect(calls.findIndex(({ sql }) => sql.includes('FROM "agent_sessions"'))).toBeLessThan(firstTurnLock)
    expect(calls.some(({ sql }) => sql.includes("owner_task") && sql.includes("leaseVersion"))).toBe(true)
    expect(calls.some(({ values }) => values?.includes(owner.taskId))).toBe(true)
    assertDenseBindings(calls)
  })

  it("finalizes the exact Scheduled Prepare step after interruption was requested while its task still has a live lease", async () => {
    // Turn/root cancellation can finish before this still-leased child unwinds; its interrupt marker authorizes only this step.
    const { calls, pool, client } = interruptedStepFixture({})
    const store = createPgTurnEngineStore(pool)
    const input = { owner: childOwner, stepId: scheduledPrepareStepId, inputTokens: 12, outputTokens: 8, estimatedCostUsd: 0.004, now }

    await expect(store.finalizeScheduledPrepareCancellationStep?.(input)).resolves.toBeUndefined()

    const authorization = calls.find(call => call.sql.includes('FROM "agent_turns" AS turn') && call.sql.includes('interruptRequestedAt" IS NOT NULL'))
    const update = calls.find(call => call.sql.includes('UPDATE "agent_steps" AS step'))
    expect(authorization).toBeDefined()
    expect(authorization?.sql).toContain('owner_task."status" = \'running\'')
    expect(authorization?.sql).toContain('owner_task."leaseExpiresAt" > clock_timestamp()')
    expect(authorization?.sql).toContain('owner_task."status" = \'interrupted\'')
    expect(authorization?.sql).toContain('owner_task."leaseOwner" IS NULL AND owner_task."leaseExpiresAt" IS NULL')
    expect(authorization?.sql).toContain('FOR UPDATE OF turn, owner_task')
    expect(authorization?.sql).toContain('turn."rootTaskId" = $5')
    expect(authorization?.sql).not.toContain('turn."status"')
    expect(authorization?.sql).not.toContain('root_task."status"')
    expect(authorization?.values).toEqual([childOwner.userId, childOwner.sessionId, childOwner.turnId, childOwner.taskId,
      childOwner.rootTaskId, childOwner.ownerId, childOwner.attemptCount, childOwner.leaseExpiresAt])
    expect(update?.sql).toContain('SET "status" = \'interrupted\'')
    expect(update?.sql).toContain('"finishReason" = \'cancelled\'')
    expect(update?.sql).toContain('"errorCode" = \'scheduled_prepare_cancelled\'')
    expect(update?.sql).toContain('step."attempt" = $9 AND step."status" = \'streaming\' AND step."id" LIKE \'scheduled-prepare-model:%\'')
    expect(update?.values).toEqual([12, 8, 0.004, now, scheduledPrepareStepId, childOwner.sessionId,
      childOwner.turnId, childOwner.taskId, childOwner.attemptCount])
    expect(calls.map(call => call.sql)).toContain("COMMIT")
    expect(calls.map(call => call.sql)).not.toContain("ROLLBACK")
    expect(client.release).toHaveBeenCalledOnce()
  })

  it("finalizes the exact still-streaming Scheduled Prepare step after its task lease was cleared", async () => {
    const { calls, pool, stepUpdateRowCounts } = interruptedStepFixture({
      persistedOwner: { status: "interrupted", leaseOwner: null, leaseExpiresAt: null },
    })
    const store = createPgTurnEngineStore(pool)

    await expect(store.finalizeScheduledPrepareCancellationStep?.({ owner: childOwner, stepId: scheduledPrepareStepId,
      inputTokens: 12, outputTokens: 8, estimatedCostUsd: 0.004, now })).resolves.toBeUndefined()

    const authorization = calls.find(call => call.sql.includes('FROM "agent_turns" AS turn') && call.sql.includes('interruptRequestedAt" IS NOT NULL'))
    expect(authorization?.sql).toContain('owner_task."attemptCount" = $7 AND owner_task."interruptRequestedAt" IS NOT NULL')
    expect(authorization?.sql).toContain('owner_task."status" = \'interrupted\'')
    expect(authorization?.sql).toContain('owner_task."leaseOwner" IS NULL AND owner_task."leaseExpiresAt" IS NULL')
    expect(authorization?.values).toEqual([childOwner.userId, childOwner.sessionId, childOwner.turnId, childOwner.taskId,
      childOwner.rootTaskId, childOwner.ownerId, childOwner.attemptCount, childOwner.leaseExpiresAt])
    expect(stepUpdateRowCounts).toEqual([1])
    expect(calls.map(call => call.sql)).toContain("COMMIT")
    expect(calls.map(call => call.sql)).not.toContain("ROLLBACK")
  })

  const staleInterruptedOwnerCases: Array<{
    name: string
    persistedOwner: Partial<InterruptedTaskOwnerState>
    interruptRequestedAt: Date | null
  }> = [
    { name: "task id", persistedOwner: { taskId: "different-child" }, interruptRequestedAt: now },
    { name: "task attempt", persistedOwner: { attemptCount: childOwner.attemptCount + 1 }, interruptRequestedAt: now },
    { name: "lease owner", persistedOwner: { leaseOwner: "different-worker" }, interruptRequestedAt: now },
    { name: "lease expiry", persistedOwner: { leaseExpiresAt: new Date(childOwner.leaseExpiresAt.getTime() + 1000) }, interruptRequestedAt: now },
    { name: "interrupt marker", persistedOwner: {}, interruptRequestedAt: null },
  ]

  it.each(staleInterruptedOwnerCases)("fails closed when persisted $name no longer matches", async ({ persistedOwner, interruptRequestedAt }) => {
    const { calls, pool } = interruptedStepFixture({ persistedOwner, interruptRequestedAt })
    const store = createPgTurnEngineStore(pool)

    await expect(store.finalizeScheduledPrepareCancellationStep?.({ owner: childOwner, stepId: scheduledPrepareStepId, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, now }))
      .rejects.toMatchObject({ name: "TurnEnginePersistenceConflict" })

    expect(calls.some(call => call.sql.includes('UPDATE "agent_steps" AS step'))).toBe(false)
    expect(calls.map(call => call.sql)).toContain("ROLLBACK")
    expect(calls.map(call => call.sql)).not.toContain("COMMIT")
  })

  const staleTerminalizedOwnerCases: Array<{ name: string; persistedOwner: Partial<InterruptedTaskOwnerState>; interruptRequestedAt: Date | null }> = [
    { name: "other terminal status", persistedOwner: { status: "failed", leaseOwner: null, leaseExpiresAt: null }, interruptRequestedAt: now },
    { name: "cancelled status", persistedOwner: { status: "cancelled", leaseOwner: null, leaseExpiresAt: null }, interruptRequestedAt: now },
    { name: "completed status", persistedOwner: { status: "completed", leaseOwner: null, leaseExpiresAt: null }, interruptRequestedAt: now },
    { name: "retained lease owner", persistedOwner: { status: "interrupted", leaseOwner: childOwner.ownerId, leaseExpiresAt: null }, interruptRequestedAt: now },
    { name: "retained lease expiry", persistedOwner: { status: "interrupted", leaseOwner: null, leaseExpiresAt: childOwner.leaseExpiresAt }, interruptRequestedAt: now },
    { name: "different task", persistedOwner: { status: "interrupted", leaseOwner: null, leaseExpiresAt: null, taskId: "different-child" }, interruptRequestedAt: now },
    { name: "different task attempt", persistedOwner: { status: "interrupted", leaseOwner: null, leaseExpiresAt: null, attemptCount: childOwner.attemptCount + 1 }, interruptRequestedAt: now },
    { name: "different root lineage", persistedOwner: { status: "interrupted", leaseOwner: null, leaseExpiresAt: null, rootTaskId: "different-root" }, interruptRequestedAt: now },
    { name: "different session lineage", persistedOwner: { status: "interrupted", leaseOwner: null, leaseExpiresAt: null, sessionId: "different-session" }, interruptRequestedAt: now },
    { name: "different turn lineage", persistedOwner: { status: "interrupted", leaseOwner: null, leaseExpiresAt: null, turnId: "different-turn" }, interruptRequestedAt: now },
    { name: "missing interrupt marker", persistedOwner: { status: "interrupted", leaseOwner: null, leaseExpiresAt: null }, interruptRequestedAt: null },
  ]

  it.each(staleTerminalizedOwnerCases)("rejects terminalized cancellation finalization with $name", async ({ persistedOwner, interruptRequestedAt }) => {
    const { calls, pool } = interruptedStepFixture({ persistedOwner, interruptRequestedAt })
    const store = createPgTurnEngineStore(pool)

    await expect(store.finalizeScheduledPrepareCancellationStep?.({ owner: childOwner, stepId: scheduledPrepareStepId,
      inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, now })).rejects.toMatchObject({ name: "TurnEnginePersistenceConflict" })

    expect(calls.some(call => call.sql.includes('UPDATE "agent_steps" AS step'))).toBe(false)
    expect(calls.map(call => call.sql)).toContain("ROLLBACK")
    expect(calls.map(call => call.sql)).not.toContain("COMMIT")
  })

  it("rejects model steps outside the Scheduled Prepare namespace before opening a transaction", async () => {
    const { pool } = interruptedStepFixture({})
    const store = createPgTurnEngineStore(pool)

    await expect(store.finalizeScheduledPrepareCancellationStep?.({ owner: childOwner, stepId: "task:child-1:step:0",
      inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, now })).rejects.toMatchObject({ name: "TurnEnginePersistenceConflict" })

    expect(pool.connect).not.toHaveBeenCalled()
  })

  it("rejects non-task owners before opening a cancellation-finalizer transaction", async () => {
    const { pool } = interruptedStepFixture({})
    const store = createPgTurnEngineStore(pool)

    await expect(store.finalizeScheduledPrepareCancellationStep?.({ owner: owner as unknown as typeof childOwner, stepId: "turn-owned-step",
      inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, now })).rejects.toMatchObject({ name: "TurnEnginePersistenceConflict" })

    expect(pool.connect).not.toHaveBeenCalled()
  })

  it("fails closed when the persisted step identity does not match", async () => {
    const { calls, pool, stepUpdateRowCounts } = interruptedStepFixture({ persistedStep: { id: "different-step" } })
    const store = createPgTurnEngineStore(pool)

    await expect(store.finalizeScheduledPrepareCancellationStep?.({ owner: childOwner, stepId: scheduledPrepareStepId, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, now }))
      .rejects.toMatchObject({ name: "TurnEnginePersistenceConflict" })

    expect(calls.some(call => call.sql.includes('step."attempt" = $9 AND step."status" = \'streaming\''))).toBe(true)
    expect(stepUpdateRowCounts).toEqual([0])
    expect(calls.map(call => call.sql)).toContain("ROLLBACK")
    expect(calls.map(call => call.sql)).not.toContain("COMMIT")
  })

  it("fails closed when the exact step is no longer streaming", async () => {
    const { calls, pool, stepUpdateRowCounts } = interruptedStepFixture({ persistedStep: { status: "completed" } })
    const store = createPgTurnEngineStore(pool)

    await expect(store.finalizeScheduledPrepareCancellationStep?.({ owner: childOwner, stepId: scheduledPrepareStepId, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, now }))
      .rejects.toMatchObject({ name: "TurnEnginePersistenceConflict" })

    expect(stepUpdateRowCounts).toEqual([0])
    expect(calls.map(call => call.sql)).toContain("ROLLBACK")
    expect(calls.map(call => call.sql)).not.toContain("COMMIT")
  })

  it("checks the root step and usage budgets before allocating a new Step", async () => {
    const { calls, pool } = turnStartBudgetFixture({
      budgetSnapshot: { limits: { maxSteps: 32, maxInputTokens: 100, maxOutputTokens: 200, maxCostUsd: 1 } },
      usage: { inputTokens: "10", outputTokens: "20", estimatedCostUsd: "0.2" },
    })
    const store = createPgTurnEngineStore(pool)

    await expect(store.startStep({ owner, stepId: "budgeted-step", ordinal: 0, attempt: 1, inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: {}, now }))
      .resolves.toEqual({ id: "new-step", ordinal: 0 })

    const stepUsage = calls.findIndex(({ sql }) => sql.includes('COUNT(*)::bigint AS "used"') && sql.includes('FROM "agent_steps"'))
    const aggregateUsage = calls.findIndex(({ sql }) => sql.includes('SUM(usage_row."inputTokens")'))
    const ordinal = calls.findIndex(({ sql }) => sql.includes('MAX("ordinal")'))
    const insert = calls.findIndex(({ sql }) => sql.includes('INSERT INTO "agent_steps"'))
    expect(stepUsage).toBeGreaterThan(-1)
    expect(aggregateUsage).toBeGreaterThan(stepUsage)
    expect(ordinal).toBeGreaterThan(aggregateUsage)
    expect(insert).toBeGreaterThan(ordinal)
    expect(calls.some(({ sql }) => sql === "COMMIT")).toBe(true)
    expect(calls.some(({ sql }) => sql === "ROLLBACK")).toBe(false)
  })

  it("reads the root snapshot once and skips usage aggregation when usage limits are absent", async () => {
    const { calls, pool } = turnStartBudgetFixture({
      budgetSnapshot: { limits: { maxSteps: 32, maxToolCalls: 4 } },
    })
    const store = createPgTurnEngineStore(pool)

    await expect(store.startStep({ owner, stepId: "unbudgeted-usage-step", ordinal: 0, attempt: 1, inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: {}, now }))
      .resolves.toEqual({ id: "new-step", ordinal: 0 })

    expect(calls.filter(({ sql }) => sql.includes('SELECT root_task."budgetSnapshot"'))).toHaveLength(1)
    expect(calls.some(({ sql }) => sql.includes("SUM(usage_row."))).toBe(false)
  })

  it.each([
    { metric: "input_tokens", budgetSnapshot: { limits: { maxSteps: 32, maxInputTokens: 10 } }, usage: { inputTokens: "10", outputTokens: "0", estimatedCostUsd: "0" } },
    { metric: "cost_usd", budgetSnapshot: { limits: { maxSteps: 32, maxCostUsd: 0.25 } }, usage: { inputTokens: "0", outputTokens: "0", estimatedCostUsd: "0.25" } },
  ])("rolls back a new Step when committed root usage reaches the $metric budget", async ({ metric, budgetSnapshot, usage }) => {
    const { calls, pool } = turnStartBudgetFixture({ budgetSnapshot, usage })
    const store = createPgTurnEngineStore(pool)

    await expect(store.startStep({ owner, stepId: `denied-${metric}`, ordinal: 0, attempt: 1, inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: {}, now }))
      .rejects.toMatchObject({ name: "BudgetExceededError", metric })

    expect(calls.some(({ sql }) => sql.includes('INSERT INTO "agent_steps"'))).toBe(false)
    expect(calls.filter(({ sql }) => sql === "ROLLBACK")).toHaveLength(1)
    expect(calls.some(({ sql }) => sql === "COMMIT")).toBe(false)
  })

  it("returns an existing Step idempotently before either root budget guard", async () => {
    const { calls, pool } = turnStartBudgetFixture({
      budgetSnapshot: { limits: { maxSteps: 0, maxInputTokens: 0, maxCostUsd: 0 } },
      existingStep: true,
    })
    const store = createPgTurnEngineStore(pool)

    await expect(store.startStep({ owner, stepId: "replayed-step", ordinal: 0, attempt: 1, inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: {}, now }))
      .resolves.toEqual({ id: "replayed-step", ordinal: 4 })

    expect(calls.some(({ sql }) => sql.includes('SELECT root_task."budgetSnapshot"'))).toBe(false)
    expect(calls.some(({ sql }) => sql.includes('COUNT(*)::bigint AS "used"') || sql.includes("SUM(usage_row."))).toBe(false)
    expect(calls.some(({ sql }) => sql.includes('INSERT INTO "agent_steps"'))).toBe(false)
    expect(calls.some(({ sql }) => sql === "COMMIT")).toBe(true)
  })

  it("does not replay an existing Step through a durable pause admission fence", async () => {
    const { calls, pool } = turnStartBudgetFixture({ budgetSnapshot: {}, existingStep: true, pauseAdmissionDenied: true })
    const store = createPgTurnEngineStore(pool)

    await expect(store.startStep({ owner, stepId: "replayed-step", ordinal: 0, attempt: 1, inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: {}, now }))
      .rejects.toBeInstanceOf(SessionPauseRequestedError)

    const admission = calls.findIndex(({ sql }) => sql.includes(SESSION_WORK_ADMISSION))
    expect(admission).toBeGreaterThan(-1)
    expect(calls.some(({ sql }) => sql.includes('SELECT "id", "ordinal", "taskId"'))).toBe(false)
    expect(calls.some(({ sql }) => sql === "COMMIT")).toBe(false)
    expect(calls.some(({ sql }) => sql === "ROLLBACK")).toBe(true)
  })

  it("persists Step usage updates without rechecking the root budget", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
    const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: owner.sessionId }], rowCount: 1 }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: owner.turnId }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)

    await expect(store.updateStep({ owner, stepId: "step-usage", status: "completed", finishReason: "done", errorCode: null, inputTokens: 11, outputTokens: 7, estimatedCostUsd: 0.03, now })).resolves.toBeUndefined()

    const update = calls.find(({ sql }) => sql.includes('UPDATE "agent_steps"'))
    expect(update?.values?.slice(3, 6)).toEqual([11, 7, 0.03])
    expect(calls.some(({ sql }) => sql.includes('SELECT root_task."budgetSnapshot"') || sql.includes('COUNT(*)::bigint AS "used"') || sql.includes("SUM(usage_row."))).toBe(false)
  })

  it("writes an event and its outbox record in one transaction", async () => {
    const calls: string[] = []
    const client = { query: vi.fn(async (sql: string) => {
      calls.push(sql)
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }] }
      if (sql.includes("FROM \"agent_events\"")) return { rows: [] }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: "turn-1" }] }
      if (sql.includes("UPDATE \"agent_sessions\"")) return { rows: [{ eventSequence: 1n }] }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await expect(store.appendEvent({ owner, id: "event-1", itemId: null, type: "turn.started", correlationId: "turn-1", causationId: null, idempotencyKey: "key-1", payload: { ok: true } })).resolves.toEqual({ id: "event-1" })
    expect(calls[0]).toBe("BEGIN")
    expect(calls.findIndex(sql => sql.includes('FROM "agent_sessions"'))).toBeLessThan(calls.findIndex(sql => sql.includes('SELECT turn."id"')))
    expect(calls).toContain("COMMIT")
    expect(calls.some((sql) => sql.includes("INSERT INTO \"agent_events\""))).toBe(true)
    expect(calls.some((sql) => sql.includes("INSERT INTO \"agent_outbox\""))).toBe(true)
  })

  it("writes a mixed existing/new event batch atomically and restores a missing outbox", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
    let eventLookups = 0
    const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }] }
      if (sql.includes('FROM "agent_events"')) {
        eventLookups += 1
        return eventLookups === 1
          ? { rows: [{ id: "existing-event", taskId: owner.taskId, turnId: owner.turnId, itemId: null, type: "plan.observation", correlationId: "plan-1", causationId: null, sequence: 4n, actor: "orchestrator", payload: { marker: "a" } }] }
          : { rows: [] }
      }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: owner.turnId }] }
      if (sql.includes('UPDATE "agent_sessions"')) return { rows: [{ eventSequence: 5n }] }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await expect(store.appendEvents?.([
      { owner, id: "requested-existing", itemId: null, type: "plan.observation", correlationId: "plan-1", causationId: null, idempotencyKey: "plan-event-a", payload: { marker: "a" } },
      { owner, id: "new-event", itemId: null, type: "plan.observation", correlationId: "plan-1", causationId: "requested-existing", idempotencyKey: "plan-event-b", payload: { marker: "b" } },
    ])).resolves.toEqual([{ id: "existing-event" }, { id: "new-event" }])
    expect(calls.filter(call => call.sql === "BEGIN")).toHaveLength(1)
    expect(calls.filter(call => call.sql === "COMMIT")).toHaveLength(1)
    expect(calls.some(call => call.sql === "ROLLBACK")).toBe(false)
    expect(calls.filter(call => call.sql.includes('INSERT INTO "agent_events"'))).toHaveLength(1)
    expect(calls.filter(call => call.sql.includes('INSERT INTO "agent_outbox"'))).toHaveLength(2)
    const newEventInsert = calls.filter(call => call.sql.includes('INSERT INTO "agent_events"'))[0]
    expect(newEventInsert?.values).toContain("new-event")
    expect(newEventInsert?.values).toContain("existing-event")
    const outboxInserts = calls.filter(call => call.sql.includes('INSERT INTO "agent_outbox"'))
    expect(outboxInserts[0]?.sql).toContain('ON CONFLICT ("idempotencyKey") DO NOTHING')
    expect(outboxInserts[1]?.sql).not.toContain("ON CONFLICT")
  })

  it("accepts a matching existing event outbox row with reordered JSON", async () => {
    const calls: string[] = []
    const outbox = {
      id: "agent-outbox-existing-event", topic: "agent.events", aggregateId: owner.sessionId, idempotencyKey: "agent-event:existing-event",
      payload: Object.fromEntries(Object.entries({ eventId: "existing-event", sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.taskId, itemId: null, sequence: "4", type: "plan.observation", actor: "orchestrator", correlationId: "plan-1", causationId: null, idempotencyKey: "plan-event-existing", payload: { marker: "a" } }).reverse()),
    }
    const client = { query: vi.fn(async (sql: string) => {
      calls.push(sql)
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: owner.sessionId }] }
      if (sql.includes('FROM "agent_outbox"')) return { rows: [outbox] }
      if (sql.includes('FROM "agent_events"')) return { rows: [{ id: "existing-event", taskId: owner.taskId, turnId: owner.turnId, itemId: null, type: "plan.observation", correlationId: "plan-1", causationId: null, sequence: 4n, actor: "orchestrator", payload: { marker: "a" } }] }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: owner.turnId }] }
      if (sql.includes('INSERT INTO "agent_outbox"')) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await expect(store.appendEvent({ owner, id: "requested-existing", itemId: null, type: "plan.observation", correlationId: "plan-1", causationId: null, idempotencyKey: "plan-event-existing", payload: { marker: "a" } })).resolves.toEqual({ id: "existing-event" })
    expect(calls.some(sql => sql.includes('FROM "agent_outbox"') && sql.includes("FOR UPDATE"))).toBe(true)
  })

  it("rejects a polluted existing event outbox row", async () => {
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: owner.sessionId }] }
      if (sql.includes('FROM "agent_outbox"')) return { rows: [{ id: "agent-outbox-existing-event", topic: "wrong.topic", aggregateId: owner.sessionId, idempotencyKey: "agent-event:existing-event", payload: {} }] }
      if (sql.includes('FROM "agent_events"')) return { rows: [{ id: "existing-event", taskId: owner.taskId, turnId: owner.turnId, itemId: null, type: "plan.observation", correlationId: "plan-1", causationId: null, sequence: 4n, actor: "orchestrator", payload: { marker: "a" } }] }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: owner.turnId }] }
      if (sql.includes('INSERT INTO "agent_outbox"')) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await expect(store.appendEvent({ owner, id: "requested-existing", itemId: null, type: "plan.observation", correlationId: "plan-1", causationId: null, idempotencyKey: "plan-event-existing", payload: { marker: "a" } })).rejects.toThrow(/event outbox .* identity/)
  })

  it("rolls back the entire batch when a later event insert fails", async () => {
    const calls: string[] = []
    let eventInserts = 0
    const client = { query: vi.fn(async (sql: string) => {
      calls.push(sql)
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }] }
      if (sql.includes('INSERT INTO "agent_events"')) { eventInserts += 1; if (eventInserts === 2) throw new Error("batch insert failed") }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: owner.turnId }] }
      if (sql.includes('UPDATE "agent_sessions"')) return { rows: [{ eventSequence: 1n }] }
      if (sql.includes('FROM "agent_events"')) return { rows: [] }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    const input = (id: string, causationId: string | null) => ({ owner, id, itemId: null, type: "plan.observation", correlationId: "plan-rollback", causationId, idempotencyKey: `rollback:${id}`, payload: { id } })
    await expect(store.appendEvents!([input("event-a", null), input("event-b", "event-a")])).rejects.toThrow("batch insert failed")
    expect(calls.filter(sql => sql === "BEGIN")).toHaveLength(1)
    expect(calls.filter(sql => sql === "COMMIT")).toHaveLength(0)
    expect(calls.filter(sql => sql === "ROLLBACK")).toHaveLength(1)
  })

  it("transitions only the leased in-progress Turn to waiting_for_user", async () => {
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await store.waitForUser?.({ owner, now })
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('"status" = \'in_progress\''), [now, owner.turnId, owner.sessionId, owner.userId, owner.ownerId, owner.leaseVersion, owner.taskId])
  })

  it("records child events as subagent actor while preserving root orchestration actor", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
    const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }] }
      if (sql.includes("FROM \"agent_events\"")) return { rows: [] }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: "turn-1" }] }
      if (sql.includes("UPDATE \"agent_sessions\"")) return { rows: [{ eventSequence: 1n }] }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await store.appendEvent({ owner: childOwner, id: "child-event", itemId: null, type: "tool.result", correlationId: "child-1", causationId: null, idempotencyKey: "child-key", payload: {} })
    await store.appendEvent({ owner, id: "root-event", itemId: null, type: "turn.started", correlationId: "turn-1", causationId: null, idempotencyKey: "root-key", payload: {} })
    const eventInserts = calls.filter(call => call.sql.includes('INSERT INTO "agent_events"'))
    expect(eventInserts[0]?.values).toContain("subagent")
    expect(eventInserts[1]?.values).toContain("orchestrator")
    const outboxInserts = calls.filter(call => call.sql.includes('INSERT INTO "agent_outbox"'))
    expect(JSON.parse(String(outboxInserts[0]?.values?.[3])).actor).toBe("subagent")
    expect(JSON.parse(String(outboxInserts[1]?.values?.[3])).actor).toBe("orchestrator")
  })

  it("allows only the server-owned system actor override", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
    const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }] }
      if (sql.includes("FROM \"agent_events\"")) return { rows: [] }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: "turn-1" }] }
      if (sql.includes("UPDATE \"agent_sessions\"")) return { rows: [{ eventSequence: 1n }] }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await store.appendEvent({ owner, id: "system-event", itemId: null, type: "agent.steering.marker", correlationId: "goal-call", causationId: null, idempotencyKey: "system-key", payload: {}, actor: "system" })
    const eventInsert = calls.find(call => call.sql.includes('INSERT INTO "agent_events"'))
    expect(eventInsert?.values).toContain("system")
    await expect(store.appendEvent({ owner, id: "ordinary-system-event", itemId: null, type: "goal.revision", correlationId: "goal-call", causationId: null, idempotencyKey: "ordinary-system-key", payload: {}, actor: "system" } as never)).rejects.toThrow(/actor/)
    await expect(store.appendEvent({ owner, id: "bad-actor", itemId: null, type: "agent.steering.marker", correlationId: "goal-call", causationId: null, idempotencyKey: "bad-key", payload: {}, actor: "orchestrator" as never })).rejects.toThrow(/actor/)
  })

  it("rejects an idempotency replay whose actor changed", async () => {
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }] }
      if (sql.includes("FROM \"agent_events\"")) return { rows: [{ id: "existing", taskId: owner.taskId, turnId: owner.turnId, itemId: null, type: "agent.steering.marker", correlationId: "goal-call", causationId: null, sequence: 1n, actor: "orchestrator", payload: {} }] }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: "turn-1" }] }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await expect(store.appendEvent({ owner, id: "requested", itemId: null, type: "agent.steering.marker", correlationId: "goal-call", causationId: null, idempotencyKey: "same-key", payload: {}, actor: "system" })).rejects.toThrow(/identity/)
  })

  it("treats an applied marker replay with a new step as idempotent", async () => {
    const oldPayload = markerPayload("old-step", { kind: "applied", status: "applied" })
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: owner.sessionId }] }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: owner.turnId }] }
      if (sql.includes('FROM "agent_events"')) return { rows: [{ id: "existing", taskId: owner.taskId, turnId: owner.turnId, itemId: null, type: "agent.steering.marker", correlationId: "goal-call", causationId: null, sequence: 2n, actor: "system", payload: oldPayload }] }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await expect(store.appendEvent({ owner, id: "replayed", itemId: null, type: "agent.steering.marker", correlationId: "goal-call", causationId: null, idempotencyKey: oldPayload.idempotencyKey, payload: markerPayload("new-step", { kind: "applied", status: "applied" }), actor: "system" })).resolves.toEqual({ id: "existing" })
  })

  it("rejects marker replay conflicts beyond step provenance", async () => {
    const oldPayload = markerPayload("old-step", { kind: "applied", status: "applied" })
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: owner.sessionId }] }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: owner.turnId }] }
      if (sql.includes('FROM "agent_events"')) return { rows: [{ id: "existing", taskId: owner.taskId, turnId: owner.turnId, itemId: null, type: "agent.steering.marker", correlationId: "goal-call", causationId: null, sequence: 2n, actor: "system", payload: oldPayload }] }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await expect(store.appendEvent({ owner, id: "conflict-goal", itemId: null, type: "agent.steering.marker", correlationId: "goal-call", causationId: null, idempotencyKey: oldPayload.idempotencyKey, payload: markerPayload("new-step", { goalRevision: 2 }), actor: "system" })).rejects.toThrow(/identity/)
    await expect(store.appendEvent({ owner, id: "conflict-kind", itemId: null, type: "agent.steering.marker", correlationId: "goal-call", causationId: null, idempotencyKey: oldPayload.idempotencyKey, payload: markerPayload("new-step"), actor: "system" })).rejects.toThrow(/identity/)
  })

  it("fences child persistence and allocates a Turn-global ordinal", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
    const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
      if (sql === "BEGIN" || sql === "COMMIT" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: "turn-1" }], rowCount: 1 }
      if (sql.includes('SELECT "id", "ordinal", "taskId"')) return { rows: [], rowCount: 0 }
      if (sql.includes('MAX("ordinal")')) return { rows: [{ ordinal: 7 }], rowCount: 1 }
      if (sql.includes('INSERT INTO "agent_steps"')) return { rows: [{ id: "child-step" }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await expect(store.startStep({ owner: childOwner, stepId: "task:child-1:step:0", ordinal: 0, attempt: 2, inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: {}, now })).resolves.toEqual({ id: "child-step", ordinal: 7 })
    await expect(store.recordFinalResponse({ owner: childOwner as never, response: "private", now })).rejects.toThrow(/child final/)
    expect(calls.some(({ sql }) => sql.includes('"rootTaskId"') && sql.includes('"attemptCount"') && sql.includes('"interruptRequestedAt" IS NULL'))).toBe(true)
    expect(calls.some(({ sql }) => sql.includes('MAX("ordinal")') && sql.includes('agent_steps'))).toBe(true)
    assertDenseBindings(calls)
  })

  it("forwards the optional terminal guard only for atomic terminal completion", async () => {
    const calls: string[] = []
    const client = { query: vi.fn(async (sql: string) => {
      calls.push(sql)
      if (sql === "BEGIN" || sql.startsWith("BEGIN ISOLATION LEVEL") || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes("pg_current_xact_id")) return { rows: [{ xid8: "42" }], rowCount: 1 }
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: owner.sessionId }], rowCount: 1 }
      if (sql.includes('FROM "agent_turns" AS turn')) return { rows: [{ id: owner.turnId, status: "in_progress", finalResponse: null }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [{ id: owner.taskId, status: "running", leaseOwner: owner.ownerId, attemptCount: 1, result: null, allowedActions: [] }], rowCount: 1 }
      if (sql.includes('FROM "agent_inputs"')) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_events"')) return { rows: [{ id: "step-completed-event" }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const guard = vi.fn(async (seen: pg.PoolClient) => {
      expect(seen).toBe(client)
      return { ok: false as const, blocker: "selected_job_draft_review_required", feedback: "Review the latest draft." }
    })
    const pool = { connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">
    const store = createPgTurnEngineStore(pool, guard)

    await expect(store.recordFinalResponse({ owner, response: "done", now, terminal: {
      stepId: "step-final", finalItemId: "final-item", finalContent: { text: "done" }, stepCount: 1, toolCallCount: 0,
      usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
    } })).rejects.toMatchObject({ name: "TurnEnginePersistenceConflict" })
    expect(guard).toHaveBeenCalledOnce()
    expect(calls[0]).toBe("BEGIN ISOLATION LEVEL READ COMMITTED")

    calls.length = 0
    await expect(store.recordFinalResponse({ owner, response: "intermediate", now })).resolves.toBeUndefined()
    expect(guard).toHaveBeenCalledOnce()
    expect(calls[0]).toBe("BEGIN")
  })

  it("linearizes repeated-denial terminalization against accepted steer input", async () => {
    const checkpoint: TaskGraphDenialCheckpoint = { schemaVersion: TASK_GRAPH_DENIAL_CHECKPOINT_SCHEMA,
      taskId: owner.rootTaskId, graphRevision: 3, verificationDigest: "a".repeat(64) }
    const changedCheckpoint: TaskGraphDenialCheckpoint = { ...checkpoint, graphRevision: 4, verificationDigest: "b".repeat(64) }
    async function run(pendingInput: boolean, graphChanged = false) {
      const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
      const eventsById = new Map<string, Record<string, unknown>>()
      const eventsByKey = new Map<string, Record<string, unknown>>()
      const outboxesById = new Map<string, Record<string, unknown>>()
      const outboxesByKey = new Map<string, Record<string, unknown>>()
      let eventSequence = 19n
      let stepStatus = "streaming"
      const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
        calls.push({ sql, values })
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
        if (sql.includes("pg_current_xact_id")) return { rows: [{ xid8: "42" }], rowCount: 1 }
        if (sql.includes(SESSION_WORK_ADMISSION)) return { rows: [{ id: owner.sessionId }], rowCount: 1 }
        if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: owner.sessionId }], rowCount: 1 }
        if (sql.includes('SELECT turn."id"')) return { rows: [{ id: owner.turnId }], rowCount: 1 }
        if (sql.includes('SELECT "id","status","leaseOwner"') && sql.includes('FROM "sub_agent_tasks"')) return {
          rows: [{ id: owner.taskId, status: "running", leaseOwner: owner.ownerId, attemptCount: 1, interruptRequestedAt: null }], rowCount: 1,
        }
        if (sql.includes('FROM "agent_steps"')) return { rows: [{ status: stepStatus, inputThroughSequence: "8", consumedInputIds: ["accepted-8"] }], rowCount: 1 }
        if (sql.includes('FROM "agent_inputs"')) return pendingInput ? { rows: [{ id: "accepted-9" }], rowCount: 1 } : { rows: [], rowCount: 0 }
        if (sql.includes('FROM "agent_events"')) {
          if (values?.[2] === `turn:${owner.turnId}:event:step-started:step-denial-3`) return { rows: [{ id: "step-started-event" }], rowCount: 1 }
          const row = eventsById.get(String(values?.[0])) ?? eventsByKey.get(String(values?.[1]))
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
        }
        if (sql.includes('FROM "agent_outbox"')) {
          const row = outboxesByKey.get(String(values?.[0])) ?? outboxesById.get(String(values?.[0]))
            ?? outboxesByKey.get(String(values?.[1])) ?? outboxesById.get(String(values?.[1]))
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
        }
        if (sql.includes('INSERT INTO "agent_items"')) return { rows: [{ id: "final-item" }], rowCount: 1 }
        if (sql.includes('SELECT "id" FROM "agent_items"')) return { rows: [{ id: "final-item" }], rowCount: 1 }
        if (sql.includes('UPDATE "agent_steps"')) { stepStatus = "failed"; return { rows: [], rowCount: 1 } }
        if (sql.includes('UPDATE "agent_turns"')) return { rows: [], rowCount: 1 }
        if (sql.includes('SELECT item."id"')) return { rows: [{ id: "final-item" }], rowCount: 1 }
        if (/UPDATE\s+"agent_sessions"\s+SET\s+"eventSequence"/.test(sql)) return { rows: [{ eventSequence: String(++eventSequence) }], rowCount: 1 }
        if (sql.includes('INSERT INTO "agent_events"')) {
          const [id, sessionId, turnId, itemId, taskId, sequence, type, actor, correlationId, causationId, idempotencyKey, payload] = values?.length === 9
            ? [values[0], values[1], values[2], null, values[3], values[4], values[5], "orchestrator", values[3], values[6], values[7], values[8]]
            : values ?? []
          const row = { id: String(id), sessionId: String(sessionId), turnId: String(turnId), itemId: itemId === null ? null : String(itemId),
            taskId: String(taskId), sequence: String(sequence), type: String(type), actor: String(actor), correlationId: String(correlationId),
            causationId: causationId === null ? null : String(causationId), idempotencyKey: String(idempotencyKey), payload: JSON.parse(String(payload)) as unknown }
          eventsById.set(row.id, row); eventsByKey.set(row.idempotencyKey, row)
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('INSERT INTO "agent_outbox"')) {
          const [id, topic, aggregateId, idempotencyKey, payload] = values?.length === 4
            ? [values[0], "agent.events", values[1], values[2], values[3]]
            : values ?? []
          const row = { id: String(id), topic: String(topic), aggregateId: String(aggregateId), idempotencyKey: String(idempotencyKey), payload: JSON.parse(String(payload)) as unknown }
          outboxesById.set(row.id, row); outboxesByKey.set(row.idempotencyKey, row)
          return { rows: [], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      }), release: vi.fn() }
      const pool = { connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">
      const store = createPgTurnEngineStore(pool)
      const readCheckpoint = vi.fn(async (transactionClient?: unknown) => {
        if (transactionClient) expect(transactionClient).toBe(client)
        return graphChanged ? changedCheckpoint : checkpoint
      })
      const input = { owner, response: JSON.stringify({ response: "safe no-progress" }), now, noProgress: {
        stepId: "step-denial-3", finalItemId: "final-item", finalContent: { text: "safe no-progress" }, stepCount: 3, toolCallCount: 0,
        usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, inputThroughSequence: 8n, consumedInputIds: ["accepted-8"],
        reasonCode: "repeated_signature", signature: "task_graph_terminal_denial", stateFingerprint: "task_graph_terminal_denial",
        taskGraphDenialCheckpoint: checkpoint, readTaskGraphDenialCheckpoint: readCheckpoint,
      } }
      const result = await store.recordFinalResponse(input)
      return { result, calls, client, store, input, readCheckpoint }
    }

    const inputWins = await run(true)
    expect(inputWins.result).toEqual({ status: "input_changed" })
    expect(inputWins.calls.findIndex(call => call.sql.includes('FROM "agent_sessions"'))).toBeLessThan(inputWins.calls.findIndex(call => call.sql.includes('SELECT turn."id"')))
    expect(inputWins.calls.find(call => call.sql.includes('FROM "agent_inputs"'))?.sql).toContain('"acceptedSequence">$4 FOR UPDATE')
    expect(inputWins.calls.some(call => /^(INSERT|UPDATE) "agent_(items|steps|turns|events|outbox)"/.test(call.sql))).toBe(false)
    expect(inputWins.readCheckpoint).not.toHaveBeenCalled()

    const terminalWins = await run(false)
    expect(terminalWins.result).toMatchObject({ status: "no_progress", finalItemId: "final-item" })
    if (terminalWins.result?.status !== "no_progress") throw new Error("Expected atomic no-progress terminal receipt")
    const indexOf = (needle: string) => terminalWins.calls.findIndex(call => call.sql.includes(needle))
    expect(indexOf('FROM "agent_sessions"')).toBeLessThan(indexOf('SELECT turn."id"'))
    expect(indexOf('FROM "agent_inputs"')).toBeLessThan(indexOf('INSERT INTO "agent_items"'))
    expect(terminalWins.calls.find(call => call.sql.includes('UPDATE "agent_turns"'))?.sql).toContain('"revision"="revision"+1')
    expect(terminalWins.calls.find(call => call.sql.includes('UPDATE "agent_steps"'))?.sql).toContain('SET "status"=\'failed\'')
    const eventInserts = terminalWins.calls.filter(call => call.sql.includes('INSERT INTO "agent_events"'))
    const chronologyWitness = eventInserts.find(call => call.values?.includes(ROOT_TASK_HISTORY_CHRONOLOGY_WITNESS_EVENT_TYPE))
    const terminalEvents = eventInserts.filter(call => !call.values?.includes(ROOT_TASK_HISTORY_CHRONOLOGY_WITNESS_EVENT_TYPE))
    expect(terminalEvents.map(call => call.values?.[6])).toEqual(["step.completed", "turn.no_progress", "item.started", "item.completed", "turn.failed"])
    expect(chronologyWitness?.values?.[7]).toBe(`root-task-history-chronology-witness:root_terminal:${terminalEvents.at(-1)?.values?.[0]}:v1`)
    expect(JSON.parse(String(chronologyWitness?.values?.[8]))).toMatchObject({ boundary: "root_terminal", xid8: "42" })
    expect(JSON.parse(String(terminalEvents[0]?.values?.[11]))).toMatchObject({ status: "failed", errorCode: "no_progress" })
    expect(terminalEvents[0]?.values?.[9]).toBe("step-started-event")
    for (let index = 1; index < terminalEvents.length; index += 1) expect(terminalEvents[index]?.values?.[9]).toBe(terminalEvents[index - 1]?.values?.[0])
    expect(terminalEvents.at(-1)?.values?.[10]).toBe(`turn:${owner.turnId}:event:turn-failed:no_progress`)
    expect(terminalWins.result.events.map(event => event.causationId)).toEqual([
      "step-started-event", ...terminalEvents.slice(0, -1).map(call => String(call.values?.[0])),
    ])
    expect(terminalWins.readCheckpoint).toHaveBeenCalledWith(terminalWins.client)
    expect(cleanupFailedRootTaskGraphMock).toHaveBeenCalledWith(terminalWins.client,
      expect.objectContaining({ id: owner.taskId, rootTaskId: owner.taskId }), { kind: "terminal-failed-turn-recovery" }, now)
    expect(terminalWins.calls.at(-1)?.sql).toBe("COMMIT")
    expect(terminalWins.client.release).toHaveBeenCalledOnce()
    await expect(terminalWins.store.recordFinalResponse(terminalWins.input)).rejects.toThrow(/no-progress Step .* fence/)
    expect(terminalEvents).toHaveLength(5)
    expect(eventInserts).toHaveLength(6)
    expect(terminalWins.calls.filter(call => call.sql.includes('INSERT INTO "agent_items"'))).toHaveLength(1)
    expect(terminalWins.calls.filter(call => call.sql.includes('UPDATE "agent_steps"'))).toHaveLength(1)
    expect(terminalWins.calls.filter(call => call.sql.includes('UPDATE "agent_turns"'))).toHaveLength(1)
    assertDenseBindings(terminalWins.calls)

    cleanupFailedRootTaskGraphMock.mockClear()
    const graphChanged = await run(false, true)
    expect(graphChanged.result).toEqual({ status: "input_changed" })
    expect(graphChanged.readCheckpoint).toHaveBeenCalledWith(graphChanged.client)
    expect(graphChanged.calls.some(call => /^(INSERT|UPDATE) "agent_(items|steps|turns|events|outbox)"/.test(call.sql))).toBe(false)
    expect(cleanupFailedRootTaskGraphMock).not.toHaveBeenCalled()
  })

  it("locks the owner before updating a Step or Item", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
    const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: "turn-1" }], rowCount: 1 }
      if (sql.includes('SELECT item."id"')) return { rows: [{ id: "item-1" }], rowCount: 1 }
      if (sql.includes('UPDATE "agent_items"')) return { rows: [{ id: "item-1", revision: 1 }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await store.updateStep({ owner, stepId: "step-1", status: "completed", finishReason: "done", errorCode: null, inputTokens: 1, outputTokens: 2, estimatedCostUsd: 0.01, now })
    await store.updateItem({ owner, itemId: "item-1", expectedRevision: 0, status: "completed", phase: "commentary", content: { text: "done" }, startedAt: now, completedAt: now, now })
    const stepUpdate = calls.find(call => call.sql.includes('UPDATE "agent_steps"'))
    expect(stepUpdate?.sql).toContain("THEN $7::timestamp(3) ELSE NULL::timestamp(3) END")
    expect(stepUpdate?.values?.[6]).toBe(now)
    const locks = calls.reduce<number[]>((indices, call, index) => call.sql.includes('SELECT turn."id"') ? [...indices, index] : indices, [])
    const updates = calls.reduce<number[]>((indices, call, index) => call.sql.includes('UPDATE "agent_') ? [...indices, index] : indices, [])
    expect(locks).toHaveLength(2)
    expect(locks[0]).toBeLessThan(updates[0])
    expect(locks[1]).toBeLessThan(updates[1])
  })

  it("rejects stale step lineage before create fallback or event linkage", async () => {
    const calls: string[] = []
    const client = { query: vi.fn(async (sql: string) => {
      calls.push(sql)
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: "turn-1" }], rowCount: 1 }
      if (sql.includes('SELECT "id" FROM "agent_steps"') || sql.includes('SELECT item."id"')) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await expect(store.createItem({ owner: childOwner, itemId: "item-old", stepId: "step-old", type: "tool_result", status: "started", phase: "commentary", content: {}, now })).rejects.toThrow(/step step-old lineage/)
    await expect(store.appendEvent({ owner: childOwner, id: "event-old", itemId: "item-old", type: "tool.result", correlationId: "turn-1", causationId: null, idempotencyKey: "event-old", payload: {} })).rejects.toThrow(/item item-old lineage/)
    expect(calls.some(sql => sql.includes('INSERT INTO "agent_items"'))).toBe(false)
    expect(calls.some(sql => sql.includes('INSERT INTO "agent_events"'))).toBe(false)
  })

  it.each(["aborted", "archived"])("rejects every mutating path for a %s session before any write", async status => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
    const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      if (sql === "BEGIN" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_sessions"')) {
        const sessionRows = ["aborted", "archived"].includes(status) ? [] : [{ id: "session-1" }]
        return { rows: sessionRows, rowCount: sessionRows.length }
      }
      return { rows: [{ id: "unexpected" }], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    const operations: Array<() => Promise<unknown>> = [
      () => store.appendEvent({ owner, id: `closed-event-${status}`, itemId: null, type: "turn.started", correlationId: "closed", causationId: null, idempotencyKey: `closed:${status}:event`, payload: {} }),
      () => store.startStep({ owner, stepId: `closed-step-${status}`, ordinal: 0, attempt: 1, inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: {}, now }),
      () => store.updateStep({ owner, stepId: "closed-step", status: "completed", finishReason: "done", errorCode: null, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, now }),
      () => store.waitForUser!({ owner, now }),
      () => store.createItem({ owner, itemId: `closed-item-${status}`, stepId: null, type: "agent_message", status: "started", phase: "commentary", content: {}, now }),
      () => store.updateItem({ owner, itemId: "closed-item", expectedRevision: 0, status: "completed", phase: "commentary", content: {}, startedAt: now, completedAt: now, now }),
      () => store.recordFinalResponse!({ owner, response: "closed", now }),
    ]
    for (const operation of operations) await expect(operation()).rejects.toMatchObject({ name: "TurnEnginePersistenceConflict" })

    const sessionLocks = calls.filter(({ sql }) => sql.includes('FROM "agent_sessions"'))
    expect(sessionLocks).toHaveLength(operations.length)
    expect(sessionLocks.every(({ sql, values }) => sql.includes('"status" NOT IN (\'aborted\', \'archived\')')
      && sql.includes("FOR UPDATE") && values?.[0] === owner.sessionId && values?.[1] === owner.userId)).toBe(true)
    const workQueries = calls.filter(({ sql }) => sql !== "BEGIN" && sql !== "ROLLBACK" && !sql.includes("set_config"))
    expect(workQueries.every(({ sql }) => sql.includes('FROM "agent_sessions"'))).toBe(true)
    expect(calls.some(({ sql }) => sql.includes('SELECT turn."id"'))).toBe(false)
    expect(calls.some(({ sql }) => sql.includes('INSERT INTO "agent_steps"') || sql.includes('UPDATE "agent_steps"'))).toBe(false)
    expect(calls.some(({ sql }) => sql.includes('INSERT INTO "agent_items"') || sql.includes('UPDATE "agent_items"'))).toBe(false)
    expect(calls.some(({ sql }) => sql.includes('INSERT INTO "agent_events"') || sql.includes('UPDATE "agent_events"'))).toBe(false)
    expect(calls.some(({ sql }) => sql.includes('INSERT INTO "agent_outbox"') || sql.includes('UPDATE "agent_sessions"') || sql.includes('UPDATE "agent_turns"'))).toBe(false)
    expect(calls.filter(({ sql }) => sql === "ROLLBACK")).toHaveLength(operations.length)
  })
})
