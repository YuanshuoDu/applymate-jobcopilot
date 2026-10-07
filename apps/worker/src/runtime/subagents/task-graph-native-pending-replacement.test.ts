import { beforeEach, describe, expect, it, vi } from "vitest"

const lifecycle = vi.hoisted(() => ({ prepareGraphTransition: vi.fn(), persistGraphTransition: vi.fn() }))
const graph = vi.hoisted(() => ({ loadTaskGraph: vi.fn() }))
const nativeAppend = vi.hoisted(() => ({ appendNativeGraphCommand: vi.fn() }))
vi.mock("./task-graph-pg-lifecycle.js", () => lifecycle)
vi.mock("./task-graph-pg-state.js", () => graph)
vi.mock("./task-graph-native-pg.js", () => nativeAppend)

import type { PoolClient } from "pg"
import type { TaskGraphNativeCommandInput, TaskGraphNativeCommandReceipt } from "./task-graph-command-port.js"
import { normalizeNativeCommand, nativeContextMetrics } from "./task-graph-native-request.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { NATIVE_VERIFICATION_CONTROL_SCHEMA } from "./native-verification-contract.js"
import { TASK_GRAPH_NATIVE_METADATA_VERSION } from "./task-graph-native-state.js"
import { replaceUnstartedNativeFollowup } from "./task-graph-native-pending-replacement.js"
import type { GraphParent, LoadedGraph } from "./task-graph-pg-state.js"
import { TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"

const scope: TaskGraphNativeCommandInput["scope"] = {
  userId: "user", sessionId: "session", turnId: "turn", rootTaskId: "root", parentTaskId: "root",
  stepId: "step", turnLeaseOwner: "turn-lease", turnLeaseVersion: 2, parentLeaseOwner: "root-lease", parentAttemptCount: 3,
}
const input: TaskGraphNativeCommandInput = {
  scope,
  request: { kind: "followup", idempotencyKey: "replace-key", sourceTaskId: "source", goal: "Retry with new evidence",
    context: { note: "new attempt" }, mode: "replace_unstarted", expectedRevision: 4 },
}
const sourceContext = { serverContext: "retained" }
const metrics = nativeContextMetrics(sourceContext)
const node = {
  key: "source-node", templateId: "native", taskId: "source", depth: 1, goal: "Original goal", successCriteria: ["Preserve criteria"],
  dependsOn: [], verificationDisposition: "legacy_unverified",
  nativeDelegation: {
    schemaVersion: TASK_GRAPH_NATIVE_METADATA_VERSION, operationKind: "spawn", operationId: "source-operation",
    requestFingerprint: "a".repeat(64), callerTaskId: "root", role: "scout", taskType: "research",
    contextDigest: metrics.contextDigest, contextBytes: metrics.contextBytes,
  },
}
const sourceRow = {
  id: "source", sessionId: "session", turnId: "turn", rootTaskId: "root", parentTaskId: "root", status: "queued",
  attemptCount: 0, role: "scout", taskType: "research", goal: "Original goal", constraints: ["read only"],
  successCriteria: ["Preserve criteria"], allowedActions: ["jobs.search"], context: sourceContext, expectedOutputSchema: {},
  result: null, failureReason: null, startedAt: null, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null,
  completedAt: null, interruptRequestedAt: null, closedAt: null, qualityGateResult: null, outputArtifactIds: [],
}
const loaded = {
  rootTaskId: "root", item: { id: "task-graph:root", revision: 4, content: {}, createdAt: new Date() },
  snapshot: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [node] },
  state: { revision: 4, nodes: [{ key: "source-node", taskId: "source", status: "queued" }] }, tasks: new Map(),
} as unknown as LoadedGraph
const afterCancellation = { ...loaded, state: { ...loaded.state!, revision: 5 } } as LoadedGraph
const parent = {} as GraphParent
const receipt: TaskGraphNativeCommandReceipt = {
  status: "accepted", replay: false, operationId: "new-operation", requestFingerprint: "b".repeat(64), graphRevision: 6,
  nodeKey: "replacement-node", dispatchDisposition: "pending",
  child: { taskId: "replacement", rootTaskId: "root", parentTaskId: "root", path: "/root/replacement", depth: 1,
    role: "scout", taskType: "research", status: "queued" },
}

function client(
  flags = { hasChildren: false, hasSuccessor: false, hasSteps: false, hasItems: false, hasExecutionEvents: false },
  source = sourceRow,
) {
  const calls: string[] = []
  type QueryResult = { rows: unknown[]; rowCount: number }
  const query = vi.fn(async (sql: string, _values?: readonly unknown[]): Promise<QueryResult> => {
    calls.push(sql)
    if (sql.includes("SELECT task.\"id\"")) return { rows: [source], rowCount: 1 }
    if (sql.includes("AS \"hasChildren\"")) return { rows: [flags], rowCount: 1 }
    if (sql.startsWith("UPDATE \"sub_agent_tasks\"")) return { rows: [], rowCount: 1 }
    throw new Error("unexpected query")
  })
  return { query, calls } as unknown as PoolClient & { query: typeof query; calls: string[] }
}

beforeEach(() => {
  vi.clearAllMocks()
  lifecycle.prepareGraphTransition.mockResolvedValue({ scope, itemId: "task-graph:root", taskId: "source", expectedRevision: 4,
    snapshot: loaded.snapshot, event: {}, state: loaded.state, duplicate: false })
  lifecycle.persistGraphTransition.mockResolvedValue({ ...loaded.state, revision: 5 })
  graph.loadTaskGraph.mockResolvedValue(afterCancellation)
  nativeAppend.appendNativeGraphCommand.mockResolvedValue(receipt)
})

describe("native pending replacement transaction helper", () => {
  it("cancels the exact unstarted native leaf before appending a source-linked replacement", async () => {
    const db = client()
    const command = normalizeNativeCommand(input)

    const result = await replaceUnstartedNativeFollowup(db, input, command, parent, loaded)

    expect(result).toEqual(receipt)
    expect(db.query).toHaveBeenCalledTimes(3)
    expect(db.query.mock.calls[2]?.[0]).toContain("AND \"status\" = 'queued' AND \"attemptCount\" = 0")
    expect(db.query.mock.calls[2]?.[0]).toContain("AND \"startedAt\" IS NULL AND \"leaseOwner\" IS NULL")
    expect(db.query.mock.calls[2]?.[1]).toEqual(["source", "session", "turn", "root", "root", expect.any(Date), "user"])
    expect(lifecycle.prepareGraphTransition).toHaveBeenCalledWith(db, expect.objectContaining({ taskId: "source", type: "task.cancelled", attemptCount: 0 }))
    expect(lifecycle.persistGraphTransition).toHaveBeenCalledOnce()
    expect(graph.loadTaskGraph).toHaveBeenCalledWith(db, scope, true)
    expect(nativeAppend.appendNativeGraphCommand).toHaveBeenCalledOnce()
    const appended = nativeAppend.appendNativeGraphCommand.mock.calls[0]?.[2]
    expect(appended.request).toMatchObject({ mode: "replace_unstarted", expectedRevision: 4, goal: input.request.goal,
      sourceTaskId: "source", constraints: ["read only"], successCriteria: ["Preserve criteria"], context: { note: "new attempt" } })
  })

  it("rejects a typed planner node before querying or mutating its source", async () => {
    const typedNode = {
      key: node.key, templateId: "scout", taskId: node.taskId, depth: node.depth, goal: node.goal,
      successCriteria: node.successCriteria, dependsOn: [], verificationDisposition: "typed" as const,
      verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout" as const,
        criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 1 } }] },
    }
    const candidate = {
      ...loaded, snapshot: { ...loaded.snapshot!, nodes: [typedNode] },
      state: { ...loaded.state!, nodes: [{ key: typedNode.key, taskId: typedNode.taskId, status: "queued" }] },
    } as unknown as LoadedGraph
    const db = client()

    await expect(replaceUnstartedNativeFollowup(db, input, normalizeNativeCommand(input), parent, candidate))
      .rejects.toMatchObject({ code: "native_replacement_source_invalid" })

    expect(db.query).not.toHaveBeenCalled()
    expect(lifecycle.prepareGraphTransition).not.toHaveBeenCalled()
    expect(lifecycle.persistGraphTransition).not.toHaveBeenCalled()
    expect(nativeAppend.appendNativeGraphCommand).not.toHaveBeenCalled()
  })

  it.each([
    ["running node", { ...loaded, state: { ...loaded.state!, nodes: [{ key: "source-node", taskId: "source", status: "running" }] } }],
    ["node with dependents", { ...loaded, snapshot: { ...loaded.snapshot!, nodes: [node, { ...node, key: "dependent", taskId: "dependent", dependsOn: ["source-node"] }] } }],
    ["foreign caller metadata", { ...loaded, snapshot: { ...loaded.snapshot!, nodes: [{ ...node, nativeDelegation: { ...node.nativeDelegation, callerTaskId: "other-root" } }] } }],
  ])("rejects %s before any source mutation", async (_label, candidate) => {
    const db = client()
    await expect(replaceUnstartedNativeFollowup(db, input, normalizeNativeCommand(input), parent, candidate as LoadedGraph))
      .rejects.toMatchObject({ code: "native_replacement_source_invalid" })
    expect(db.query).not.toHaveBeenCalled()
    expect(lifecycle.prepareGraphTransition).not.toHaveBeenCalled()
    expect(nativeAppend.appendNativeGraphCommand).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: "reserved verifier task",
      source: { ...sourceRow, role: "auditor", taskType: "native_verification" },
      metadata: { role: "auditor", taskType: "native_verification" },
    },
    {
      label: "reserved verifier control schema",
      source: { ...sourceRow, expectedOutputSchema: { schemaVersion: NATIVE_VERIFICATION_CONTROL_SCHEMA } },
      metadata: {},
    },
  ])("rejects $label before source mutation or append", async ({ source, metadata }) => {
    const reservedNode = { ...node, nativeDelegation: { ...node.nativeDelegation, ...metadata } }
    const candidate = { ...loaded, snapshot: { ...loaded.snapshot!, nodes: [reservedNode] } } as LoadedGraph
    const db = client(undefined, source)

    await expect(replaceUnstartedNativeFollowup(db, input, normalizeNativeCommand(input), parent, candidate))
      .rejects.toMatchObject({ code: "native_replacement_source_invalid" })

    expect(db.query).toHaveBeenCalledOnce()
    expect(db.calls.some(sql => sql.startsWith("UPDATE \"sub_agent_tasks\""))).toBe(false)
    expect(lifecycle.prepareGraphTransition).not.toHaveBeenCalled()
    expect(lifecycle.persistGraphTransition).not.toHaveBeenCalled()
    expect(nativeAppend.appendNativeGraphCommand).not.toHaveBeenCalled()
  })

  it("fails closed when a same-owner execution artifact or successor is outside the snapshot", async () => {
    for (const flags of [
      { hasChildren: true, hasSuccessor: false, hasSteps: false, hasItems: false, hasExecutionEvents: false },
      { hasChildren: false, hasSuccessor: true, hasSteps: false, hasItems: false, hasExecutionEvents: false },
      { hasChildren: false, hasSuccessor: false, hasSteps: true, hasItems: false, hasExecutionEvents: false },
      { hasChildren: false, hasSuccessor: false, hasSteps: false, hasItems: true, hasExecutionEvents: false },
      { hasChildren: false, hasSuccessor: false, hasSteps: false, hasItems: false, hasExecutionEvents: true },
    ]) {
      vi.clearAllMocks()
      lifecycle.prepareGraphTransition.mockResolvedValue({ scope, itemId: "task-graph:root", taskId: "source", expectedRevision: 4,
        snapshot: loaded.snapshot, event: {}, state: loaded.state, duplicate: false })
      const db = client(flags)

      await expect(replaceUnstartedNativeFollowup(db, input, normalizeNativeCommand(input), parent, loaded))
        .rejects.toMatchObject({ code: "native_replacement_source_invalid" })

      expect(db.query).toHaveBeenCalledTimes(2)
      expect(lifecycle.prepareGraphTransition).not.toHaveBeenCalled()
      expect(db.calls.some(sql => sql.startsWith("UPDATE \"sub_agent_tasks\""))).toBe(false)
      expect(nativeAppend.appendNativeGraphCommand).not.toHaveBeenCalled()
    }
  })
})
