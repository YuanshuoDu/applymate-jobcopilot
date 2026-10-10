import { describe, expect, it } from "vitest"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import type { GraphTaskRow, LoadedGraph } from "./task-graph-pg-state.js"
import { buildTaskGraphPlanningFacts } from "./task-graph-planning-facts.js"
import type { TaskGraphSnapshot } from "./task-graph-snapshot.js"

const artifactRef = {
  artifactId: "private-artifact-id", version: 2,
  contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"b".repeat(64)}`,
}

function scoutResult(jobIds: readonly string[], status: "completed" | "partial" = "completed") {
  return {
    schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status,
    candidates: jobIds.map(jobId => ({
      jobId, source: "greenhouse", url: `https://private.example/${jobId}`, evidenceIds: [`evidence:${jobId}`],
    })),
    evidence: jobIds.map(jobId => ({ id: `evidence:${jobId}`, kind: "job", ref: jobId, source: "private-source" })),
    summary: "PRIVATE_ROLE_NARRATIVE",
  }
}

function analystResult(findings: readonly Readonly<{ jobId: string; score: number }>[], status: "completed" | "partial" = "completed") {
  const jobIds = [...new Set(findings.map(finding => finding.jobId))]
  return {
    schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status,
    findings: findings.map(finding => ({ ...finding, evidenceIds: [`analysis:${finding.jobId}`] })),
    evidence: jobIds.map(jobId => ({ id: `analysis:${jobId}`, kind: "job", ref: jobId, source: "private-source" })),
    summary: "PRIVATE_ANALYSIS_NARRATIVE",
  }
}

function row(
  id: string,
  role: string,
  taskType: string,
  status: GraphTaskRow["status"],
  structuredResult?: unknown,
): GraphTaskRow {
  return {
    id, role, taskType, status, failureReason: null,
    result: structuredResult === undefined ? null : { status: "completed", finalText: "PRIVATE_FINAL_TEXT", structuredResult },
  }
}

function loadedGraph(
  revision: number,
  currentTaskIds: readonly string[],
  rows: readonly GraphTaskRow[],
  stateRevision = revision,
): LoadedGraph {
  return {
    rootTaskId: "root-task",
    item: { id: "task-graph:root-task", revision, content: {}, createdAt: new Date(0) },
    snapshot: { nodes: currentTaskIds.map(taskId => ({ taskId })) } as unknown as TaskGraphSnapshot,
    state: { revision: stateRevision } as LoadedGraph["state"],
    tasks: new Map(rows.map(task => [task.id, task])),
  } as LoadedGraph
}

describe("TaskGraph planning facts producer", () => {
  it("counts full current-node results, deduplicates provenance, and returns counts only", () => {
    const rows = [
      row("scout-a", "scout", "research", "completed", scoutResult(["job-1", "job-2", "job-3", "job-4", "job-5"])),
      row("scout-b", "scout", "research", "completed", scoutResult(["job-4", "job-5", "job-6"])),
      row("scout-missing", "scout", "research", "completed"),
      row("analyst-a", "analyst", "research", "completed", analystResult([
        { jobId: "job-1", score: 7 }, { jobId: "job-2", score: 8 }, { jobId: "job-3", score: 6 },
        { jobId: "job-4", score: 5 }, { jobId: "job-2", score: 8 },
      ])),
      row("analyst-b", "analyst", "research", "failed", analystResult([
        { jobId: "job-2", score: 9 }, { jobId: "job-5", score: 4 }, { jobId: "job-6", score: 3 },
      ], "partial")),
      row("writer", "writer", "artifact", "completed", {
        schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef,
      }),
      row("reviewer", "reviewer", "review", "completed", {
        schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer", status: "completed", artifactRef,
        reviewStatus: "passed", reviewHash: `sha256:${"c".repeat(64)}`,
      }),
      row("native-control", "auditor", "native_verification", "completed", scoutResult(["control-job"])),
      row("history-only", "scout", "research", "completed", scoutResult(["historical-job"])),
    ]
    const currentTaskIds = rows.filter(task => task.id !== "history-only").map(task => task.id)
    const loaded = loadedGraph(9, currentTaskIds, rows)
    const facts = buildTaskGraphPlanningFacts(loaded)!

    expect(facts.graphRevision).toBe(9)
    expect(Object.keys(facts)).toEqual(["graphRevision", "counts"])
    expect(Object.keys(facts.counts).sort()).toEqual([
      "analyzedJobs", "artifactReferences", "discoveredJobs", "reviewOutcomes",
    ])
    expect(facts.counts).toEqual({
      discoveredJobs: { knownCount: 6, coverage: "partial" },
      analyzedJobs: { knownCount: 6, coverage: "partial" },
      artifactReferences: { knownCount: 1, coverage: "complete" },
      reviewOutcomes: { knownCount: 1, coverage: "complete" },
    })
    const encoded = JSON.stringify(facts)
    for (const privateValue of ["job-1", "control-job", "historical-job", "private-artifact-id", "PRIVATE_ROLE_NARRATIVE", "PRIVATE_FINAL_TEXT", "private.example", "private-source"]) {
      expect(encoded).not.toContain(privateValue)
    }

    const fresh = buildTaskGraphPlanningFacts(loaded)!
    expect(fresh).not.toBe(facts)
    expect(fresh.counts).not.toBe(facts.counts)
    for (const key of Object.keys(facts.counts) as Array<keyof typeof facts.counts>) {
      expect(fresh.counts[key]).not.toBe(facts.counts[key])
    }
  })

  it("distinguishes completed-empty from missing and omits an absent graph", () => {
    const empty = buildTaskGraphPlanningFacts(loadedGraph(4, ["empty"], [
      row("empty", "scout", "research", "completed", scoutResult([])),
    ]))
    const missing = buildTaskGraphPlanningFacts(loadedGraph(5, ["missing"], [
      row("missing", "scout", "research", "completed"),
    ]))
    const absent = { rootTaskId: "root-task", item: null, snapshot: null, state: null, tasks: new Map() } as LoadedGraph

    expect(empty?.counts.discoveredJobs).toEqual({ knownCount: 0, coverage: "complete" })
    expect(missing?.counts.discoveredJobs).toEqual({ knownCount: null, coverage: "unavailable" })
    expect(buildTaskGraphPlanningFacts(absent)).toBeNull()
  })

  it("retains unavailable coverage for malformed role results", () => {
    const malformed = buildTaskGraphPlanningFacts(loadedGraph(7, ["unsafe"], [
      row("unsafe", "scout", "research", "completed", scoutResult(["job/with/slash"])),
    ]))

    expect(malformed?.counts.discoveredJobs).toEqual({ knownCount: null, coverage: "unavailable" })
  })

  it("propagates graph and reducer invariant errors", () => {
    const inconsistent = loadedGraph(6, [], [], 5)
    const duplicateNodes = loadedGraph(7, ["duplicate", "duplicate"], [
      row("duplicate", "scout", "research", "completed", scoutResult(["job-1"])),
    ])

    expect(() => buildTaskGraphPlanningFacts(inconsistent)).toThrow("task_graph_final_summary_graph_invalid")
    expect(() => buildTaskGraphPlanningFacts(duplicateNodes)).toThrow("task_graph_final_summary_task_identity_conflict")
  })
})
