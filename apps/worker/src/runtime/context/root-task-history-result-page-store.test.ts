import { beforeEach, describe, expect, it, vi } from "vitest"
import { ROLE_RESULT_SCHEMA } from "../subagents/role-results.js"
import { TASK_GRAPH_RESULT_SOURCE_BYTE_LIMIT } from "../subagents/task-graph-result-page-contract.js"
import { TASK_GRAPH_TEMPLATES } from "../subagents/task-graph-templates.js"
import { taskGraphLifecycleKey, parseTaskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION, taskGraphState } from "../subagents/task-graph-snapshot.js"
import type { LoadedGraph, GraphTaskRow } from "../subagents/task-graph-pg-state.js"
import type { RootTaskHistoryCandidate } from "./root-task-history-source-store.js"
import { createPgRootTaskHistoryResultPageStore } from "./root-task-history-result-page-store.js"

const doubles = vi.hoisted(() => ({ readFence: vi.fn(), readCandidates: vi.fn(), loadTaskGraph: vi.fn() }))
vi.mock("./root-task-history-fence.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./root-task-history-fence.js")>()
  return { ...actual, readRootTaskHistoryFence: doubles.readFence }
})
vi.mock("./root-task-history-source-store.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./root-task-history-source-store.js")>()
  return { ...actual, readRootTaskHistoryCandidates: doubles.readCandidates }
})
vi.mock("../subagents/task-graph-pg-state.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../subagents/task-graph-pg-state.js")>()
  return { ...actual, loadTaskGraph: doubles.loadTaskGraph }
})

const scope = { userId: "current-user", sessionId: "current-session", turnId: "current-turn", rootTaskId: "current-root",
  parentTaskId: "current-root", stepId: "current-step", turnLeaseOwner: "turn-owner", turnLeaseVersion: 3,
  parentLeaseOwner: "turn-owner", parentAttemptCount: 2 } as const
const source = (index: number): RootTaskHistoryCandidate => ({ sessionId: `source-session-${index}`, turnId: `source-turn-${index}`,
  rootTaskId: `source-root-${index}`, terminalSequence: BigInt(index * 2) })
const id = (index: number) => `c${String(index).padStart(24, "0")}`
const registeredScoutEnvelope = { role: TASK_GRAPH_TEMPLATES.scout.role, taskType: TASK_GRAPH_TEMPLATES.scout.taskType,
  expectedOutputSchema: TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema, allowedActions: [...TASK_GRAPH_TEMPLATES.scout.allowedActions] }

function graph(candidate: RootTaskHistoryCandidate, jobIds: readonly string[]): LoadedGraph {
  const key = "ordinary-scout", taskId = `task-${candidate.rootTaskId}`
  const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{ key, taskId, templateId: "scout",
    goal: "Find relevant jobs", successCriteria: ["Find matching jobs"], dependsOn: [], depth: 1,
    verificationDisposition: "typed", verification: { schemaVersion: "agent-harness.v2.task-graph-verification.v1", role: "scout",
      criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }] },
    registeredScoutEnvelope }] })
  const evidence = jobIds.map(jobId => ({ id: `e-${jobId}`, kind: "job", ref: jobId, source: "greenhouse" }))
  const structuredResult = { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed", summary: "private text",
    candidates: jobIds.map(jobId => ({ jobId, source: "greenhouse", url: "https://private.invalid", evidenceIds: [`e-${jobId}`] })), evidence }
  const task: GraphTaskRow = { id: taskId, status: "completed", role: "scout", taskType: "job_discovery",
    expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }, failureReason: null, result: { structuredResult } }
  const events = (["task.started", "task.completed"] as const).map(type => ({ nodeKey: key, type,
    idempotencyKey: taskGraphLifecycleKey(candidate.rootTaskId, key, 1, type), expectedRevision: 1 }))
  const state = taskGraphState(snapshot, 1, new Map([[taskId, { status: "completed", failureReason: null }]]), events)
  return { rootTaskId: candidate.rootTaskId, snapshot, state, tasks: new Map([[taskId, task]]),
    item: { id: `item-${candidate.rootTaskId}`, revision: 1, content: snapshot, createdAt: new Date(0) } }
}

function harness(
  graphs: ReadonlyMap<string, LoadedGraph>,
  candidates: readonly RootTaskHistoryCandidate[],
  rollbackError?: Error,
) {
  const queries: Array<{ sql: string; values?: readonly unknown[] }> = []
  const timeline: Array<{ kind: "query"; sql: string } | { kind: "load" }> = []
  const transactionAtPreflight: boolean[] = [], transactionAtGraphLoad: boolean[] = []
  const releaseErrors: Array<Error | boolean | undefined> = []
  let transactionOpen = false
  let connectionCount = 0, releaseCount = 0
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      queries.push({ sql, values })
      timeline.push({ kind: "query", sql })
      if (sql.startsWith("BEGIN")) { transactionOpen = true; return { rows: [], rowCount: 1 } }
      if (sql === "COMMIT") { transactionOpen = false; return { rows: [], rowCount: 1 } }
      if (sql === "ROLLBACK") {
        if (rollbackError) throw rollbackError
        transactionOpen = false
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes("set_config")) return { rows: [], rowCount: 1 }
      if (sql.includes("SELECT NOT EXISTS")) {
        transactionAtPreflight.push(transactionOpen)
        const loaded = [...graphs.values()].find(item => item.rootTaskId === values?.[2])
        const withinLimit = [...(loaded?.tasks.values() ?? [])].every(task => task.result === null
          || JSON.stringify(task.result).length <= TASK_GRAPH_RESULT_SOURCE_BYTE_LIMIT)
        return { rows: [{ withinLimit }], rowCount: 1 }
      }
      if (sql.includes("SELECT task.\"id\", task.\"attemptCount\"")) {
        const resultRows = (values?.[0] as string[]).map(taskId => {
          const loaded = [...graphs.values()].find(item => item.tasks.has(taskId)), task = loaded?.tasks.get(taskId)
          return { id: taskId, attemptCount: 1, status: task?.status, role: task?.role, taskType: task?.taskType,
            expectedOutputSchema: task?.expectedOutputSchema, result: task?.result === null ? null : JSON.stringify(task?.result) }
        })
        return { rows: resultRows, rowCount: resultRows.length }
      }
      throw new Error(`unexpected query: ${sql}`)
    },
    release(error?: Error | boolean) { releaseCount += 1; releaseErrors.push(error) },
  }
  const pool = { connect: async () => { connectionCount += 1; return client } } as unknown as Pick<import("pg").Pool, "connect">
  doubles.readFence.mockResolvedValue({ objectiveDigest: "d".repeat(64) })
  doubles.readCandidates.mockResolvedValue(candidates)
  doubles.loadTaskGraph.mockImplementation(async (_client: unknown, graphScope: { turnId: string }) => {
    timeline.push({ kind: "load" })
    transactionAtGraphLoad.push(transactionOpen)
    return graphs.get(graphScope.turnId)!
  })
  return {
    store: createPgRootTaskHistoryResultPageStore(pool), queries, timeline, transactionAtPreflight, transactionAtGraphLoad,
    releaseErrors, get connectionCount() { return connectionCount }, get releaseCount() { return releaseCount },
  }
}

describe("historical Root Scout page store", () => {
  beforeEach(() => vi.clearAllMocks())

  it("fails closed when the Root task owner differs from its Turn lease owner", async () => {
    const candidate = source(1), test = harness(new Map([[candidate.turnId, graph(candidate, [id(1)])]]), [candidate])
    await expect(test.store.read({ ...scope, parentLeaseOwner: "different-root-owner" },
      { mode: "historical_discovery", offset: 0 })).resolves.toMatchObject({ availability: "unavailable", reason: "no_source" })
    expect(doubles.readFence).not.toHaveBeenCalled()
    expect(test.queries).toEqual([])
  })

  it("skips an empty newest source and scopes every child read to its selected historical graph", async () => {
    const newest = source(3), older = source(2)
    const graphs = new Map([[newest.turnId, graph(newest, [])], [older.turnId, graph(older, [id(1), id(2), id(3), id(4)])]])
    const test = harness(graphs, [newest, older])
    const page = await test.store.read(scope, { mode: "historical_discovery", offset: 0 })
    expect(page).toMatchObject({ availability: "available", sourceResultStatus: "completed", totalCount: 4, truncated: false,
      items: [{ jobId: id(1) }, { jobId: id(2) }, { jobId: id(3) }] })
    expect(doubles.loadTaskGraph.mock.calls.map(call => call[1])).toEqual([
      { userId: scope.userId, sessionId: newest.sessionId, turnId: newest.turnId, rootTaskId: newest.rootTaskId, parentTaskId: newest.rootTaskId },
      { userId: scope.userId, sessionId: older.sessionId, turnId: older.turnId, rootTaskId: older.rootTaskId, parentTaskId: older.rootTaskId },
    ])
    const childReads = test.queries.filter(query => query.sql.includes('SELECT task."id", task."attemptCount"'))
    expect(childReads.map(query => query.values?.slice(1))).toEqual([
      [newest.sessionId, newest.turnId, newest.rootTaskId, newest.rootTaskId, scope.userId],
      [older.sessionId, older.turnId, older.rootTaskId, older.rootTaskId, scope.userId],
    ])
    expect(test.queries.filter(query => query.sql.includes("SELECT NOT EXISTS")).map(query => query.values)).toEqual([
      [newest.sessionId, newest.turnId, newest.rootTaskId, scope.userId, TASK_GRAPH_RESULT_SOURCE_BYTE_LIMIT],
      [older.sessionId, older.turnId, older.rootTaskId, scope.userId, TASK_GRAPH_RESULT_SOURCE_BYTE_LIMIT],
    ])
  })

  it("bounds graph loads and returns unavailable when no source is eligible", async () => {
    const sources = Array.from({ length: 9 }, (_, index) => source(20 - index))
    const graphs = new Map(sources.map(candidate => [candidate.turnId, graph(candidate, [])]))
    const test = harness(graphs, sources)
    await expect(test.store.read(scope, { mode: "historical_discovery", offset: 0 })).resolves.toMatchObject({
      availability: "unavailable", reason: "no_source",
    })
    expect(doubles.loadTaskGraph).toHaveBeenCalledTimes(8)
    expect(test.queries.filter(query => query.sql.includes('SELECT task."id", task."attemptCount"'))).toHaveLength(8)
  })

  it("skips an oversized whole graph result before invoking the graph loader", async () => {
    const newest = source(3), older = source(2)
    const oversized = graph(newest, [id(9)]), taskId = `task-${newest.rootTaskId}`
    const task = oversized.tasks.get(taskId)!
    const oversizedTasks = new Map(oversized.tasks)
    oversizedTasks.set(taskId, { ...task, result: { finalText: "x".repeat(TASK_GRAPH_RESULT_SOURCE_BYTE_LIMIT + 1),
      structuredResult: (task.result as { structuredResult: unknown }).structuredResult } })
    const oversizedGraph: LoadedGraph = { ...oversized, tasks: oversizedTasks }
    const olderGraph = graph(older, [id(1), id(2), id(3)])
    const test = harness(new Map([[newest.turnId, oversizedGraph], [older.turnId, olderGraph]]), [newest, older])
    const page = await test.store.read(scope, { mode: "historical_discovery", offset: 0 })
    expect(page).toMatchObject({ availability: "available", items: [{ jobId: id(1) }, { jobId: id(2) }, { jobId: id(3) }] })
    expect(doubles.loadTaskGraph.mock.calls.map(call => call[1])).toEqual([
      { userId: scope.userId, sessionId: older.sessionId, turnId: older.turnId, rootTaskId: older.rootTaskId, parentTaskId: older.rootTaskId },
    ])
  })

  it("keeps the result-size preflight and graph load inside one repeatable-read snapshot", async () => {
    const candidate = source(1), test = harness(new Map([[candidate.turnId, graph(candidate, [id(1)])]]), [candidate])

    await expect(test.store.read(scope, { mode: "historical_discovery", offset: 0 }))
      .resolves.toMatchObject({ availability: "available" })

    const begin = test.timeline.findIndex(call => call.kind === "query" && call.sql === "BEGIN ISOLATION LEVEL REPEATABLE READ")
    const setUser = test.timeline.findIndex(call => call.kind === "query" && call.sql.includes("set_config"))
    const preflight = test.timeline.findIndex(call => call.kind === "query" && call.sql.includes("SELECT NOT EXISTS"))
    const load = test.timeline.findIndex(call => call.kind === "load")
    const resultRead = test.timeline.findIndex(call => call.kind === "query" && call.sql.includes('SELECT task."id", task."attemptCount"'))
    const commit = test.timeline.findIndex(call => call.kind === "query" && call.sql === "COMMIT")
    expect(begin).toBe(0)
    expect(setUser).toBeGreaterThan(begin)
    expect(preflight).toBeGreaterThan(setUser)
    expect(load).toBeGreaterThan(preflight)
    expect(resultRead).toBeGreaterThan(load)
    expect(commit).toBeGreaterThan(resultRead)
    expect(test.transactionAtPreflight).toEqual([true])
    expect(test.transactionAtGraphLoad).toEqual([true])
  })

  it("retries SQLSTATE 40001 in a fresh transaction and repeats the fence read", async () => {
    const candidate = source(1), test = harness(new Map([[candidate.turnId, graph(candidate, [id(1)])]]), [candidate])
    const serializationFailure = Object.assign(new Error("serialization failure"), { code: "40001" })
    doubles.readFence.mockRejectedValueOnce(serializationFailure)

    await expect(test.store.read(scope, { mode: "historical_discovery", offset: 0 }))
      .resolves.toMatchObject({ availability: "available" })

    expect(doubles.readFence).toHaveBeenCalledTimes(2)
    expect(test.connectionCount).toBe(2)
    expect(test.releaseCount).toBe(2)
    expect(test.queries.filter(query => query.sql.startsWith("BEGIN"))).toHaveLength(2)
    expect(test.queries.filter(query => query.sql === "ROLLBACK")).toHaveLength(1)
    expect(test.queries.filter(query => query.sql === "COMMIT")).toHaveLength(1)
  })

  it("revalidates the lease scope before retrying a serialization failure", async () => {
    const candidate = source(1), test = harness(new Map([[candidate.turnId, graph(candidate, [id(1)])]]), [candidate])
    const mutableScope = { ...scope, parentLeaseOwner: scope.parentLeaseOwner as string }
    const serializationFailure = Object.assign(new Error("serialization failure"), { code: "40001" })
    doubles.readFence.mockImplementationOnce(async () => {
      mutableScope.parentLeaseOwner = "changed-owner"
      throw serializationFailure
    })

    await expect(test.store.read(mutableScope, { mode: "historical_discovery", offset: 0 }))
      .resolves.toMatchObject({ availability: "unavailable", reason: "no_source" })

    expect(doubles.readFence).toHaveBeenCalledTimes(1)
    expect(test.connectionCount).toBe(1)
    expect(test.releaseCount).toBe(1)
    expect(test.queries.filter(query => query.sql === "ROLLBACK")).toHaveLength(1)
  })

  it("does not retry non-serialization errors and caps serialization retries", async () => {
    const candidate = source(1), test = harness(new Map([[candidate.turnId, graph(candidate, [id(1)])]]), [candidate])
    const uniqueViolation = Object.assign(new Error("unique violation"), { code: "23505" })
    doubles.readFence.mockRejectedValueOnce(uniqueViolation)
    await expect(test.store.read(scope, { mode: "historical_discovery", offset: 0 })).rejects.toBe(uniqueViolation)
    expect(test.connectionCount).toBe(1)
    expect(test.releaseCount).toBe(1)
    expect(doubles.readFence).toHaveBeenCalledTimes(1)
    expect(test.queries.filter(query => query.sql === "ROLLBACK")).toHaveLength(1)

    const bounded = harness(new Map([[candidate.turnId, graph(candidate, [id(1)])]]), [candidate])
    const serializationFailure = Object.assign(new Error("serialization failure"), { code: "40001" })
    doubles.readFence.mockClear().mockRejectedValue(serializationFailure)
    await expect(bounded.store.read(scope, { mode: "historical_discovery", offset: 0 })).rejects.toBe(serializationFailure)
    expect(doubles.readFence).toHaveBeenCalledTimes(3)
    expect(bounded.connectionCount).toBe(3)
    expect(bounded.releaseCount).toBe(3)
    expect(bounded.queries.filter(query => query.sql === "ROLLBACK")).toHaveLength(3)
  })

  it("does not retry or reuse a client when rollback fails", async () => {
    const candidate = source(1), rollbackFailure = new Error("rollback failed")
    const test = harness(new Map([[candidate.turnId, graph(candidate, [id(1)])]]), [candidate], rollbackFailure)
    const serializationFailure = Object.assign(new Error("serialization failure"), { code: "40001" })
    doubles.readFence.mockRejectedValueOnce(serializationFailure)

    await expect(test.store.read(scope, { mode: "historical_discovery", offset: 0 })).rejects.toBe(serializationFailure)

    expect(doubles.readFence).toHaveBeenCalledTimes(1)
    expect(test.connectionCount).toBe(1)
    expect(test.releaseCount).toBe(1)
    expect(test.releaseErrors).toEqual([rollbackFailure])
    expect(test.queries.filter(query => query.sql.startsWith("BEGIN"))).toHaveLength(1)
  })
})
