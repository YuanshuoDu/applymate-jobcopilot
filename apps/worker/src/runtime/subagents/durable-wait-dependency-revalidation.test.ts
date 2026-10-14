import { beforeEach, describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, type TaskGraphVerificationContract } from "../planning/task-graph-verification.js"
import type { GraphIdentityScope, LoadedGraph } from "./task-graph-pg-state.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-verification-report.js"
import { TASK_GRAPH_SNAPSHOT_VERSION, type TaskGraphSnapshot } from "./task-graph-snapshot.js"

const { loadGraph } = vi.hoisted(() => ({ loadGraph: vi.fn() }))
vi.mock("./task-graph-pg-state.js", () => ({ loadTaskGraph: loadGraph }))

import { durableWaitDependencyTaskIds, durableWaitReportMatchesCurrent, revalidateDurableWaitDependencies } from "./durable-wait-dependency-revalidation.js"

const scope: GraphIdentityScope = { userId: "user", sessionId: "session", turnId: "turn", rootTaskId: "root", parentTaskId: "root" }
const scout: TaskGraphVerificationContract = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }] }
const analyst: TaskGraphVerificationContract = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [{ id: "source-match", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout" } }] }
function snapshot(crossNode = false): TaskGraphSnapshot {
  return { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [
    { key: "scout", taskId: "scout-task", templateId: "scout", goal: "Search", successCriteria: ["Find"], dependsOn: [], depth: 1, verification: scout, verificationDisposition: "typed" },
    { key: "analyst", taskId: "analyst-task", templateId: "analyst", goal: "Assess", successCriteria: ["Assess"], dependsOn: crossNode ? ["scout"] : [], depth: 1, verification: crossNode ? analyst : { ...analyst, criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }] }, verificationDisposition: "typed" },
  ] } as TaskGraphSnapshot
}
function loaded(graphSnapshot: TaskGraphSnapshot, result: unknown): LoadedGraph {
  return { rootTaskId: "root", item: { id: "graph", revision: 2, content: graphSnapshot, createdAt: new Date() }, snapshot: graphSnapshot, state: null,
    tasks: new Map([["analyst-task", { id: "analyst-task", status: "completed", role: "analyst", failureReason: null, result }]]) }
}

describe("durable wait dependency revalidation", () => {
  beforeEach(() => loadGraph.mockReset())

  it("keeps unary and unrelated wait targets on the existing no-extra-graph-read path", async () => {
    const current = snapshot(false), targets = [{ id: "analyst-task", status: "completed", role: "analyst", result: {} }]
    expect(durableWaitDependencyTaskIds(current, targets).size).toBe(0)
    const result = await revalidateDurableWaitDependencies({ query: vi.fn() } as never, scope, current, targets)
    expect(loadGraph).not.toHaveBeenCalled()
    expect(result.snapshot).toBe(current)
    expect(result.targets).toBe(targets)
  })

  it("loads only selected cross-node targets through the caller transaction without an item update lock", async () => {
    const current = snapshot(true), target = { id: "analyst-task", status: "running", role: "analyst", result: {} }
    const taskGraph = loaded(current, { structuredResult: { current: true } })
    loadGraph.mockResolvedValue(taskGraph)
    const result = await revalidateDurableWaitDependencies({ query: vi.fn() } as never, scope, current, [target])
    expect(loadGraph).toHaveBeenCalledWith(expect.anything(), scope, false)
    expect(result.dependencyTaskIds).toEqual(new Set(["analyst-task"]))
    expect(result.targets[0]).toMatchObject({ status: "completed", result: { structuredResult: { current: true } } })
  })

  it("fails closed when the current graph needed for a dependency report is missing", async () => {
    loadGraph.mockResolvedValue({ rootTaskId: "root", item: null, snapshot: null, state: null, tasks: new Map() })
    await expect(revalidateDurableWaitDependencies({ query: vi.fn() } as never, scope, snapshot(true), [{ id: "analyst-task", result: {} }]))
      .rejects.toThrow("task_graph_verification_report_invalid")
  })

  it("matches only the current six-field report after private bindings have been validated", () => {
    const current = snapshot(true), publicReport = {
      verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met",
      criteria: [{ criterionId: "source-match", status: "passed", reasonCode: "criteria_met" }], evidenceDigest: "a".repeat(64), resultDigest: "b".repeat(64),
    }
    const storedReport = { ...publicReport, dependencyBindings: [{ nodeKey: "scout", taskId: "scout-task", attemptCount: 1,
      nodeDigest: "c".repeat(64), resultDigest: "d".repeat(64), evidenceDigest: "e".repeat(64), reportDigest: "f".repeat(64) }] }
    const result = { taskGraphVerificationReport: storedReport }
    expect(durableWaitReportMatchesCurrent(current, "analyst-task", publicReport, result)).toBe(true)
    expect(durableWaitReportMatchesCurrent(current, "analyst-task", { ...publicReport, evidenceDigest: "9".repeat(64) }, result)).toBe(false)
  })
})
