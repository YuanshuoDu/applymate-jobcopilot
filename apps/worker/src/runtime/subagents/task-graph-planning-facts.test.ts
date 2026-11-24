import { describe, expect, it } from "vitest"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import type { GraphTaskRow, LoadedGraph } from "./task-graph-pg-state.js"
import { buildTaskGraphPlanningFacts } from "./task-graph-planning-facts.js"
import { TASK_GRAPH_SNAPSHOT_VERSION, parseTaskGraphSnapshot, taskGraphState, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-verification-report.js"

const artifactRef = {
  artifactId: "private-artifact-id", version: 2,
  contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"b".repeat(64)}`,
}

function scoutResult(jobIds: readonly string[], status: "completed" | "partial" = "completed") {
  return {
    schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status,
    candidates: jobIds.map((jobId, index) => ({
      jobId, source: "greenhouse", url: `https://private.example/${jobId}`, evidenceIds: [`evidence:${jobId}:${index}`],
    })),
    evidence: jobIds.map((jobId, index) => ({ id: `evidence:${jobId}:${index}`, kind: "job", ref: jobId, source: "private-source" })),
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
    ...(role === "prepare" ? { attemptCount: 1 } : {}),
    result: structuredResult === undefined ? null : { status: "completed", finalText: "PRIVATE_FINAL_TEXT", structuredResult },
  }
}

function loadedGraph(
  revision: number,
  currentTaskIds: readonly string[],
  rows: readonly GraphTaskRow[],
  stateRevision = revision,
): LoadedGraph {
  const tasks = new Map(rows.map(task => [task.id, task]))
  return {
    rootTaskId: "root-task",
    item: { id: "task-graph:root-task", revision, content: {}, createdAt: new Date(0) },
    snapshot: { nodes: currentTaskIds.map((taskId, index) => ({ taskId, key: `node-${index}`, templateId: tasks.get(taskId)?.role ?? "unknown" })) } as unknown as TaskGraphSnapshot,
    state: { revision: stateRevision } as LoadedGraph["state"],
    tasks,
  } as LoadedGraph
}

function markedWaveLoaded(): LoadedGraph {
  const marker = { schemaVersion: "agent-harness.v2.objective-tailor-graph.v1", sourceNodeCount: 3,
    slots: Array.from({ length: 5 }, (_, index) => ({ slotId: `tailor-${index + 1}`,
      sourceAnalystNodeKey: index % 2 === 0 ? "analyst-a" : "analyst-b",
      writerNodeKey: `wave-writer-${index + 1}`, reviewerNodeKey: `wave-reviewer-${index + 1}` })) }
  const verification = (role: "scout" | "analyst", id: string) => ({
    schemaVersion: "agent-harness.v2.task-graph-verification.v1", role,
    criteria: [{ id, check: role === "scout" ? { kind: "candidate_count_gte", minimum: 1 } : { kind: "finding_count_gte", minimum: 1 } }],
  })
  const criteriaReport = (id: string) => ({ verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met",
    criteria: [{ criterionId: id, status: "passed", reasonCode: "criteria_met" }], evidenceDigest: "a".repeat(64), resultDigest: "b".repeat(64) })
  const snapshotNodes: Record<string, unknown>[] = [
    { key: "scout", templateId: "scout", goal: "Find jobs", successCriteria: ["Return candidates"], dependsOn: [], depth: 1,
      taskId: "source-scout", verification: verification("scout", "candidate-count"), verificationDisposition: "typed" },
    { key: "analyst-a", templateId: "analyst", goal: "Analyze jobs", successCriteria: ["Return findings"], dependsOn: ["scout"], depth: 2,
      taskId: "source-analyst-a", verification: verification("analyst", "finding-count-a"), verificationDisposition: "typed" },
    { key: "analyst-b", templateId: "analyst", goal: "Analyze jobs", successCriteria: ["Return findings"], dependsOn: ["scout"], depth: 2,
      taskId: "source-analyst-b", verification: verification("analyst", "finding-count-b"), verificationDisposition: "typed" },
  ]
  for (let index = 1; index <= 5; index += 1) {
    const slot = marker.slots[index - 1]!
    snapshotNodes.push({ key: slot.writerNodeKey, templateId: "cover_letter_writer", goal: "Private draft", successCriteria: ["Write draft"],
      dependsOn: [slot.sourceAnalystNodeKey], depth: 3, taskId: `wave-writer-task-${index}`, verificationDisposition: "specialized" })
    snapshotNodes.push({ key: slot.reviewerNodeKey, templateId: "cover_letter_reviewer", goal: "Private review", successCriteria: ["Review draft"],
      dependsOn: [slot.writerNodeKey], depth: 4, taskId: `wave-reviewer-task-${index}`, verificationDisposition: "specialized" })
  }
  const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, objectiveTailor: marker, nodes: snapshotNodes })
  const taskRows: GraphTaskRow[] = []
  const envelope = (structuredResult: unknown, report?: unknown) => ({ finalItemId: "final-item", finalText: "PRIVATE_TEXT",
    status: "completed", stepCount: 1, toolCallCount: 1, structuredResult, ...(report ? { taskGraphVerificationReport: report } : {}) })
  taskRows.push(row("source-scout", "scout", "job_discovery", "completed", scoutResult(["source-job"])) as GraphTaskRow)
  taskRows[0] = { ...taskRows[0]!, result: envelope(scoutResult(["source-job"]), criteriaReport("candidate-count")) }
  for (const [taskId, criterionId] of [["source-analyst-a", "finding-count-a"], ["source-analyst-b", "finding-count-b"]] as const) {
    taskRows.push({ ...row(taskId, "analyst", "job_analysis", "completed", analystResult([{ jobId: "source-job", score: 8 }]))!,
      result: envelope(analystResult([{ jobId: "source-job", score: 8 }]), criteriaReport(criterionId)) })
  }
  for (let index = 1; index <= 5; index += 1) {
    taskRows.push(row(`wave-writer-task-${index}`, "writer", "cover_letter_draft", "completed", {
      schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef,
    })!)
    taskRows.push(row(`wave-reviewer-task-${index}`, "reviewer", "cover_letter_review", "completed", {
      schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer", status: "completed", artifactRef,
      reviewStatus: "passed", reviewHash: `sha256:${"c".repeat(64)}`,
    })!)
  }
  const tasks = new Map(taskRows.map(task => [task.id, task]))
  const statuses = new Map(taskRows.map(task => [task.id, { status: task.status, failureReason: task.failureReason }]))
  const revision = 23, state = taskGraphState(snapshot, revision, statuses, [])
  return { rootTaskId: "root-task", snapshot, state, tasks, discoveryTurnEligibility: "ordinary",
    item: { id: "task-graph:root-task", revision, content: snapshot, createdAt: new Date(0) } }
}

describe("TaskGraph planning facts producer", () => {
  it("counts full current-node results, deduplicates provenance, and returns advisory facts without identifiers", () => {
    const rows = [
      row("scout-a", "scout", "research", "completed", scoutResult(["job-1", "job-2", "job-3", "job-4", "job-5", "job-2", "job-4"])),
      row("scout-b", "scout", "research", "completed", scoutResult(["job-4", "job-5", "job-6"])),
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
      row("prepare-task", "prepare", "scheduled_application_prepare", "completed", {
        schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare", status: "completed", taskId: "prepare-task", attemptCount: 1,
        snapshotDigest: `sha256:${"d".repeat(64)}`, checkpointDigest: "e".repeat(64),
        jobs: [{ jobId: "prepared-job", status: "prepared" }], materials: [],
      }),
      row("native-control", "auditor", "native_verification", "completed", scoutResult(["control-job"])),
      row("history-only", "scout", "research", "completed", scoutResult(["historical-job"])),
    ]
    const currentTaskIds = rows.filter(task => task.id !== "history-only").map(task => task.id)
    const loaded = loadedGraph(9, currentTaskIds, rows)
    const facts = buildTaskGraphPlanningFacts(loaded)!

    expect(facts.graphRevision).toBe(9)
    expect(Object.keys(facts)).toEqual(["graphRevision", "scoutOverlap", "counts"])
    expect(Object.keys(facts.counts).sort()).toEqual([
      "analyzedJobs", "artifactReferences", "discoveredJobs", "prepareJobs", "reviewOutcomes",
    ])
    expect(facts.counts).toEqual({
      discoveredJobs: { knownCount: 6, coverage: "complete" },
      analyzedJobs: { knownCount: 6, coverage: "partial" },
      prepareJobs: { knownCount: 1, coverage: "complete" },
      artifactReferences: { knownCount: 1, coverage: "complete" },
      reviewOutcomes: { knownCount: 1, coverage: "complete" },
    })
    expect(facts.scoutOverlap).toEqual({ coverage: "complete", scouts: [
      { key: "node-0", taskStatus: "completed", resultStatus: "completed", resultCoverage: "complete", reportedCount: 5, sharedCount: 2 },
      { key: "node-1", taskStatus: "completed", resultStatus: "completed", resultCoverage: "complete", reportedCount: 3, sharedCount: 2 },
    ] })
    const encoded = JSON.stringify(facts)
    for (const privateValue of ["job-1", "control-job", "historical-job", "scout-a", "scout-b", "analyst-a", "analyst-b", "writer", "reviewer", "prepare-task", "native-control", "history-only", "private-artifact-id", "PRIVATE_ROLE_NARRATIVE", "PRIVATE_ANALYSIS_NARRATIVE", "PRIVATE_FINAL_TEXT", "private.example", "private-source"]) {
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
    expect(empty?.scoutOverlap).toEqual({ coverage: "complete", scouts: [
      { key: "node-0", taskStatus: "completed", resultStatus: "completed", resultCoverage: "complete", reportedCount: 0, sharedCount: 0 },
    ] })
    expect(missing?.counts.discoveredJobs).toEqual({ knownCount: null, coverage: "unavailable" })
    expect(missing?.scoutOverlap).toEqual({ coverage: "unavailable", scouts: [
      { key: "node-0", taskStatus: "completed", resultStatus: null, resultCoverage: "unavailable", reportedCount: null, sharedCount: null },
    ] })
    expect(buildTaskGraphPlanningFacts(absent)).toBeNull()
  })

  it("keeps result completeness separate from lifecycle and excludes unavailable Scouts from overlap", () => {
    const facts = buildTaskGraphPlanningFacts(loadedGraph(8, ["partial", "failed-complete", "running", "malformed", "empty"], [
      row("partial", "scout", "research", "failed", scoutResult(["shared-job", "valid-only"], "partial")),
      row("failed-complete", "scout", "research", "failed", scoutResult(["shared-job"])),
      row("running", "scout", "research", "running", scoutResult(["valid-only"])),
      row("malformed", "scout", "research", "completed", scoutResult(["bad/job-id"])),
      row("empty", "scout", "research", "completed", scoutResult([])),
    ]))!

    expect(facts.scoutOverlap).toEqual({ coverage: "partial", scouts: [
      { key: "node-0", taskStatus: "failed", resultStatus: "partial", resultCoverage: "partial", reportedCount: 2, sharedCount: 1 },
      { key: "node-1", taskStatus: "failed", resultStatus: "completed", resultCoverage: "complete", reportedCount: 1, sharedCount: 1 },
      { key: "node-2", taskStatus: "running", resultStatus: null, resultCoverage: "unavailable", reportedCount: null, sharedCount: null },
      { key: "node-3", taskStatus: "completed", resultStatus: null, resultCoverage: "unavailable", reportedCount: null, sharedCount: null },
      { key: "node-4", taskStatus: "completed", resultStatus: "completed", resultCoverage: "complete", reportedCount: 0, sharedCount: 0 },
    ] })
    expect(facts.counts.discoveredJobs.coverage).toBe("partial")
    const encoded = JSON.stringify(facts.scoutOverlap)
    for (const privateValue of ["shared-job", "valid-only", "bad/job-id", "failed-complete", "malformed", "empty"]) {
      expect(encoded).not.toContain(privateValue)
    }
  })

  it("marks overlap not requested when the current graph has no Scouts", () => {
    const facts = buildTaskGraphPlanningFacts(loadedGraph(3, ["analyst"], [
      row("analyst", "analyst", "research", "completed", analystResult([{ jobId: "job-1", score: 8 }])),
    ]))!

    expect(facts.scoutOverlap).toEqual({ coverage: "not_requested", scouts: [] })
  })

  it("retains unavailable coverage for malformed role results", () => {
    const malformed = buildTaskGraphPlanningFacts(loadedGraph(7, ["unsafe"], [
      row("unsafe", "scout", "research", "completed", scoutResult(["job/with/slash"])),
    ]))

    expect(malformed?.counts.discoveredJobs).toEqual({ knownCount: null, coverage: "unavailable" })
  })

  it("counts only the exact source prefix of a marked Wave at its current whole-graph revision", () => {
    const facts = buildTaskGraphPlanningFacts(markedWaveLoaded())!
    expect(facts.graphRevision).toBe(23)
    expect(facts.counts).toEqual({
      discoveredJobs: { knownCount: 1, coverage: "complete" },
      analyzedJobs: { knownCount: 1, coverage: "complete" },
      prepareJobs: { knownCount: null, coverage: "not_requested" },
      artifactReferences: { knownCount: null, coverage: "unavailable" },
      reviewOutcomes: { knownCount: null, coverage: "unavailable" },
    })
    expect(facts.scoutOverlap).toEqual({ coverage: "complete", scouts: [
      { key: "scout", taskStatus: "completed", resultStatus: "completed", resultCoverage: "complete", reportedCount: 1, sharedCount: 0 },
    ] })
    expect(JSON.stringify(facts)).not.toMatch(/source-job|wave-writer|wave-reviewer|private-artifact-id|PRIVATE_TEXT/)
  })

  it("fails closed for a marked graph without ordinary owner-read provenance", () => {
    expect(() => buildTaskGraphPlanningFacts({ ...markedWaveLoaded(), discoveryTurnEligibility: "scheduled" }))
      .toThrow("task_graph_objective_tailor_current_invalid")
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
