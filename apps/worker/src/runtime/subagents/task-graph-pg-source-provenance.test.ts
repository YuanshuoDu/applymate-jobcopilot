import { describe, expect, it, vi } from "vitest"
import type { PoolClient } from "pg"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import { TASK_GRAPH_SNAPSHOT_VERSION, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import {
  loadTaskGraphSourceInputRelations, parsePersistedTaskGraphProposalNodes, resolveTaskGraphSourceInputRelations,
  type PersistedTaskGraphProposalSource,
} from "./task-graph-pg-source-provenance.js"
import { compareTaskGraphInputCursors } from "./task-graph-source-intent-context.js"

const scope: GraphIdentityScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
}
const snapshot: TaskGraphSnapshot = {
  schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
  nodes: [
    { key: "scout", taskId: "scout-task", templateId: "scout", goal: "Find roles", successCriteria: ["Return links"], dependsOn: [], depth: 1 },
    { key: "analyst", taskId: "analyst-task", templateId: "analyst", goal: "Analyze roles", successCriteria: ["Rank links"], dependsOn: ["scout"], depth: 2 },
  ],
}

function proposal(nodes = [{ key: "scout", taskId: "scout-task", status: "queued" }], causationId: unknown = "source-step", itemStepId: unknown = causationId): PersistedTaskGraphProposalSource {
  return {
    causationId,
    payload: {
      kind: "proposal", inputThroughSequence: 99, sourceCheckpoint: { stepId: "model-controlled" },
      receipt: { revision: 1, nodes, readyTaskIds: nodes.filter(node => node.status === "queued").map(node => node.taskId) },
      item: { stepId: itemStepId },
    },
  }
}

function step(id: string, cursor: unknown, options: Record<string, unknown> = {}) {
  const current = options.isCurrent === true
  return {
    id, sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.parentTaskId,
    rootTaskId: scope.rootTaskId, userId: scope.userId, inputThroughSequence: cursor,
    consumedInputIds: cursor === "0" || cursor === 0 ? [] : [`input-${id}`], isCurrent: current, ...options,
  }
}

describe("TaskGraph source checkpoint provenance", () => {
  it("extracts only task identities from the persisted proposal receipt", () => {
    expect(parsePersistedTaskGraphProposalNodes(proposal().payload)).toEqual([{ key: "scout", taskId: "scout-task" }])
    expect(() => parsePersistedTaskGraphProposalNodes({ kind: "proposal", receipt: { nodes: [], readyTaskIds: [], revision: 1 } }))
      .toThrow("task_graph_receipt_invalid")
  })

  it("restores source cursors with one distinct, scoped batch lookup", async () => {
    const source = proposal([
      { key: "scout", taskId: "scout-task", status: "queued" },
      { key: "analyst", taskId: "analyst-task", status: "waiting" },
    ])
    const query = vi.fn(async (..._args: unknown[]) => ({ rows: [
      step("source-step", "1"), step("current-step", "2", { isCurrent: true, consumedInputIds: [] }),
    ], rowCount: 2 }))
    const client = { query } as unknown as Pick<PoolClient, "query">

    const relations = await loadTaskGraphSourceInputRelations(client, scope, snapshot, [source], undefined)

    expect(relations).toEqual(new Map([[
      "scout", "predates_current_inputs",
    ], ["analyst", "predates_current_inputs"]]))
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]?.[1]).toEqual([["source-step"], null, "root-1", "session-1", "turn-1", "root-1", "user-1"])
  })

  it("maps equal, later, and unavailable checkpoints without inventing order", () => {
    const nodes = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [snapshot.nodes[0]!] } satisfies TaskGraphSnapshot
    const same = proposal()
    const relation = (sourceCursor: unknown, currentCursor: unknown) => resolveTaskGraphSourceInputRelations(nodes, [same], [
      step("source-step", sourceCursor), step("current-step", currentCursor, { isCurrent: true }),
    ], scope).get("scout")

    expect(relation("1", "1")).toBe("covers_current_inputs")
    expect(relation("1", "2")).toBe("predates_current_inputs")
    expect(relation("2", "1")).toBe("unknown")
    expect(relation("invalid", "2")).toBe("unknown")
    expect(relation("1", "0")).toBe("unknown")
    expect(relation("invalid", "2")).toBe("unknown")
    expect(compareTaskGraphInputCursors(0n, 1n)).toBe("predates_current_inputs")
    expect(compareTaskGraphInputCursors(1n, 1n)).toBe("covers_current_inputs")
    expect(compareTaskGraphInputCursors(2n, 1n)).toBe("unknown")
  })

  it("accepts positive high-water cursors with an empty Step-local input list", () => {
    const nodes = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [snapshot.nodes[0]!] } satisfies TaskGraphSnapshot
    const relation = resolveTaskGraphSourceInputRelations(nodes, [proposal()], [
      step("source-step", "1"), step("current-step", "2", { isCurrent: true, consumedInputIds: [] }),
    ], scope).get("scout")
    expect(relation).toBe("predates_current_inputs")
  })

  it("treats valid zero cursors as equal or earlier and rejects zero with consumed IDs", () => {
    const nodes = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [snapshot.nodes[0]!] } satisfies TaskGraphSnapshot
    const resolve = (sourceCursor: unknown, sourceIds: readonly string[], currentCursor: unknown) =>
      resolveTaskGraphSourceInputRelations(nodes, [proposal()], [
        step("source-step", sourceCursor, { consumedInputIds: sourceIds }),
        step("current-step", currentCursor, { isCurrent: true, consumedInputIds: [] }),
      ], scope).get("scout")

    expect(resolve("0", [], "0")).toBe("covers_current_inputs")
    expect(resolve("0", [], "2")).toBe("predates_current_inputs")
    expect(resolve("0", ["impossible-input"], "0")).toBe("unknown")
  })

  it("keeps missing, malformed, hostile, foreign, and mismatched causation unknown", () => {
    const nodes = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [snapshot.nodes[0]!] } satisfies TaskGraphSnapshot
    const current = step("current-step", "2", { isCurrent: true })
    const resolve = (candidate: PersistedTaskGraphProposalSource | undefined, sourceRow?: Record<string, unknown>) =>
      resolveTaskGraphSourceInputRelations(nodes, candidate ? [candidate] : [], [current, ...(sourceRow ? [sourceRow] : [])], scope)
        .get("scout")

    expect(resolve(undefined)).toBe("unknown")
    expect(resolve(proposal(undefined, "source-step", "different-item-step"))).toBe("unknown")
    expect(resolve(proposal(undefined, "source-step"))).toBe("unknown")
    expect(resolve(proposal(undefined, " source-step "), step("source-step", "1"))).toBe("unknown")
    expect(resolve(proposal(undefined, "source-step"), step("source-step", "1", { sessionId: "foreign-session" }))).toBe("unknown")
    expect(resolve(proposal(undefined, "source-step"), step("source-step", "1", { taskId: "sibling-task" }))).toBe("unknown")
    expect(resolve(proposal(undefined, "source-step"), step("source-step", "1", { consumedInputIds: ["duplicate", "duplicate"] }))).toBe("unknown")
  })

  it("does not accept a caller-selected current Step outside the returned scoped row", () => {
    const nodes = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [snapshot.nodes[0]!] } satisfies TaskGraphSnapshot
    expect(resolveTaskGraphSourceInputRelations(nodes, [proposal()], [
      step("source-step", "1"), step("different-current", "2", { isCurrent: true }),
    ], scope, "expected-current").get("scout")).toBe("unknown")
  })
})
