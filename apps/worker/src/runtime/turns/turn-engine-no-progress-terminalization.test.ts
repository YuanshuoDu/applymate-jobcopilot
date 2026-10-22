import { beforeEach, describe, expect, it, vi } from "vitest"
import { SESSION_WORK_ADMISSION } from "../session-gate.js"
import type { AtomicTurnNoProgressInput, TurnEngineEventInput } from "./turn-engine-types.js"
import type { TurnEnginePool, TurnEngineQueryClient } from "./turn-engine-owner-sql.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"
import { TASK_GRAPH_DENIAL_CHECKPOINT_SCHEMA, type TaskGraphDenialCheckpoint } from "./task-graph-terminal-assessment.js"
import { NoProgressError } from "../progress.js"
import { commitTurnNoProgress, matchedTaskGraphDenialCheckpoint, terminalizeNoProgressFailure, withTaskGraphDenialCheckpoint } from "./turn-engine-no-progress-terminalization.js"
import { stopForRepeatedTaskGraphDenial } from "./turn-execution-final-candidate.js"

const { cleanupMock } = vi.hoisted(() => ({ cleanupMock: vi.fn(async () => undefined) }))
vi.mock("../subagents/task-graph-pg-root-failure-cleanup.js", () => ({ cleanupFailedRootTaskGraph: cleanupMock }))
beforeEach(() => cleanupMock.mockReset().mockResolvedValue(undefined))

const owner = {
  kind: "turn" as const, userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1",
  ownerId: "owner-1", leaseVersion: 4, leaseExpiresAt: new Date("2026-10-20T12:01:00.000Z"),
}
const now = new Date("2026-10-20T12:00:10.000Z")
const denial = {
  stepId: "step-3", finalItemId: "final-3", finalContent: { text: "safe stop" }, stepCount: 3, toolCallCount: 2,
  usage: { inputTokens: 12, outputTokens: 4, estimatedCostUsd: 0.001 }, inputThroughSequence: 8n, consumedInputIds: ["input-8"],
  reasonCode: "repeated_signature", signature: "task_graph_terminal_denial", stateFingerprint: "task_graph_terminal_denial",
}
const response = JSON.stringify({ completed: false, terminalReason: "no_progress", response: "safe stop" })
const checkpoint: TaskGraphDenialCheckpoint = { schemaVersion: TASK_GRAPH_DENIAL_CHECKPOINT_SCHEMA, taskId: owner.rootTaskId, graphRevision: 3, verificationDigest: "a".repeat(64) }

function fixture(input: { pending?: boolean; staleStepFence?: boolean; readCheckpoint?: (client?: TurnEngineQueryClient) => Promise<TaskGraphDenialCheckpoint | null> } = {}) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
  const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
    calls.push({ sql, values })
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
    if (sql.includes(SESSION_WORK_ADMISSION)) return { rows: [{ id: owner.sessionId }], rowCount: 1 }
    if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: owner.sessionId }], rowCount: 1 }
    if (sql.includes('SELECT turn."id"')) return { rows: [{ id: owner.turnId }], rowCount: 1 }
    if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [{ id: owner.taskId, status: "running", leaseOwner: owner.ownerId, attemptCount: 1, interruptRequestedAt: null }], rowCount: 1 }
    if (sql.includes('FROM "agent_steps"')) return { rows: [{ status: "streaming", inputThroughSequence: input.staleStepFence ? "7" : "8", consumedInputIds: ["input-8"] }], rowCount: 1 }
    if (sql.includes('FROM "agent_inputs"')) return input.pending ? { rows: [{ id: "accepted-9" }], rowCount: 1 } : { rows: [], rowCount: 0 }
    if (sql.includes('FROM "agent_events"')) return { rows: [{ id: "step-start-event" }], rowCount: 1 }
    if (sql.includes('INSERT INTO "agent_items"')) return { rows: [{ id: denial.finalItemId }], rowCount: 1 }
    return { rows: [], rowCount: 1 }
  }), release: vi.fn() }
  const pool = { connect: vi.fn(async () => client) } as unknown as TurnEnginePool
  const appendEvents = vi.fn(async (_pool: TurnEnginePool, events: readonly TurnEngineEventInput[], _client: TurnEngineQueryClient) => events.map((event, index) => ({ id: `event-${index + 1}` })))
  const readCheckpoint = vi.fn(input.readCheckpoint ?? (async () => checkpoint))
  return { pool, client, calls, appendEvents, readCheckpoint }
}

function withCheckpoint(readCheckpoint: (client?: TurnEngineQueryClient) => Promise<TaskGraphDenialCheckpoint | null>): AtomicTurnNoProgressInput {
  return { ...denial, taskGraphDenialCheckpoint: checkpoint, readTaskGraphDenialCheckpoint: readCheckpoint }
}

describe("atomic no-progress terminalization", () => {
  it.each([{ pending: true }, { staleStepFence: true }])("returns input_changed without terminal writes when the input or Step fence changed", async race => {
    const fake = fixture(race)
    await expect(commitTurnNoProgress(fake.pool, owner, response, now, withCheckpoint(fake.readCheckpoint), fake.appendEvents)).resolves.toEqual({ status: "input_changed" })
    expect(fake.appendEvents).not.toHaveBeenCalled()
    expect(cleanupMock).not.toHaveBeenCalled()
    expect(fake.calls.some(({ sql }) => /^(INSERT|UPDATE) "(?:agent_items|agent_steps|agent_turns|sub_agent_tasks|agent_events|agent_outbox|agent_inputs)"/.test(sql))).toBe(false)
    expect(fake.calls.at(-1)?.sql).toBe("COMMIT")
  })

  it("leaves generic no-progress errors on the existing terminal path", async () => {
    const recordFinalResponse = vi.fn()
    const result = await terminalizeNoProgressFailure({
      error: new NoProgressError({ signature: "ordinary_repeat", stateFingerprint: "ordinary_state" }),
      options: { store: { recordFinalResponse } } as never, writer: {} as never, step: { id: "step-3" } as never,
      stepOpen: true, stepCount: 3, toolCallCount: 2, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      now: () => now, inputThroughSequence: 8n, consumedInputIds: ["input-8"],
    })
    expect(result).toBeNull()
    expect(recordFinalResponse).not.toHaveBeenCalled()

    const fake = fixture()
    await expect(commitTurnNoProgress(fake.pool, owner, response, now, { ...denial, signature: "ordinary_repeat" }, fake.appendEvents))
      .rejects.toMatchObject({ name: "TurnEnginePersistenceConflict" })
    expect(fake.pool.connect).not.toHaveBeenCalled()
  })
  it("fails the owned Turn and exact root, cancels follow-ups, and runs graph cleanup in the same transaction", async () => {
    const fake = fixture()
    const terminal = await commitTurnNoProgress(fake.pool, owner, response, now, withCheckpoint(fake.readCheckpoint), fake.appendEvents)
    if (terminal.status !== "no_progress") throw new Error("Expected a no-progress receipt")

    expect(terminal).toMatchObject({ status: "no_progress", finalItemId: denial.finalItemId, events: [
      { type: "step.completed", causationId: "step-start-event" }, { type: "turn.no_progress" },
      { type: "item.started" }, { type: "item.completed" }, { type: "turn.failed" },
    ] })
    expect(terminal.events.map(event => event.causationId)).toEqual([
      "step-start-event", "event-1", "event-2", "event-3", "event-4",
    ])
    expect(fake.calls.find(({ sql }) => sql.includes("SELECT turn.\"id\""))?.sql).toContain("FOR UPDATE")
    expect(fake.calls.some(({ sql }) => sql.includes('UPDATE "agent_turns"') && sql.includes("SET \"status\"='failed'"))).toBe(true)
    expect(fake.calls.some(({ sql }) => sql.includes('UPDATE "sub_agent_tasks"') && sql.includes("SET \"status\"='failed'"))).toBe(true)
    expect(fake.calls.some(({ sql }) => sql.includes('UPDATE "agent_inputs"') && sql.includes("'follow_up'"))).toBe(true)
    const cleanupIndex = cleanupMock.mock.invocationCallOrder[0]
    const turnUpdateIndex = fake.client.query.mock.invocationCallOrder[fake.calls.findIndex(({ sql }) => sql.includes('UPDATE "agent_turns"'))]!
    expect(cleanupIndex).toBeGreaterThan(turnUpdateIndex)
    expect(cleanupMock).toHaveBeenCalledWith(fake.client, expect.objectContaining({ id: owner.taskId, rootTaskId: owner.taskId }), { kind: "terminal-failed-turn-recovery" }, now)
    expect(fake.readCheckpoint).toHaveBeenCalledWith(fake.client)
    const graphReadOrder = fake.readCheckpoint.mock.invocationCallOrder[0]!
    const rootLockOrder = fake.client.query.mock.invocationCallOrder[fake.calls.findIndex(({ sql }) => sql.includes('SELECT "id","status","leaseOwner"'))]!
    const firstWriteOrder = fake.client.query.mock.invocationCallOrder[fake.calls.findIndex(({ sql }) => sql.includes('INSERT INTO "agent_items"'))]!
    expect(graphReadOrder).toBeGreaterThan(rootLockOrder)
    expect(graphReadOrder).toBeLessThan(firstWriteOrder)
    expect(fake.calls.at(-1)?.sql).toBe("COMMIT")
  })

  it("refreshes instead of failing when the TaskGraph checkpoint changes before the transaction read", async () => {
    const changed: TaskGraphDenialCheckpoint = { ...checkpoint, graphRevision: 4, verificationDigest: "b".repeat(64) }
    const fake = fixture({ readCheckpoint: async client => client ? changed : checkpoint })
    const recordFinalResponse = vi.fn(async (input: { response: string; now: Date; noProgress?: AtomicTurnNoProgressInput }) => {
      if (!input.noProgress) throw new Error("expected no-progress receipt")
      return commitTurnNoProgress(fake.pool, owner, input.response, input.now, input.noProgress, fake.appendEvents)
    })
    const context = { taskGraphRevision: checkpoint.graphRevision, inputThroughSequence: denial.inputThroughSequence, consumedInputIds: denial.consumedInputIds }
    const matched = await matchedTaskGraphDenialCheckpoint(async (_context, _taskId, read) => { await read?.(); return true }, context, owner.rootTaskId, fake.readCheckpoint)
    expect(matched).toEqual(checkpoint)
    if (!matched) throw new Error("Expected a matched checkpoint")
    const options = withTaskGraphDenialCheckpoint({ identity: owner, goal: "complete the TaskGraph", store: { recordFinalResponse } } as unknown as TurnExecutionOptions, matched, fake.readCheckpoint)

    await expect(stopForRepeatedTaskGraphDenial({
      options, writer: {} as never, step: { id: denial.stepId } as never, context: context as never,
      stepCount: 3, toolCallCount: 2, usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.01 }, now: () => now,
    })).rejects.toMatchObject({ name: "TurnStateRefreshRetryError" })

    expect(fake.readCheckpoint.mock.calls.map(([client]) => client)).toEqual([undefined, fake.client])
    expect(fake.appendEvents).not.toHaveBeenCalled()
    expect(cleanupMock).not.toHaveBeenCalled()
    expect(fake.calls.some(({ sql }) => /^(INSERT|UPDATE) "(?:agent_items|agent_steps|agent_turns|sub_agent_tasks|agent_events|agent_outbox|agent_inputs)"/.test(sql))).toBe(false)
    expect(fake.calls.at(-1)?.sql).toBe("COMMIT")
  })
})
