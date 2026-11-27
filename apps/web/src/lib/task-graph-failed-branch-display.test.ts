import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_FAILED_BRANCH_RECONCILIATION_SCHEMA_VERSION } from "@jobcopilot/agent-protocol/task-graph-failed-branch-reconciliation"

const mocks = vi.hoisted(() => ({ eventFindMany: vi.fn() }))
vi.mock("@/lib/db", () => ({ db: { agentEvent: { findMany: mocks.eventFindMany } } }))

import { readFailedBranchReplacementDisplay } from "./task-graph-failed-branch-display"

const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", revision: 5 }
const stepId = "step-1"
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")
const graphItemId = `task-graph-${digest(scope.rootTaskId)}`
const lifecycleKey = (nodeKey: string, attempt: number, type: string) =>
  `${graphItemId}:node:${digest(nodeKey).slice(0, 20)}:${attempt}:${type}`
const proposalKey = (revision: number) => `${graphItemId}:proposal:${revision}`

function receipt() {
  const branchRoot = { nodeKey: "old-scout", taskId: "old-scout-task" }
  const replaceBranch = { root: branchRoot, sources: [
    { ...branchRoot, replacementKey: "fresh-scout" },
    { nodeKey: "old-analyst", taskId: "old-analyst-task", replacementKey: "fresh-analyst" },
  ] }
  const callId = "plan-call-1"
  const operationKey = `agent.plan.reconciliation:sha256:${digest(JSON.stringify([
    scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, stepId, callId,
  ]))}`
  return {
    schemaVersion: "agent-harness.v2.plan-reconciliation.v4",
    sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, stepId,
    decision: "revise", observedRevision: 3, resultingRevision: scope.revision,
    steerInputIds: [], inputCheckpoint: { throughSequence: "47" },
    failedBranch: {
      schemaVersion: "agent-harness.v2.task-graph-failed-branch-repair.v1", operationKey,
      graphRootTaskId: scope.rootTaskId, observedRevision: 3, resultingRevision: scope.revision, branchRoot,
      sources: replaceBranch.sources.map(({ nodeKey, taskId, replacementKey }) => ({ source: { nodeKey, taskId }, replacementKey })),
      failedSource: { source: branchRoot, attemptCount: 2, resultDigest: "a".repeat(64), reportDigest: "b".repeat(64),
        event: { id: "failed-event", sequence: "40", idempotencyKey: lifecycleKey(branchRoot.nodeKey, 2, "task.failed") } },
      cancellations: [{ source: { nodeKey: "old-analyst", taskId: "old-analyst-task" }, event: {
        id: "cancelled-event", sequence: "41", idempotencyKey: lifecycleKey("old-analyst", 0, "task.cancelled"),
      } }],
      verifiedExternalDependencies: [],
      planEvent: { id: "plan-event", sequence: "42", idempotencyKey: proposalKey(4) },
      requestFingerprint: "c".repeat(64),
      agentPlanCall: { callId, stepId, expectedRevision: 3, replaceBranch },
    },
  }
}

function event(payload: unknown = receipt()) {
  const value = payload as { failedBranch?: { operationKey?: string } }
  return {
    id: "reconciliation-event", sessionId: scope.sessionId, turnId: scope.turnId, itemId: null, taskId: scope.rootTaskId,
    sequence: BigInt(43), type: "agent.plan.reconciliation", actor: "orchestrator", correlationId: scope.turnId,
    causationId: stepId, idempotencyKey: value.failedBranch?.operationKey, payload,
  }
}

const graph = { schemaVersion: "agent-harness.v2.task-graph", nodes: [
  { key: "foundation", templateId: "scout", goal: "Existing node", successCriteria: ["Collect"], dependsOn: [], depth: 1, taskId: "foundation-task" },
  { key: "fresh-analyst", templateId: "analyst", goal: "Review", successCriteria: ["Assess"], dependsOn: ["foundation"], depth: 2, taskId: "fresh-analyst-task" },
  { key: "fresh-scout", templateId: "scout", goal: "Find", successCriteria: ["Search"], dependsOn: ["foundation"], depth: 2, taskId: "fresh-scout-task" },
] }

describe("failed branch display projection", () => {
  beforeEach(() => { mocks.eventFindMany.mockReset(); mocks.eventFindMany.mockResolvedValue([event()]) })

  it("projects only distinct current successor indexes in graph order", async () => {
    await expect(readFailedBranchReplacementDisplay({ scope, graph })).resolves.toEqual({
      reason: "previous_branch_unverified", successorNodeIndexes: [1, 2],
    })
    expect(mocks.eventFindMany).toHaveBeenCalledWith({
      where: { sessionId: scope.sessionId, turnId: scope.turnId, itemId: null, taskId: scope.rootTaskId,
        type: "agent.plan.reconciliation", actor: "orchestrator", correlationId: scope.turnId,
        AND: [
          { payload: { path: ["schemaVersion"], equals: TASK_GRAPH_FAILED_BRANCH_RECONCILIATION_SCHEMA_VERSION } },
          { payload: { path: ["resultingRevision"], equals: scope.revision } },
        ] },
      select: { id: true, sessionId: true, turnId: true, itemId: true, taskId: true, sequence: true,
        type: true, actor: true, correlationId: true, causationId: true, idempotencyKey: true, payload: true },
      take: 2,
    })
  })

  it.each([
    ["no matching receipt", () => []],
    ["duplicate current receipts", () => [event(), { ...event(), id: "second-event" }]],
    ["foreign owner key", () => {
      const value = receipt() as ReturnType<typeof receipt>
      value.failedBranch.operationKey = `agent.plan.reconciliation:sha256:${"d".repeat(64)}`
      return [event(value)]
    }],
    ["mismatched revision", () => [event({ ...receipt(), resultingRevision: scope.revision + 1 })]],
    ["event sequence before plan", () => [{ ...event(), sequence: BigInt(42) }]],
    ["wrong event cause", () => [{ ...event(), causationId: "foreign-step" }]],
    ["private event ID reused by relation", () => {
      const value = receipt() as ReturnType<typeof receipt>
      value.failedBranch.planEvent.id = "reconciliation-event"
      return [event(value)]
    }],
  ])("omits detail for %s", async (_name, events) => {
    mocks.eventFindMany.mockResolvedValueOnce(events())
    await expect(readFailedBranchReplacementDisplay({ scope, graph })).resolves.toBeNull()
  })

  it("omits detail when the current graph does not contain the whole mapped branch", async () => {
    await expect(readFailedBranchReplacementDisplay({ scope, graph: { ...graph, nodes: graph.nodes.slice(0, 2) } })).resolves.toBeNull()
    expect(mocks.eventFindMany).toHaveBeenCalledOnce()
  })

  it("does not carry an accepted replacement into a later unrelated revision", async () => {
    const nextRevision = { ...scope, revision: scope.revision + 1 }
    mocks.eventFindMany.mockResolvedValueOnce([])
    await expect(readFailedBranchReplacementDisplay({ scope: nextRevision, graph })).resolves.toBeNull()
    expect(mocks.eventFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ AND: [
      { payload: { path: ["schemaVersion"], equals: TASK_GRAPH_FAILED_BRANCH_RECONCILIATION_SCHEMA_VERSION } },
      { payload: { path: ["resultingRevision"], equals: nextRevision.revision } },
    ] }) }))
  })

  it("omits detail if any removed source node is present again", async () => {
    const staleGraph = { ...graph, nodes: [...graph.nodes, { ...graph.nodes[0]!, key: "old-scout", taskId: "old-scout-task" }] }
    await expect(readFailedBranchReplacementDisplay({ scope, graph: staleGraph })).resolves.toBeNull()
  })

  it("keeps the existing plan usable when the private receipt lookup fails", async () => {
    mocks.eventFindMany.mockRejectedValueOnce(new Error("private query failure"))
    await expect(readFailedBranchReplacementDisplay({ scope, graph })).resolves.toBeNull()
  })
})
