import { afterEach, describe, expect, it, vi } from "vitest"

const evidenceHarness = vi.hoisted(() => ({ value: null as unknown, calls: [] as unknown[][] }))
vi.mock("../subagents/task-graph-current-location-evidence.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../subagents/task-graph-current-location-evidence.js")>()
  return { ...actual, resolveTaskGraphCurrentLocationEvidence: (...args: Parameters<typeof actual.resolveTaskGraphCurrentLocationEvidence>) => {
    evidenceHarness.calls.push(args)
    return Promise.resolve(evidenceHarness.value as Awaited<ReturnType<typeof actual.resolveTaskGraphCurrentLocationEvidence>>)
  } }
})

import type { LoadedGraph } from "../subagents/task-graph-pg-state.js"
import type { SteeringReconciliationState } from "../subagents/steering-reconciliation-contract.js"
import type { TaskGraphCurrentLocationEvidenceResult } from "../subagents/task-graph-current-location-evidence.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2 } from "../planning/task-graph-verification.js"
import { buildTaskGraphFinalSummaryBinding } from "../subagents/task-graph-final-summary-binding.js"
import { resolveTaskGraphConfirmedLocationCompletion } from "./task-graph-confirmed-location-completion.js"
import { taskGraphCompletionApplicability } from "./task-graph-completion-applicability.js"

afterEach(() => { evidenceHarness.value = null; evidenceHarness.calls = [] })

const scope = { userId: "user", sessionId: "session", turnId: "turn", rootTaskId: "root", parentTaskId: "root" }
const confirmed = { kind: "confirmed" as const, locations: ["dublin"], acceptedInputSequence: 20n, acceptedInputId: "accepted-input" }
const criterion = (location: string) => ({ id: "candidate-location", check: { kind: "candidate_location_in" as const, locations: [location] } })
function scout(key: string, taskId: string, location: string, dependsOn: string[] = []) {
  return { key, taskId, templateId: "scout", goal: "Find candidates", successCriteria: ["Find candidates"], dependsOn, depth: 1,
    verificationDisposition: "typed", verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2, role: "scout", criteria: [criterion(location)] } }
}
function analyst(key: string, taskId: string, dependsOn: string[] = []) {
  return { key, taskId, templateId: "analyst", goal: "Analyze candidates", successCriteria: ["Analyze candidates"], dependsOn, depth: 2,
    verificationDisposition: "typed", verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2, role: "analyst", criteria: [{ id: "finding-present", check: { kind: "finding_count_gte", minimum: 1 } }] } }
}
function graph(nodes: ReturnType<typeof scout>[], checkpoints: bigint[], revision = 5): LoadedGraph {
  const tasks = new Map(nodes.map(node => [node.taskId, { id: node.taskId, role: node.templateId,
    taskType: node.templateId === "scout" ? "job_discovery" : "job_analysis", status: "completed", failureReason: null, result: {}, attemptCount: 1 }]))
  return { rootTaskId: "root", item: { id: "graph-item", revision, content: {}, createdAt: new Date(0) },
    snapshot: { nodes }, state: { revision, nodes: nodes.map(node => ({ key: node.key, taskId: node.taskId,
      status: "completed", failureReason: null })) }, tasks,
    sourceInputCheckpointByNodeKey: new Map(nodes.map((node, index) => [node.key, { inputThroughSequence: checkpoints[index]! }])) } as unknown as LoadedGraph
}
function available(compatible: string[] = [], excluded: string[] = []): TaskGraphCurrentLocationEvidenceResult {
  return { status: "available", effectiveRequirements: { status: "valid", requirements: [
    { id: "candidate-location", kind: "candidate_location_in", locations: ["dublin"] },
  ] }, compatibleRetainedNodeKeys: new Set(compatible), excludedHistoricalNodeKeys: new Set(excluded) }
}
function reconciliation(latestUserRevision?: SteeringReconciliationState["latestUserRevision"]): SteeringReconciliationState {
  return { originalInputId: null, currentRevision: 5, decisionStepId: null, decisionStepOrdinal: null, decisionStepAttempt: null,
    decisionInputThroughSequence: 20n, agendaPlanRevision: null, lastReconciledInputThroughSequence: 20n,
    ...(latestUserRevision ? { latestUserRevision } : {}), unresolvedInputs: [] }
}
const client = { query: vi.fn(async () => ({ rows: [] })) } as never

describe("confirmed location terminal applicability", () => {
  it("keeps the legacy path when no typed scope is confirmed", async () => {
    const result = await resolveTaskGraphConfirmedLocationCompletion({ client, loaded: graph([], []), scope,
      reconciliation: reconciliation(), confirmed: { kind: "absent" }, persistedTurnInput: {}, verifiedCompletedTaskIds: new Set() })
    expect(result).toEqual({ kind: "absent" })
    expect(evidenceHarness.calls).toHaveLength(0)
  })

  it("requires exact current Scout location declarations and preserves compatible history only as scoped evidence", async () => {
    const nodes = [scout("old-scout", "old-task", "london"), scout("current-scout", "current-task", "dublin")]
    const loaded = graph(nodes, [10n, 20n])
    evidenceHarness.value = available(["old-scout"])
    const result = await resolveTaskGraphConfirmedLocationCompletion({ client, loaded, scope, reconciliation: reconciliation({
      resultingRevision: 5, stepId: "revise", inputThroughSequence: 20n, soleSteerSequence: 20n,
    }), confirmed, persistedTurnInput: {}, verifiedCompletedTaskIds: new Set(["old-task", "current-task"]) })
    expect(result).toEqual({ kind: "applicable", historicalNodeIndices: new Set() })
    expect(evidenceHarness.calls[0]?.[0]).toMatchObject({ verifiedCurrentLocations: ["dublin"], retainCompatiblePriorScouts: true })
    if (result.kind === "applicable") expect(buildTaskGraphFinalSummaryBinding(loaded, result.historicalNodeIndices)?.members?.[0]?.kind).toBe("business")

    const mismatched = graph([nodes[0]!, scout("current-scout", "current-task", "london")], [10n, 20n])
    await expect(resolveTaskGraphConfirmedLocationCompletion({ client, loaded: mismatched, scope, reconciliation: reconciliation({
      resultingRevision: 5, stepId: "revise", inputThroughSequence: 20n, soleSteerSequence: 20n,
    }), confirmed, persistedTurnInput: {}, verifiedCompletedTaskIds: new Set(["old-task", "current-task"]) }))
      .resolves.toEqual({ kind: "replan" })
  })

  it("does not retire an analysis path that depends on an excluded historical Scout", async () => {
    const nodes = [scout("old-scout", "old-task", "london"), scout("current-scout", "current-task", "dublin"),
      analyst("analysis", "analysis-task", ["old-scout"])]
    const loaded = graph(nodes as ReturnType<typeof scout>[], [10n, 20n, 20n])
    evidenceHarness.value = available([], ["old-scout"])
    await expect(resolveTaskGraphConfirmedLocationCompletion({ client, loaded, scope, reconciliation: reconciliation({
      resultingRevision: 5, stepId: "revise", inputThroughSequence: 20n, soleSteerSequence: 20n,
    }), confirmed, persistedTurnInput: {}, verifiedCompletedTaskIds: new Set(["old-task", "current-task", "analysis-task"]) }))
      .resolves.toEqual({ kind: "replan" })
  })

  it("keeps a retired Scout distinct from completed history while evaluating current scope", async () => {
    const nodes = [scout("retired-scout", "retired-task", "london"), scout("current-scout", "current-task", "dublin")]
    const base = graph(nodes, [10n, 20n])
    const tasks = new Map(base.tasks)
    tasks.set("retired-task", { ...tasks.get("retired-task")!, status: "interrupted" })
    const loaded = { ...base, tasks, state: { ...base.state!, nodes: base.state!.nodes.map((node, index) => index === 0
      ? { ...node, status: "interrupted" as const } : node) } }
    evidenceHarness.value = available()
    const retiredNodeKeys = new Set(["retired-scout"])
    const result = await resolveTaskGraphConfirmedLocationCompletion({ client, loaded, scope, reconciliation: reconciliation({
      resultingRevision: 5, stepId: "revise", inputThroughSequence: 20n, soleSteerSequence: 20n,
    }), confirmed, persistedTurnInput: {}, verifiedCompletedTaskIds: new Set(["current-task"]), retiredNodeKeys })

    expect(result).toEqual({ kind: "applicable", historicalNodeIndices: new Set() })
    expect(evidenceHarness.calls[0]?.[0]).toMatchObject({ retiredNodeKeys })
    expect(taskGraphCompletionApplicability(loaded, undefined, 5, new Set(), new Set(), retiredNodeKeys)).toEqual({ kind: "replan" })
  })

  it("does not permit current analysis to depend on a terminally retired Scout", async () => {
    const nodes = [scout("retired-scout", "retired-task", "london"), scout("current-scout", "current-task", "dublin"),
      analyst("analysis", "analysis-task", ["retired-scout"])]
    const base = graph(nodes as ReturnType<typeof scout>[], [10n, 20n, 20n])
    const tasks = new Map(base.tasks)
    tasks.set("retired-task", { ...tasks.get("retired-task")!, status: "interrupted" })
    const loaded = { ...base, tasks, state: { ...base.state!, nodes: base.state!.nodes.map((node, index) => index === 0
      ? { ...node, status: "interrupted" as const } : node) } }
    evidenceHarness.value = available()
    await expect(resolveTaskGraphConfirmedLocationCompletion({ client, loaded, scope, reconciliation: reconciliation({
      resultingRevision: 5, stepId: "revise", inputThroughSequence: 20n, soleSteerSequence: 20n,
    }), confirmed, persistedTurnInput: {}, verifiedCompletedTaskIds: new Set(["current-task", "analysis-task"]),
      retiredNodeKeys: new Set(["retired-scout"]) })).resolves.toEqual({ kind: "replan" })
  })

  it("does not retain old Scouts when a newer unrelated material revision supersedes the scope", async () => {
    const nodes = [scout("old-scout", "old-task", "london"), scout("current-scout", "current-task", "dublin")]
    evidenceHarness.value = available([], ["old-scout"])
    const state = reconciliation({ resultingRevision: 5, stepId: "later-revise", inputThroughSequence: 30n,
      soleSteerSequence: 30n })
    const result = await resolveTaskGraphConfirmedLocationCompletion({ client, loaded: graph(nodes, [10n, 30n]), scope,
      reconciliation: { ...state, lastReconciledInputThroughSequence: 30n }, confirmed,
      persistedTurnInput: {}, verifiedCompletedTaskIds: new Set(["old-task", "current-task"]) })
    expect(result).toEqual({ kind: "applicable", historicalNodeIndices: new Set([0]) })
    expect(evidenceHarness.calls[0]?.[0]).toMatchObject({ retainCompatiblePriorScouts: false })
  })

  it("requires a fresh Scout after a later ordinary material revision", async () => {
    const nodes = [scout("old-scout", "old-task", "dublin"), analyst("current-analysis", "analysis-task")]
    evidenceHarness.value = available([], ["old-scout"])
    await expect(resolveTaskGraphConfirmedLocationCompletion({ client, loaded: graph(nodes as ReturnType<typeof scout>[], [10n, 30n]), scope,
      reconciliation: { ...reconciliation({ resultingRevision: 5, stepId: "ordinary-revise", inputThroughSequence: 30n,
        soleSteerSequence: 30n }), lastReconciledInputThroughSequence: 30n }, confirmed,
      persistedTurnInput: {}, verifiedCompletedTaskIds: new Set(["old-task", "analysis-task"]) }))
      .resolves.toEqual({ kind: "replan" })
    expect(evidenceHarness.calls[0]?.[0]).toMatchObject({ retainCompatiblePriorScouts: false })
  })
})
