import { describe, expect, it } from "vitest"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { loadTaskGraph } from "./task-graph-pg-state.js"
import { taskGraphItemId, TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"
import { reduceTaskGraphFinalSummary, type TaskGraphFinalSummaryNode } from "./task-graph-final-summary.js"

const hash = (character: string) => `sha256:${character.repeat(64)}`
const artifactRef = { artifactId: "cover-letter-1", version: 2, contentHash: hash("a"), sourceDigest: hash("b") }

function scoutResult(jobIds: readonly string[], status: "completed" | "partial" = "completed") {
  const evidence = jobIds.map(jobId => ({ id: `evidence:${jobId}`, kind: "job", ref: jobId, source: "fixture-private-source" }))
  return {
    schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status,
    candidates: jobIds.map(jobId => ({ jobId, source: "greenhouse", url: `https://private.test/${jobId}`, evidenceIds: [`evidence:${jobId}`] })),
    evidence, summary: "private candidate narrative",
  }
}

function analystResult(findings: readonly Readonly<{ jobId: string; score: number }>[], status: "completed" | "partial" = "completed") {
  const jobIds = [...new Set(findings.map(item => item.jobId))]
  const evidence = jobIds.map(jobId => ({ id: `analysis:${jobId}`, kind: "job", ref: jobId, source: "fixture-private-source" }))
  return {
    schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status,
    findings: findings.map(item => ({ ...item, evidenceIds: [`analysis:${item.jobId}`] })), evidence, summary: "private analysis narrative",
  }
}

function reviewerResult(reviewStatus: "passed" | "needs_revision" | "rejected" | "stale", reviewHash = hash("f")) {
  return { schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer", status: "completed", artifactRef, reviewStatus, reviewHash }
}

function node(taskId: string, role: string, taskStatus: string, structuredResult?: unknown, kind: "business" | "internal_control" = "business"): TaskGraphFinalSummaryNode {
  return structuredResult === undefined ? { kind, taskId, role, taskStatus } as TaskGraphFinalSummaryNode
    : { kind, taskId, role, taskStatus, structuredResult } as TaskGraphFinalSummaryNode
}

async function mapPersistedRowsToSummaryNodes(taskId: string, role: "scout" | "analyst", structuredResult: unknown): Promise<TaskGraphFinalSummaryNode[]> {
  const identity = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
  const snapshot = {
    schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
    nodes: [{ key: role, templateId: role, goal: "Read persisted result", successCriteria: ["Evidence captured"], dependsOn: [], depth: 1, taskId }],
  }
  const taskRows = [{ id: taskId, status: "completed", role, failureReason: null, result: { status: "completed", structuredResult } }]
  const client = {
    query: async (sql: string) => {
      if (sql.startsWith('SELECT item."id"')) {
        return { rows: [{ id: taskGraphItemId(identity.parentTaskId), revision: 1, content: snapshot, createdAt: new Date(0) }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT task."id", task."status"')) return { rows: taskRows, rowCount: taskRows.length }
      if (sql.startsWith('SELECT event."type", event."itemId"')) return { rows: [], rowCount: 0 }
      throw new Error("unexpected_task_graph_query")
    },
  }
  const loaded = await loadTaskGraph(client as unknown as Parameters<typeof loadTaskGraph>[0], identity)
  if (!loaded.snapshot) throw new Error("task_graph_snapshot_missing")
  return loaded.snapshot.nodes.map(currentNode => {
    const task = loaded.tasks.get(currentNode.taskId)
    if (!task) throw new Error("task_graph_task_missing")
    const result = task.result as { structuredResult?: unknown }
    return node(task.id, task.role, task.status, result.structuredResult)
  })
}

describe("TaskGraph final-summary reducer", () => {
  it("uses full role results, deduplicates facts, and preserves stable task provenance", () => {
    const nodes = [
      node("scout-a", "scout", "completed", scoutResult(["job-1", "job-2", "job-3", "job-4", "job-5"])),
      node("scout-b", "scout", "completed", scoutResult(["job-4", "job-5", "job-6"])),
      node("analyst-a", "analyst", "completed", analystResult([{ jobId: "job-2", score: 8 }, { jobId: "job-1", score: 7 }, { jobId: "job-2", score: 8 }])),
      node("analyst-b", "analyst", "completed", analystResult([{ jobId: "job-2", score: 9 }, { jobId: "job-3", score: 6 }])),
      node("writer", "writer", "completed", { schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef }),
      node("reviewer-b", "reviewer", "completed", reviewerResult("passed", hash("c"))),
      node("reviewer-a", "reviewer", "completed", reviewerResult("passed")),
    ]
    const summary = reduceTaskGraphFinalSummary({ graphRevision: 7, nodes })
    expect(summary.graphRevision).toBe(7)
    expect(summary.counts.discoveredJobs).toEqual({ knownCount: 6, coverage: "complete" })
    expect(summary.discoveredJobs.find(item => item.jobId === "job-4")?.taskIds).toEqual(["scout-a", "scout-b"])
    expect(summary.discoveredJobs.map(item => item.jobId)).toEqual(["job-1", "job-2", "job-3", "job-4", "job-5", "job-6"])
    expect(summary.counts.analyzedJobs).toEqual({ knownCount: 3, coverage: "complete" })
    expect(summary.analyzedJobs.find(item => item.jobId === "job-2")?.findings).toEqual([
      { taskId: "analyst-a", score: 8 }, { taskId: "analyst-b", score: 9 },
    ])
    expect(summary.counts.artifactReferences).toEqual({ knownCount: 1, coverage: "complete" })
    expect(summary.artifactReferences[0]).toEqual({ artifactRef, taskIds: ["reviewer-a", "reviewer-b", "writer"] })
    expect(summary.counts.reviewOutcomes).toEqual({ knownCount: 1, coverage: "complete" })
    expect(summary.reviewOutcomes).toEqual([{ artifactRef, reviewStatus: "passed", taskIds: ["reviewer-a", "reviewer-b"] }])

    const reordered = [...nodes].reverse().map(item => ({ ...item,
      ...(item.role === "scout" && item.structuredResult ? { structuredResult: { ...item.structuredResult as object,
        candidates: [...(item.structuredResult as { candidates: unknown[] }).candidates].reverse(),
        evidence: [...(item.structuredResult as { evidence: unknown[] }).evidence].reverse() } } : {}),
    }))
    expect(reduceTaskGraphFinalSummary({ graphRevision: 7, nodes: reordered })).toEqual(summary)
  })

  it("keeps partial known facts distinct from missing, invalid, failed, and nonterminal coverage", () => {
    const partial = scoutResult(["known-job"], "partial")
    const invalid = { ...scoutResult(["invalid-job"]), extra: "must fail exact schema validation" }
    const summary = reduceTaskGraphFinalSummary({ graphRevision: 3, nodes: [
      node("scout-partial", "scout", "completed", partial),
      node("scout-missing", "scout", "failed"),
      node("scout-invalid", "scout", "completed", invalid),
      node("scout-running", "scout", "running", scoutResult(["stale-job"])),
      node("analyst-failed", "analyst", "failed", analystResult([{ jobId: "known-analysis", score: 5 }])),
      node("reviewer-missing", "reviewer", "completed"),
    ] })
    expect(summary.counts.discoveredJobs).toEqual({ knownCount: 1, coverage: "partial" })
    expect(summary.discoveredJobs.map(item => item.jobId)).toEqual(["known-job"])
    expect(summary.counts.analyzedJobs).toEqual({ knownCount: 1, coverage: "partial" })
    expect(summary.counts.artifactReferences).toEqual({ knownCount: null, coverage: "unavailable" })
    expect(summary.counts.reviewOutcomes).toEqual({ knownCount: null, coverage: "unavailable" })
    expect(summary.taskOutcomes).toEqual([
      { taskId: "analyst-failed", role: "analyst", taskStatus: "failed", resultState: "valid", roleResultStatus: "completed" },
      { taskId: "reviewer-missing", role: "reviewer", taskStatus: "completed", resultState: "missing" },
      { taskId: "scout-invalid", role: "scout", taskStatus: "completed", resultState: "invalid" },
      { taskId: "scout-missing", role: "scout", taskStatus: "failed", resultState: "missing" },
      { taskId: "scout-partial", role: "scout", taskStatus: "completed", resultState: "valid", roleResultStatus: "partial" },
      { taskId: "scout-running", role: "scout", taskStatus: "running", resultState: "not_terminal" },
    ])
  })

  it("distinguishes not-requested counts from a validated empty result", () => {
    const empty = reduceTaskGraphFinalSummary({ graphRevision: 0, nodes: [] })
    expect(Object.values(empty.counts)).toEqual(Array(4).fill({ knownCount: null, coverage: "not_requested" }))
    const requested = reduceTaskGraphFinalSummary({ graphRevision: 1, nodes: [node("empty-scout", "scout", "completed", scoutResult([]))] })
    expect(requested.counts.discoveredJobs).toEqual({ knownCount: 0, coverage: "complete" })
    expect(requested.counts.analyzedJobs).toEqual({ knownCount: null, coverage: "not_requested" })
  })

  it("keeps valid facts from unsuccessful terminal tasks partial and ignores in-flight results", () => {
    const summary = reduceTaskGraphFinalSummary({ graphRevision: 4, nodes: [
      node("interrupted-scout", "scout", "interrupted", scoutResult(["interrupted-job"])),
      node("cancelled-scout", "scout", "cancelled", scoutResult(["cancelled-job"])),
      node("closed-scout", "scout", "closed", scoutResult(["closed-job"])),
      node("running-scout", "scout", "running", scoutResult(["stale-job"])),
    ] })
    expect(summary.counts.discoveredJobs).toEqual({ knownCount: 3, coverage: "partial" })
    expect(summary.discoveredJobs.map(item => item.jobId)).toEqual(["cancelled-job", "closed-job", "interrupted-job"])
    expect(summary.taskOutcomes.map(item => item.resultState)).toEqual(["valid", "valid", "valid", "not_terminal"])
  })

  it("rejects Array(n) holes in Scout candidates after persisted-row mapping", async () => {
    // JSONB cannot persist sparse arrays. The mock row injects this only in memory; loadTaskGraph maps the persisted row, then the current graph mapping builds reducer nodes.
    const structuredResult = { ...scoutResult(["mapped-job"]), candidates: new Array<unknown>(1) }
    const nodes = await mapPersistedRowsToSummaryNodes("sparse-scout", "scout", structuredResult)
    const mappedResult = nodes[0]?.structuredResult as { candidates: unknown[] }
    expect(mappedResult.candidates).toHaveLength(1)
    expect(Reflect.ownKeys(mappedResult.candidates)).toEqual(["length"])

    const summary = reduceTaskGraphFinalSummary({ graphRevision: 1, nodes })
    expect(summary.discoveredJobs).toEqual([])
    expect(summary.counts.discoveredJobs).toEqual({ knownCount: null, coverage: "unavailable" })
    expect(summary.taskOutcomes).toEqual([{ taskId: "sparse-scout", role: "scout", taskStatus: "completed", resultState: "invalid" }])
  })

  it("rejects a deleted persisted Analyst finding index after row mapping", async () => {
    const result = analystResult([{ jobId: "mapped-job", score: 7 }])
    const findings: unknown[] = [result.findings[0]]
    delete findings[0]
    const nodes = await mapPersistedRowsToSummaryNodes("sparse-analyst", "analyst", { ...result, findings })
    const mappedResult = nodes[0]?.structuredResult as { findings: unknown[] }
    expect(mappedResult.findings).toHaveLength(1)
    expect(Reflect.ownKeys(mappedResult.findings)).toEqual(["length"])

    const summary = reduceTaskGraphFinalSummary({ graphRevision: 1, nodes })
    expect(summary.analyzedJobs).toEqual([])
    expect(summary.counts.analyzedJobs).toEqual({ knownCount: null, coverage: "unavailable" })
    expect(summary.taskOutcomes).toEqual([{ taskId: "sparse-analyst", role: "analyst", taskStatus: "completed", resultState: "invalid" }])
  })

  it("rejects persisted Analyst arrays whose length exceeds their own keys after row mapping", async () => {
    const result = analystResult([{ jobId: "nested-job", score: 7 }])
    const finding = result.findings[0]!
    const evidenceIds = [...finding.evidenceIds]
    evidenceIds.length = 2
    const nodes = await mapPersistedRowsToSummaryNodes("sparse-analyst", "analyst", {
      ...result, findings: [{ ...finding, evidenceIds }],
    })
    const mappedResult = nodes[0]?.structuredResult as { findings: Array<{ evidenceIds: unknown[] }> }
    expect(mappedResult.findings[0]?.evidenceIds).toHaveLength(2)
    expect(Reflect.ownKeys(mappedResult.findings[0]!.evidenceIds)).toEqual(["0", "length"])

    const summary = reduceTaskGraphFinalSummary({ graphRevision: 1, nodes })
    expect(summary.analyzedJobs).toEqual([])
    expect(summary.counts.analyzedJobs).toEqual({ knownCount: null, coverage: "unavailable" })
    expect(summary.taskOutcomes).toEqual([{ taskId: "sparse-analyst", role: "analyst", taskStatus: "completed", resultState: "invalid" }])
  })

  it("excludes internal controls and omits prose, URLs, evidence, and review receipt hashes", () => {
    const secretReviewHash = hash("e")
    const summary = reduceTaskGraphFinalSummary({ graphRevision: 2, nodes: [
      node("control-scout", "scout", "completed", scoutResult(["control-job"]), "internal_control"),
      node("control-reviewer", "reviewer", "completed", reviewerResult("passed", secretReviewHash), "internal_control"),
      node("business-unknown", "executor", "completed", { private: "must not be echoed" }),
    ] })
    const encoded = JSON.stringify(summary)
    expect(summary.discoveredJobs).toEqual([])
    expect(summary.taskOutcomes).toEqual([{ taskId: "business-unknown", role: "unsupported", taskStatus: "completed", resultState: "unsupported_role" }])
    expect(encoded).not.toContain("control-job")
    expect(encoded).not.toContain("private candidate narrative")
    expect(encoded).not.toContain("https://private.test")
    expect(encoded).not.toContain("fixture-private-source")
    expect(encoded).not.toContain(secretReviewHash)
    expect(encoded).not.toContain("must not be echoed")
    expect(Object.keys(summary)).not.toEqual(expect.arrayContaining(["completed", "submitted", "approved", "highMatchCount", "summary"]))
  })

  it("fails closed on an invalid revision envelope and duplicate task identity", () => {
    expect(() => reduceTaskGraphFinalSummary({ graphRevision: -1, nodes: [] })).toThrow("task_graph_final_summary_envelope_invalid")
    expect(() => reduceTaskGraphFinalSummary({ graphRevision: 0, nodes: [node("task-1", "scout", "completed", scoutResult(["job-1"]))] }))
      .toThrow("task_graph_final_summary_envelope_invalid")
    expect(() => reduceTaskGraphFinalSummary({ graphRevision: 2, nodes: [
      node("same-task", "scout", "completed", scoutResult(["job-1"])),
      node("same-task", "analyst", "completed", analystResult([{ jobId: "job-2", score: 4 }])),
    ] })).toThrow("task_graph_final_summary_task_identity_conflict")
  })

  it("rejects unsafe provenance and result identifiers without asserting zero", () => {
    expect(() => reduceTaskGraphFinalSummary({ graphRevision: 1, nodes: [node("task/unsafe", "scout", "completed", scoutResult(["job-1"]))] }))
      .toThrow("task_graph_final_summary_node_invalid")
    const summary = reduceTaskGraphFinalSummary({ graphRevision: 2, nodes: [
      node("scout-safe", "scout", "completed", scoutResult(["job/unsafe"])),
      node("writer-safe", "writer", "completed", { schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed",
        artifactRef: { ...artifactRef, artifactId: "a".repeat(81) } }),
    ] })
    expect(summary.counts.discoveredJobs).toEqual({ knownCount: null, coverage: "unavailable" })
    expect(summary.counts.artifactReferences).toEqual({ knownCount: null, coverage: "unavailable" })
    expect(summary.taskOutcomes.map(item => item.resultState)).toEqual(["invalid", "invalid"])
    expect(JSON.stringify(summary)).not.toContain("job/unsafe")
    expect(JSON.stringify(summary)).not.toContain("a".repeat(81))
  })
})
