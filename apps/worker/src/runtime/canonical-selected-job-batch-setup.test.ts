import type pg from "pg"
import { describe, expect, it, vi } from "vitest"
import {
  SELECTED_JOB_BATCH_PREPARATION_INTENT,
  VERIFIED_SHORTLIST_SELECTION_SCHEMA,
} from "@jobcopilot/agent-protocol"

const { loadGraphMock } = vi.hoisted(() => ({ loadGraphMock: vi.fn() }))
vi.mock("./subagents/task-graph-pg-state.js", () => ({ loadTaskGraph: loadGraphMock }))

import { canonicalSelectedJobBatchRuntimeAvailable, failCanonicalSelectedJobBatchUnavailable, prepareCanonicalSelectedJobBatchForTurn, prepareCanonicalSelectedJobBatchSetup } from "./canonical-selected-job-batch-setup.js"
import type { CanonicalTurnState } from "./canonical-turn-state.js"
import { taskGraphItemId } from "./subagents/task-graph-snapshot.js"
import type { TurnLease } from "./turns/lease.js"

const lease: TurnLease = {
  turnId: "batch-turn", sessionId: "session-1", userId: "user-1", ownerId: "worker-1", leaseVersion: 3,
  leaseStartedAt: new Date("2026-11-22T10:00:00Z"), leaseExpiresAt: new Date("2026-11-22T10:01:00Z"),
}
const source = {
  sessionId: lease.sessionId, sourceTurnId: "discovery-turn", rootTaskId: "discovery-root",
  graphItemId: taskGraphItemId("discovery-root"), graphRevision: 12,
}
const binding = { schemaVersion: VERIFIED_SHORTLIST_SELECTION_SCHEMA, source, selectedJobIds: ["job-1", "job-2"] }
const shortlist = { schemaVersion: 1, status: "completed", failures: [], items: [
  { jobId: "job-1", score: 9, evidenceIds: ["read:job:job-1"] },
  { jobId: "job-2", score: 8, evidenceIds: ["read:job:job-2"] },
] }

function batchState(overrides: Partial<CanonicalTurnState> = {}): CanonicalTurnState {
  return {
    scope: { userId: lease.userId }, source: "user", intent: SELECTED_JOB_BATCH_PREPARATION_INTENT,
    goal: "Prepare selected jobs", turnInput: { goal: "Prepare selected jobs", intent: SELECTED_JOB_BATCH_PREPARATION_INTENT,
      verifiedShortlistSelection: binding }, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {}, snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
    ...overrides,
  }
}

type FixtureOptions = Readonly<{
  currentRootTaskId?: string | null
  rowRootTaskId?: string | null
  graphRevision?: number
  failJobQuery?: boolean
  state?: CanonicalTurnState
  forTurn?: boolean
  completionGate?: () => unknown
  runtimeAvailable?: boolean
  signal?: AbortSignal
}>

async function run(options: FixtureOptions = {}) {
  const currentRootTaskId = options.currentRootTaskId === undefined ? null : options.currentRootTaskId
  const rowRootTaskId = options.rowRootTaskId === undefined ? currentRootTaskId : options.rowRootTaskId
  const calls: Array<{ sql: string; values: readonly unknown[] }> = []
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    calls.push({ sql, values })
    if (sql.includes('FROM "Job"') && options.failJobQuery) throw new Error("fixture query failure")
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [] }
    if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: lease.sessionId }] }
    if (sql.includes('FROM "agent_turns"')) {
      if (sql.includes("selected_job_batch_preparation")) return { rows: [{
        id: lease.turnId, sessionId: lease.sessionId, userId: lease.userId, source: "user", status: "in_progress",
        executionMode: "canonical_task_graph", rootTaskId: rowRootTaskId, leaseOwnerId: lease.ownerId,
        leaseVersion: lease.leaseVersion, input: { intent: SELECTED_JOB_BATCH_PREPARATION_INTENT, verifiedShortlistSelection: binding },
      }] }
      return { rows: [{ id: source.sourceTurnId, sessionId: lease.sessionId, userId: lease.userId, source: "user",
        status: "completed", executionMode: null, rootTaskId: source.rootTaskId,
        input: { intent: { kind: "interactive_discovery_shortlist", version: 1 } } }] }
    }
    if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [{
      id: source.rootTaskId, sessionId: lease.sessionId, turnId: source.sourceTurnId, rootTaskId: source.rootTaskId,
      parentTaskId: null, role: "orchestrator", taskType: "root", status: "completed", failureReason: null,
      result: { status: "completed", structuredResult: { interactiveDiscoveryShortlist: shortlist } },
    }] }
    if (sql.includes('FROM "Job"')) return { rows: [{ id: "job-1" }, { id: "job-2" }] }
    throw new Error("unexpected fixture query")
  })
  const release = vi.fn()
  const client = { query, release } as unknown as pg.PoolClient
  const pool = { connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">
  loadGraphMock.mockResolvedValue({
    rootTaskId: source.rootTaskId,
    item: { id: source.graphItemId, revision: options.graphRevision ?? source.graphRevision, content: {}, createdAt: new Date(0) },
    snapshot: { nodes: [{ key: "source", taskId: "source-task" }] }, state: {}, tasks: new Map(),
  })
  const state = options.state ?? batchState()
  const result = options.forTurn
    ? await prepareCanonicalSelectedJobBatchForTurn({ pool, lease, state, currentRootTaskId, signal: options.signal ?? new AbortController().signal,
      completionGate: options.completionGate as never, runtimeAvailable: options.runtimeAvailable ?? true })
    : await prepareCanonicalSelectedJobBatchSetup({ pool, lease, state, currentRootTaskId })
  return { result, calls, connect: pool.connect, release }
}

describe("canonical selected-job batch setup proof", () => {
  it("creates two isolated role-preset pairs on a genuine first claim with a null Root", async () => {
    const { result, calls, connect, release } = await run()

    expect(result.status).toBe("ready")
    if (result.status !== "ready") return
    expect(result.slots).toEqual([{ slotId: "slot-1", jobId: "job-1" }, { slotId: "slot-2", jobId: "job-2" }])
    expect(result.templates.cover_letter_writer_slot_1).toMatchObject({
      role: "writer", allowedActions: ["artifact.version.read", "cover_letter.draft"], context: { selectedJobPreparation: { jobId: "job-1" } },
    })
    expect(result.templates.cover_letter_reviewer_slot_1).toMatchObject({
      role: "reviewer", allowedActions: ["artifact.version.read", "artifact.review"], context: { selectedJobPreparation: { jobId: "job-1" } },
    })
    expect(result.templates.cover_letter_writer_slot_2).toMatchObject({ context: { selectedJobPreparation: { jobId: "job-2" } } })
    expect(result.templates.cover_letter_reviewer_slot_2).toMatchObject({ context: { selectedJobPreparation: { jobId: "job-2" } } })
    expect(calls.find(call => call.sql.includes("selected_job_batch_preparation"))?.values[5]).toBeNull()
    expect(calls[0]?.sql).toBe("BEGIN")
    expect(calls[1]?.sql).toContain("set_config")
    expect(calls.some(call => call.sql === "COMMIT")).toBe(true)
    expect(calls.some(call => call.sql === "ROLLBACK")).toBe(false)
    expect(connect).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
  })

  it("revalidates the exact observed Root when resuming setup", async () => {
    const { result, calls } = await run({ currentRootTaskId: "batch-root" })

    expect(result.status).toBe("ready")
    expect(calls.find(call => call.sql.includes("selected_job_batch_preparation"))?.values[5]).toBe("batch-root")
  })

  it("rolls back and releases the client when source proof is stale or revalidation errors", async () => {
    for (const options of [
      { graphRevision: source.graphRevision - 1 },
      { currentRootTaskId: "batch-root", rowRootTaskId: "other-root" },
      { failJobQuery: true },
    ]) {
      const { result, calls, release } = await run(options)
      expect(result).toEqual({ status: "unavailable" })
      expect(calls.some(call => call.sql === "COMMIT")).toBe(false)
      expect(calls.some(call => call.sql === "ROLLBACK")).toBe(true)
      expect(release).toHaveBeenCalledOnce()
    }
  })

  it.each([
    ["orphan binding with prior intent", batchState({ intent: { kind: "objective_task_graph_execution", version: 1 },
      turnInput: { intent: { kind: "objective_task_graph_execution", version: 1 }, verifiedShortlistSelection: binding } })],
    ["raw batch marker not restored by state decoder", batchState({ intent: undefined,
      turnInput: { intent: SELECTED_JOB_BATCH_PREPARATION_INTENT, verifiedShortlistSelection: binding } })],
    ["missing binding", batchState({ turnInput: { intent: SELECTED_JOB_BATCH_PREPARATION_INTENT } })],
    ["mismatched raw intent", batchState({ turnInput: { intent: { kind: "objective_task_graph_execution", version: 1 }, verifiedShortlistSelection: binding } })],
    ["malformed binding", batchState({ turnInput: { intent: SELECTED_JOB_BATCH_PREPARATION_INTENT,
      verifiedShortlistSelection: { ...binding, selectedJobIds: ["job-1"] } } })],
    ["foreign owner", batchState({ scope: { userId: "other-user" } })],
    ["non-user Turn", batchState({ source: "automation" })],
  ])("fails closed for %s without opening a transaction", async (_case, state) => {
    const { result, connect } = await run({ state })

    expect(result).toEqual({ status: "unavailable" })
    expect(connect).not.toHaveBeenCalled()
  })

  it("leaves ordinary user Turns to their existing setup", async () => {
    for (const intent of [
      { kind: "interactive_discovery_shortlist", version: 1 },
      { kind: "objective_task_graph_execution", version: 1 },
    ] as const) {
      const state = batchState({ intent, turnInput: { intent } })
      const { result, connect } = await run({ state })

      expect(result).toEqual({ status: "not_batch" })
      expect(connect).not.toHaveBeenCalled()
    }
  })

  it("requires the trusted completion factory and runtime prerequisites before batch setup is returned", async () => {
    const missingGate = await run({ forTurn: true })
    expect(missingGate.result).toEqual({ status: "unavailable" })
    const gateWithoutPrerequisites = await run({ forTurn: true, completionGate: () => undefined, runtimeAvailable: false })
    expect(gateWithoutPrerequisites.result).toEqual({ status: "unavailable" })
    const ready = await run({ forTurn: true, completionGate: () => undefined })
    expect(ready.result.status).toBe("ready")
  })

  it("propagates abort for a claimed batch before opening a proof transaction", async () => {
    const controller = new AbortController()
    controller.abort(new Error("batch_cancelled"))
    const connect = vi.fn()
    await expect(prepareCanonicalSelectedJobBatchForTurn({ pool: { connect } as never, lease, state: batchState(), currentRootTaskId: null,
      signal: controller.signal, completionGate: (() => undefined) as never, runtimeAvailable: true })).rejects.toThrow("batch_cancelled")
    expect(connect).not.toHaveBeenCalled()
  })

  it("requires the concrete command-port operations used by planning and terminal verification", () => {
    const commandPort = { appendAndScheduleWithReconciliation() {}, readCurrentWithClient() {} } as never
    const common = { enabled: true, coordination: true, childExecution: true, consumeWaitOutcomes: true, commandPort, rootCompletion: true }
    expect(canonicalSelectedJobBatchRuntimeAvailable(common)).toBe(true)
    expect(canonicalSelectedJobBatchRuntimeAvailable({ ...common, commandPort: {} as never })).toBe(false)
    expect(canonicalSelectedJobBatchRuntimeAvailable({ ...common, rootCompletion: false })).toBe(false)
  })

  it("finishes unavailable batches with an empty Root action list and failed projections", async () => {
    const root = { id: "batch-root", attemptCount: 1 }
    const ensure = vi.fn(async (input: { allowedActions: string[] }) => { expect(input.allowedActions).toEqual([]); return root })
    const finish = vi.fn(), executionFinish = vi.fn(), sessionFinish = vi.fn()
    await expect(failCanonicalSelectedJobBatchUnavailable({ lease, state: batchState(), rootTasks: { ensure, finish } as never,
      executionProjection: { finish: executionFinish } as never, sessionProjection: { finish: sessionFinish } as never, now: () => new Date(0) }))
      .resolves.toEqual({ status: "failed", summary: "selected_job_batch_unavailable" })
    expect(finish).toHaveBeenCalledOnce()
    expect(executionFinish).toHaveBeenCalledOnce()
    expect(sessionFinish).toHaveBeenCalledOnce()
  })
})
