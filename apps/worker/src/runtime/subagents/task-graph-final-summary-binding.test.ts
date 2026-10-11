import { describe, expect, it } from "vitest"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import type { GraphTaskRow, LoadedGraph } from "./task-graph-pg-state.js"
import {
  buildTaskGraphFinalSummaryBinding,
  sameTaskGraphFinalSummaryBinding,
  TASK_GRAPH_FINAL_SUMMARY_BINDING,
} from "./task-graph-final-summary-binding.js"
import type { TaskGraphSnapshot } from "./task-graph-snapshot.js"

const scoutResult = (jobId: string) => ({
  schemaVersion: ROLE_RESULT_SCHEMA,
  role: "scout",
  status: "completed",
  candidates: [{ jobId, source: "greenhouse", url: "https://private.test/job", evidenceIds: ["evidence-job"] }],
  evidence: [{ id: "evidence-job", kind: "job", ref: jobId, source: "private-source" }],
  summary: "PRIVATE_ROLE_NARRATIVE",
})

function row(id: string, role: string, taskType: string, result: unknown): GraphTaskRow {
  return { id, role, taskType, status: "completed", failureReason: null, result }
}

function graph(revision: number, nodeIds: readonly string[], rows: readonly GraphTaskRow[], stateRevision = revision): LoadedGraph {
  return {
    rootTaskId: "root-task",
    item: { id: "task-graph:root-task", revision, content: {}, createdAt: new Date(0) },
    snapshot: { nodes: nodeIds.map(taskId => ({ taskId })) } as unknown as TaskGraphSnapshot,
    state: { revision: stateRevision } as LoadedGraph["state"],
    tasks: new Map(rows.map(task => [task.id, task])),
  } as LoadedGraph
}

describe("current TaskGraph final-summary binding", () => {
  it("reduces only latest snapshot members using scoped rows and nested structured results", () => {
    const loaded = graph(8, ["scout-current", "native-control", "unknown-role"], [
      row("scout-current", "scout", "research", JSON.stringify({ status: "completed", structuredResult: scoutResult("job-current"), finalText: "PRIVATE_FINAL_TEXT" })),
      row("native-control", "auditor", "native_verification", { structuredResult: scoutResult("control-job") }),
      row("unknown-role", "unknown_role", "custom", { structuredResult: { private: "not a role result" } }),
      row("history-only", "scout", "research", { structuredResult: scoutResult("old-job") }),
    ])

    const binding = buildTaskGraphFinalSummaryBinding(loaded)
    expect(binding?.graphRevision).toBe(8)
    expect(binding?.summary.counts.discoveredJobs).toEqual({ knownCount: 1, coverage: "complete" })
    expect(binding?.summary.discoveredJobs.map(item => item.jobId)).toEqual(["job-current"])
    expect(binding?.summary.taskOutcomes.map(item => item.taskId)).toEqual(["scout-current", "unknown-role"])
    expect(binding?.summary.taskOutcomes[1]?.resultState).toBe("unsupported_role")
    expect(JSON.stringify(binding)).not.toContain("PRIVATE_ROLE_NARRATIVE")
    expect(JSON.stringify(binding)).not.toContain("PRIVATE_FINAL_TEXT")
    expect(JSON.stringify(binding)).not.toContain("control-job")
    expect(JSON.stringify(binding)).not.toContain("old-job")
  })

  it("keeps no-graph legacy calls unbound and rejects inconsistent current graph scope", () => {
    const absent = { rootTaskId: "root-task", item: null, snapshot: null, state: null, tasks: new Map() } as LoadedGraph
    expect(buildTaskGraphFinalSummaryBinding(absent)).toBeNull()
    expect(() => buildTaskGraphFinalSummaryBinding({ ...graph(3, [], []), state: null }))
      .toThrow("task_graph_final_summary_graph_invalid")
    expect(() => buildTaskGraphFinalSummaryBinding(graph(3, ["missing"], [])))
      .toThrow("task_graph_final_summary_task_scope_invalid")
    expect(() => buildTaskGraphFinalSummaryBinding(graph(3, [], [], 2)))
      .toThrow("task_graph_final_summary_graph_invalid")
  })

  it("compares revision and full facts, including same-count result changes", () => {
    const first = buildTaskGraphFinalSummaryBinding(graph(4, ["scout"], [
      row("scout", "scout", "research", { structuredResult: scoutResult("job-a") }),
    ]))!
    const sameFacts = buildTaskGraphFinalSummaryBinding(graph(4, ["scout"], [
      row("scout", "scout", "research", { structuredResult: scoutResult("job-a") }),
    ]))!
    const sameCountDifferentFact = buildTaskGraphFinalSummaryBinding(graph(4, ["scout"], [
      row("scout", "scout", "research", { structuredResult: scoutResult("job-b") }),
    ]))!
    const changedRevision = buildTaskGraphFinalSummaryBinding(graph(5, ["scout"], [
      row("scout", "scout", "research", { structuredResult: scoutResult("job-a") }),
    ]))!

    expect(sameTaskGraphFinalSummaryBinding(first, sameFacts)).toBe(true)
    expect(sameTaskGraphFinalSummaryBinding(first, sameCountDifferentFact)).toBe(false)
    expect(sameTaskGraphFinalSummaryBinding(first, changedRevision)).toBe(false)
  })

  it("uses an enumerable private symbol that survives spread but not JSON serialization", () => {
    const binding = buildTaskGraphFinalSummaryBinding(graph(2, [], []))!
    const carrier = { [TASK_GRAPH_FINAL_SUMMARY_BINDING]: binding }
    expect(Object.getOwnPropertyDescriptor(carrier, TASK_GRAPH_FINAL_SUMMARY_BINDING)?.enumerable).toBe(true)
    expect({ ...carrier }[TASK_GRAPH_FINAL_SUMMARY_BINDING]).toBe(binding)
    expect(Object.keys(carrier)).toEqual([])
    expect(JSON.stringify(carrier)).toBe("{}")
  })
})
