import { describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import type { CommandTransaction } from "./transaction"
import {
  VERIFIED_SHORTLIST_SELECTION_SCHEMA,
  sameVerifiedShortlistSelectionBinding,
  verifyVerifiedShortlistSelection,
  type VerifiedShortlistSelectionBinding,
} from "./verified-shortlist-selection"
import { canonicalTaskGraphItemId } from "@/lib/agent/session/final-task-graph-source-detail"

const owner = { id: "session-1", userId: "user-1" }
const source = { sessionId: owner.id, sourceTurnId: "turn-1", rootTaskId: "root-1", graphItemId: canonicalTaskGraphItemId("root-1"), graphRevision: 4 }
const selected = ["job-1", "job-2"]
const shortlist = { schemaVersion: 1, status: "completed", items: [
  { jobId: "job-1", score: 9, evidenceIds: ["read:job:job-1"] },
  { jobId: "job-2", score: 8, evidenceIds: ["read:job:job-2"] },
  { jobId: "job-3", score: 7, evidenceIds: ["read:job:job-3"] },
], failures: [] }
const turn = { id: source.sourceTurnId, sessionId: owner.id, userId: owner.userId, source: "user", status: "completed", rootTaskId: source.rootTaskId,
  executionMode: null, input: { intent: { kind: "interactive_discovery_shortlist", version: 1 } } }
const root = { id: source.rootTaskId, sessionId: owner.id, turnId: source.sourceTurnId, rootTaskId: source.rootTaskId,
  parentTaskId: null, role: "orchestrator", taskType: "root", status: "completed", failureReason: null,
  result: { status: "completed", stepCount: 3, toolCallCount: 4, finalItemId: "item-final", waitId: null,
    structuredResult: { interactiveDiscoveryShortlist: shortlist } } }
const graph = { id: source.graphItemId, sessionId: owner.id, turnId: source.sourceTurnId, taskId: source.rootTaskId,
  type: "task_graph", revision: source.graphRevision, content: { schemaVersion: TASK_GRAPH_SCHEMA_VERSION, nodes: [
    { key: "scout", templateId: "scout", goal: "Find jobs", successCriteria: ["Save evidence"], dependsOn: [], depth: 1, taskId: "scout-1" },
    { key: "analyst", templateId: "analyst", goal: "Score jobs", successCriteria: ["Compare jobs"], dependsOn: ["scout"], depth: 2, taskId: "analyst-1" },
  ] } }

function fixture(options: {
  turn?: unknown
  root?: unknown
  graph?: unknown
  jobs?: readonly { id: string }[]
} = {}) {
  const agentTurn = { findFirst: vi.fn().mockResolvedValue(options.turn === undefined ? turn : options.turn) }
  const subAgentTask = { findFirst: vi.fn().mockResolvedValue(options.root === undefined ? root : options.root) }
  const agentItem = { findFirst: vi.fn().mockResolvedValue(options.graph === undefined ? graph : options.graph) }
  const job = { findMany: vi.fn().mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    options.jobs ?? where.id.in.map(id => ({ id }))) }
  return { tx: { agentTurn, subAgentTask, agentItem, job } as unknown as CommandTransaction, agentTurn, subAgentTask, agentItem, job }
}

describe("verified shortlist selection admission", () => {
  it("binds an explicit subset in source ranking order and reads only owner-scoped evidence", async () => {
    const test = fixture()
    const binding = await verifyVerifiedShortlistSelection(test.tx, owner, source, ["job-2", "job-1"])

    expect(binding).toEqual({ schemaVersion: VERIFIED_SHORTLIST_SELECTION_SCHEMA, source, selectedJobIds: selected })
    expect(Object.isFrozen(binding)).toBe(true)
    expect(Object.isFrozen(binding?.selectedJobIds)).toBe(true)
    expect(test.agentTurn.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: source.sourceTurnId, sessionId: owner.id, userId: owner.userId, source: "user", status: "completed", rootTaskId: source.rootTaskId },
    }))
    expect(test.subAgentTask.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: source.rootTaskId, sessionId: owner.id, turnId: source.sourceTurnId,
        rootTaskId: source.rootTaskId, parentTaskId: null, role: "orchestrator", taskType: "root", status: "completed", failureReason: null }),
    }))
    expect(test.agentItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: source.graphItemId, sessionId: owner.id, turnId: source.sourceTurnId, taskId: source.rootTaskId,
        type: "task_graph", revision: source.graphRevision },
    }))
    expect(test.job.findMany).toHaveBeenCalledWith({ where: { userId: owner.userId, id: { in: selected } }, select: { id: true } })
  })

  it("rejects malformed locked-owner identities before querying proof", async () => {
    const test = fixture()

    await expect(verifyVerifiedShortlistSelection(test.tx, { id: "session/1", userId: owner.userId }, source, selected)).resolves.toBeNull()
    await expect(verifyVerifiedShortlistSelection(test.tx, { id: owner.id, userId: " user-1" }, source, selected)).resolves.toBeNull()
    expect(test.agentTurn.findFirst).not.toHaveBeenCalled()
  })

  it("canonicalizes the same selected set regardless of request order", async () => {
    const first = fixture(), second = fixture()
    const left = await verifyVerifiedShortlistSelection(first.tx, owner, source, ["job-2", "job-1"])
    const right = await verifyVerifiedShortlistSelection(second.tx, owner, source, ["job-1", "job-2"])

    expect(right).toEqual(left)
    expect(sameVerifiedShortlistSelectionBinding(left, right!)).toBe(true)
  })

  it.each([
    ["duplicate IDs", ["job-1", "job-1"]],
    ["empty selection", []],
    ["single-Job selection", ["job-1"]],
    ["over-capacity selection", ["job-1", "job-2", "job-3", "job-4"]],
    ["malformed ID", ["job/1", "job-2"]],
    ["whitespace ID", ["job-1\n", "job-2"]],
  ])("rejects %s before querying proof", async (_label, selection) => {
    const test = fixture()

    await expect(verifyVerifiedShortlistSelection(test.tx, owner, source, selection)).resolves.toBeNull()
    expect(test.agentTurn.findFirst).not.toHaveBeenCalled()
    expect(test.job.findMany).not.toHaveBeenCalled()
  })

  it("rejects an unknown shortlist ID after verifying the source but before querying Jobs", async () => {
    const test = fixture()

    await expect(verifyVerifiedShortlistSelection(test.tx, owner, source, ["job-unknown", "job-1"])).resolves.toBeNull()
    expect(test.agentTurn.findFirst).toHaveBeenCalledOnce()
    expect(test.subAgentTask.findFirst).toHaveBeenCalledOnce()
    expect(test.agentItem.findFirst).toHaveBeenCalledOnce()
    expect(test.job.findMany).not.toHaveBeenCalled()
  })

  it.each([
    ["foreign session", { ...source, sessionId: "session-2" }],
    ["wrong canonical graph ID", { ...source, graphItemId: "task-graph-forged" }],
    ["extra source field", { ...source, userId: owner.userId }],
    ["nonpositive revision", { ...source, graphRevision: 0 }],
  ])("rejects %s source identity", async (_label, identity) => {
    const test = fixture()

    await expect(verifyVerifiedShortlistSelection(test.tx, owner, identity, selected)).resolves.toBeNull()
    expect(test.agentTurn.findFirst).not.toHaveBeenCalled()
  })

  it("rejects a stale graph revision after reloading the exact source evidence", async () => {
    const test = fixture()

    await expect(verifyVerifiedShortlistSelection(test.tx, owner, { ...source, graphRevision: 3 }, selected)).resolves.toBeNull()
    expect(test.agentTurn.findFirst).toHaveBeenCalledOnce()
    expect(test.subAgentTask.findFirst).toHaveBeenCalledOnce()
    expect(test.agentItem.findFirst).toHaveBeenCalledOnce()
    expect(test.job.findMany).not.toHaveBeenCalled()
  })

  it.each([
    ["another owner", { ...turn, userId: "user-2" }],
    ["another Session", { ...turn, sessionId: "session-2" }],
    ["non-user source", { ...turn, source: "automation" }],
    ["incomplete Turn", { ...turn, status: "in_progress" }],
    ["different Root", { ...turn, rootTaskId: "root-2" }],
    ["legacy execution mode", { ...turn, executionMode: "legacy" }],
    ["wrong intent", { ...turn, input: { intent: { kind: "objective_task_graph_execution", version: 1 } } }],
    ["open intent", { ...turn, input: { intent: { kind: "interactive_discovery_shortlist", version: 1, selectedJobIds: selected } } }],
  ])("rejects a source Turn with %s", async (_label, sourceTurn) => {
    const test = fixture({ turn: sourceTurn })

    await expect(verifyVerifiedShortlistSelection(test.tx, owner, source, selected)).resolves.toBeNull()
    expect(test.subAgentTask.findFirst).not.toHaveBeenCalled()
  })

  it.each([
    ["another owner Session", { ...root, sessionId: "session-2" }],
    ["wrong Turn", { ...root, turnId: "turn-2" }],
    ["non-root task", { ...root, parentTaskId: "parent-1" }],
    ["failed task", { ...root, status: "failed" }],
    ["failure reason", { ...root, failureReason: "failed" }],
    ["missing terminal result", { ...root, result: { ...root.result, status: "failed" } }],
    ["partial shortlist", { ...root, result: { ...root.result, structuredResult: { interactiveDiscoveryShortlist: { ...shortlist, status: "partial", failures: ["scout_result_partial"] } } } }],
    ["tampered evidence", { ...root, result: { ...root.result, structuredResult: { interactiveDiscoveryShortlist: { ...shortlist,
      items: shortlist.items.map((item, index) => index === 0 ? { ...item, evidenceIds: ["read:job:job-2"] } : item) } } } }],
  ])("rejects a Root result with %s", async (_label, sourceRoot) => {
    const test = fixture({ root: sourceRoot })

    await expect(verifyVerifiedShortlistSelection(test.tx, owner, source, selected)).resolves.toBeNull()
    expect(test.agentItem.findFirst).not.toHaveBeenCalled()
  })

  it.each([
    ["another owner Session", { ...graph, sessionId: "session-2" }],
    ["another Turn", { ...graph, turnId: "turn-2" }],
    ["another Root", { ...graph, taskId: "root-2" }],
    ["stale revision", { ...graph, revision: 3 }],
    ["malformed snapshot", { ...graph, content: { schemaVersion: "future", nodes: [] } }],
    ["empty typed graph", { ...graph, content: { ...graph.content, nodes: [] } }],
  ])("rejects TaskGraph evidence with %s", async (_label, sourceGraph) => {
    const test = fixture({ graph: sourceGraph })

    await expect(verifyVerifiedShortlistSelection(test.tx, owner, source, selected)).resolves.toBeNull()
    expect(test.job.findMany).not.toHaveBeenCalled()
  })

  it("rejects missing or foreign owned Jobs", async () => {
    for (const jobs of [[], [{ id: "job-1" }, { id: "foreign-job" }]]) {
      const test = fixture({ jobs })
      await expect(verifyVerifiedShortlistSelection(test.tx, owner, source, selected)).resolves.toBeNull()
    }
  })

  it("requires exact replay source and selected semantics", () => {
    const binding: VerifiedShortlistSelectionBinding = { schemaVersion: VERIFIED_SHORTLIST_SELECTION_SCHEMA, source, selectedJobIds: selected }

    expect(sameVerifiedShortlistSelectionBinding(binding, binding)).toBe(true)
    expect(sameVerifiedShortlistSelectionBinding({ ...binding, source: { ...source, graphRevision: 5 } }, binding)).toBe(false)
    expect(sameVerifiedShortlistSelectionBinding({ ...binding, selectedJobIds: ["job-1"] }, binding)).toBe(false)
    expect(sameVerifiedShortlistSelectionBinding({ ...binding, selectedJobIds: ["job-2", "job-1"] }, binding)).toBe(false)
    expect(sameVerifiedShortlistSelectionBinding({ ...binding, source: { ...source, graphItemId: "task-graph-forged" } }, binding)).toBe(false)
    expect(sameVerifiedShortlistSelectionBinding({ ...binding, extra: true }, binding)).toBe(false)
    expect(sameVerifiedShortlistSelectionBinding({ ...binding, schemaVersion: "future" }, binding)).toBe(false)
  })
})
