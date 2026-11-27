import { describe, expect, it } from "vitest"
import type { LoadedGraph } from "../subagents/task-graph-pg-state.js"
import { taskGraphCompletionApplicability } from "./task-graph-completion-applicability.js"

type NodeFixture = Readonly<{
  key: string; taskId: string; role: "scout" | "analyst"; checkpoint: bigint | null
  relation: "predates_current_inputs" | "covers_current_inputs" | "unknown"; dependsOn?: readonly string[]
  status?: string; failureReason?: string | null; repairOf?: unknown
}>
const latest = { resultingRevision: 5, stepId: "user-revise", inputThroughSequence: 10n }
function loaded(nodes: readonly NodeFixture[], revision = 6): LoadedGraph {
  const snapshotNodes = nodes.map(node => ({ key: node.key, taskId: node.taskId, templateId: node.role, dependsOn: node.dependsOn ?? [],
    verificationDisposition: "typed", verification: { role: node.role },
    ...(node.repairOf ? { repairOf: node.repairOf } : {}) }))
  const tasks = new Map(nodes.map(node => [node.taskId, { id: node.taskId, role: node.role, taskType: node.role === "scout" ? "job_discovery" : "job_analysis",
    status: node.status ?? "completed", attemptCount: 1, failureReason: node.failureReason ?? null, result: { structuredResult: { role: node.role } } }]))
  return { rootTaskId: "root", item: { id: "graph", revision, content: {}, createdAt: new Date(0) }, snapshot: { nodes: snapshotNodes },
    state: null, tasks, sourceInputCheckpointByNodeKey: new Map(nodes.map(node => [node.key,
      node.checkpoint === null ? null : { inputThroughSequence: node.checkpoint }])),
    sourceInputRelationByNodeKey: new Map(nodes.map(node => [node.key, node.relation])) } as unknown as LoadedGraph
}
const ids = (...values: string[]) => new Set(values)

describe("TaskGraph completion applicability", () => {
  it("keeps the legacy path when no validated user revision exists", () => {
    const result = taskGraphCompletionApplicability({} as LoadedGraph, undefined, 0, ids())
    expect(result).toEqual({ kind: "applicable", historicalNodeIndices: new Set() })
  })

  it("excludes an older verified Scout when current verified Scout and Analyst evidence survives", () => {
    const result = taskGraphCompletionApplicability(loaded([
      { key: "old-scout", taskId: "old-scout-task", role: "scout", checkpoint: 9n, relation: "predates_current_inputs" },
      { key: "scout", taskId: "scout-task", role: "scout", checkpoint: 10n, relation: "covers_current_inputs" },
      { key: "analyst", taskId: "analyst-task", role: "analyst", checkpoint: 10n, relation: "covers_current_inputs", dependsOn: ["scout"] },
    ]), latest, 6, ids("old-scout-task", "scout-task", "analyst-task"))
    expect(result).toEqual({ kind: "applicable", historicalNodeIndices: new Set([0]) })
  })

  it("keeps only an independently verified compatible prior Scout current", () => {
    const graphValue = loaded([
      { key: "old-scout", taskId: "old-scout-task", role: "scout", checkpoint: 9n, relation: "predates_current_inputs" },
      { key: "scout", taskId: "scout-task", role: "scout", checkpoint: 10n, relation: "covers_current_inputs" },
      { key: "analyst", taskId: "analyst-task", role: "analyst", checkpoint: 10n, relation: "covers_current_inputs" },
    ])
    const result = taskGraphCompletionApplicability(graphValue, latest, 6,
      ids("old-scout-task", "scout-task", "analyst-task"), new Set(["old-scout"]))
    expect(result).toEqual({ kind: "applicable", historicalNodeIndices: new Set() })
  })

  it("excludes only a separately retired interrupted Scout without calling it verified or historical", () => {
    const result = taskGraphCompletionApplicability(loaded([
      { key: "retired-scout", taskId: "retired-task", role: "scout", checkpoint: 9n, relation: "predates_current_inputs", status: "interrupted" },
      { key: "current-scout", taskId: "current-task", role: "scout", checkpoint: 10n, relation: "covers_current_inputs" },
      { key: "analyst", taskId: "analyst-task", role: "analyst", checkpoint: 10n, relation: "covers_current_inputs" },
    ]), latest, 6, ids("current-task", "analyst-task"), new Set(), ids("retired-scout"))
    expect(result).toEqual({ kind: "applicable", historicalNodeIndices: new Set() })
  })

  it("rejects retirement membership without an interrupted typed Scout or when current work depends on it", () => {
    const retired = loaded([
      { key: "retired-scout", taskId: "retired-task", role: "scout", checkpoint: 9n, relation: "predates_current_inputs", status: "interrupted" },
      { key: "current-scout", taskId: "current-task", role: "scout", checkpoint: 10n, relation: "covers_current_inputs" },
      { key: "analyst", taskId: "analyst-task", role: "analyst", checkpoint: 10n, relation: "covers_current_inputs" },
    ])
    expect(taskGraphCompletionApplicability(retired, latest, 6, ids("current-task", "analyst-task"), new Set(), ids("missing")))
      .toEqual({ kind: "replan" })
    expect(taskGraphCompletionApplicability(loaded([
      { key: "retired-scout", taskId: "retired-task", role: "scout", checkpoint: 9n, relation: "predates_current_inputs" },
      { key: "current-scout", taskId: "current-task", role: "scout", checkpoint: 10n, relation: "covers_current_inputs" },
      { key: "analyst", taskId: "analyst-task", role: "analyst", checkpoint: 10n, relation: "covers_current_inputs", dependsOn: ["retired-scout"] },
    ]), latest, 6, ids("current-task", "analyst-task"), new Set(), ids("retired-scout"))).toEqual({ kind: "replan" })
  })

  it("requests replanning when excluded historical role has no current verified result", () => {
    const result = taskGraphCompletionApplicability(loaded([
      { key: "old-scout", taskId: "old-scout-task", role: "scout", checkpoint: 9n, relation: "predates_current_inputs" },
      { key: "analyst", taskId: "analyst-task", role: "analyst", checkpoint: 10n, relation: "covers_current_inputs" },
    ]), latest, 6, ids("old-scout-task", "analyst-task"))
    expect(result).toEqual({ kind: "replan" })
  })

  it("selects stale verified repair nodes for history instead of letting repairOf bypass selection", () => {
    const result = taskGraphCompletionApplicability(loaded([
      { key: "old-scout-repair", taskId: "old-repair-task", role: "scout", checkpoint: 9n, relation: "predates_current_inputs",
        repairOf: { graphRootTaskId: "root", nodeKey: "old-scout", taskId: "old-scout-task", criterionIds: ["candidate-present"] } },
      { key: "scout", taskId: "scout-task", role: "scout", checkpoint: 10n, relation: "covers_current_inputs" },
      { key: "analyst", taskId: "analyst-task", role: "analyst", checkpoint: 10n, relation: "covers_current_inputs" },
    ]), latest, 6, ids("old-repair-task", "scout-task", "analyst-task"))
    expect(result).toEqual({ kind: "applicable", historicalNodeIndices: new Set([0]) })
  })

  it("replans instead of reducing a stale role result that cannot meet the historical binding", () => {
    const result = taskGraphCompletionApplicability(loaded([
      { key: "old-scout", taskId: "old-scout-task", role: "scout", checkpoint: 9n, relation: "predates_current_inputs",
        status: "failed", failureReason: "task_graph_verification_failed" },
      { key: "scout", taskId: "scout-task", role: "scout", checkpoint: 10n, relation: "covers_current_inputs" },
      { key: "analyst", taskId: "analyst-task", role: "analyst", checkpoint: 10n, relation: "covers_current_inputs" },
    ]), latest, 6, ids("scout-task", "analyst-task"))
    expect(result).toEqual({ kind: "replan" })
  })

  it("rejects a current result that still depends on excluded evidence", () => {
    const result = taskGraphCompletionApplicability(loaded([
      { key: "old-scout", taskId: "old-scout-task", role: "scout", checkpoint: 9n, relation: "predates_current_inputs" },
      { key: "scout", taskId: "scout-task", role: "scout", checkpoint: 10n, relation: "covers_current_inputs" },
      { key: "analyst", taskId: "analyst-task", role: "analyst", checkpoint: 10n, relation: "covers_current_inputs", dependsOn: ["old-scout"] },
    ]), latest, 6, ids("old-scout-task", "scout-task", "analyst-task"))
    expect(result).toEqual({ kind: "replan" })
  })

  it("does not accept a missing source checkpoint as current", () => {
    const result = taskGraphCompletionApplicability(loaded([
      { key: "scout", taskId: "scout-task", role: "scout", checkpoint: null, relation: "unknown" },
      { key: "analyst", taskId: "analyst-task", role: "analyst", checkpoint: 10n, relation: "covers_current_inputs" },
    ]), latest, 6, ids("scout-task", "analyst-task"))
    expect(result).toEqual({ kind: "replan" })
  })

  it("uses the validated source checkpoint when advisory current-step relation is unknown", () => {
    const result = taskGraphCompletionApplicability(loaded([
      { key: "scout", taskId: "scout-task", role: "scout", checkpoint: 10n, relation: "unknown" },
      { key: "analyst", taskId: "analyst-task", role: "analyst", checkpoint: 10n, relation: "covers_current_inputs" },
    ]), latest, 6, ids("scout-task", "analyst-task"))
    expect(result).toEqual({ kind: "applicable", historicalNodeIndices: new Set() })
  })

  it("fails closed when the validated revise result is newer than the loaded graph", () => {
    const result = taskGraphCompletionApplicability(loaded([
      { key: "scout", taskId: "scout-task", role: "scout", checkpoint: 10n, relation: "covers_current_inputs" },
    ], 4), latest, 4, ids("scout-task"))
    expect(result).toEqual({ kind: "replan" })
  })
})
