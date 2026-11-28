import { describe, expect, it } from "vitest"
import { appendTaskGraphFollowUpSuggestions, buildGroundedTaskGraphFinalResponse } from "./task-graph-final-response.js"
import { ROLE_RESULT_SCHEMA, type ArtifactVersionReference } from "./role-results.js"
import { reduceTaskGraphFinalSummary, type TaskGraphFinalSummary, type TaskGraphFinalSummaryNode } from "./task-graph-final-summary.js"
import { readBoundObjectiveTailorFinalOutcome, readResolvedRepairTaskIds, type TaskGraphFinalSummaryBinding } from "./task-graph-final-summary-binding.js"
import type { SelectedJobBatchFinalOutcome } from "./selected-job-batch-final-outcome.js"
import { taskGraphItemId } from "./task-graph-snapshot.js"

const digest = (value: string) => `sha256:${value.repeat(64)}`
const artifactRef: ArtifactVersionReference = { artifactId: "private-cover-letter-1", version: 2, contentHash: digest("a"), sourceDigest: digest("b") }

function node(taskId: string, role: string, taskStatus: TaskGraphFinalSummaryNode["taskStatus"], structuredResult?: unknown): TaskGraphFinalSummaryNode {
  return { kind: "business", taskId, role, taskStatus, ...(role === "prepare" ? { attemptCount: 1 } : {}), ...(structuredResult === undefined ? {} : { structuredResult }) }
}

function binding(summary: TaskGraphFinalSummary): TaskGraphFinalSummaryBinding {
  return { graphRevision: summary.graphRevision, summary }
}

function currentBinding(summary: TaskGraphFinalSummary): TaskGraphFinalSummaryBinding {
  return { rootTaskId: "root-task-1", graphItemId: "graph-item-1", graphRevision: summary.graphRevision, summary,
    members: summary.taskOutcomes.map((outcome, nodeIndex) => ({ nodeIndex, nodeKey: `node-${nodeIndex}`, templateId: outcome.role,
      taskId: outcome.taskId, role: outcome.role, taskType: `${outcome.role}_task`, taskStatus: outcome.taskStatus, kind: "business" })) }
}

function batchBinding(): TaskGraphFinalSummaryBinding {
  const graphRevision = 12
  const rows: SelectedJobBatchFinalOutcome["slots"] = [
    { slotId: "slot-1", jobId: "private-job-a", writer: { nodeIndex: 0, nodeKey: "writer-a", templateId: "cover_letter_writer_slot_1", taskId: "writer-a-task", taskType: "cover_letter_draft" as const, role: "writer" as const, status: "completed" as const },
      reviewer: { nodeIndex: 1, nodeKey: "reviewer-a", templateId: "cover_letter_reviewer_slot_1", taskId: "reviewer-a-task", taskType: "cover_letter_review" as const, role: "reviewer" as const, status: "completed" as const }, status: "completed" as const,
      artifactRef: { artifactId: "private-artifact-a", version: 2, contentHash: digest("4"), sourceDigest: digest("5") }, reviewStatus: "passed" as const, reviewHash: digest("6") },
    { slotId: "slot-2", jobId: "private-job-b", writer: { nodeIndex: 2, nodeKey: "writer-b", templateId: "cover_letter_writer_slot_2", taskId: "writer-b-task", taskType: "cover_letter_draft" as const, role: "writer" as const, status: "completed" as const },
      reviewer: { nodeIndex: 3, nodeKey: "reviewer-b", templateId: "cover_letter_reviewer_slot_2", taskId: "reviewer-b-task", taskType: "cover_letter_review" as const, role: "reviewer" as const, status: "completed" as const }, status: "completed" as const,
      artifactRef: { artifactId: "private-artifact-b", version: 3, contentHash: digest("7"), sourceDigest: digest("8") }, reviewStatus: "rejected" as const, reviewHash: digest("9") },
  ]
  const selectedJobBatchFinalOutcome: SelectedJobBatchFinalOutcome = {
    schemaVersion: "agent-harness.v2.selected-job-batch-final-outcome.v1", graphRevision, slots: rows,
  }
  return {
    rootTaskId: "root-batch", graphItemId: "graph-batch", graphRevision,
    members: rows.flatMap(row => [row.writer, row.reviewer].map(member => ({ nodeIndex: member.nodeIndex, nodeKey: member.nodeKey,
      templateId: member.templateId, taskId: member.taskId, role: member.role, taskType: member.taskType,
      taskStatus: member.status, kind: "business" as const }))),
    selectedJobBatchFinalOutcome,
    summary: reduceTaskGraphFinalSummary({ graphRevision, nodes: [] }),
  }
}

function structuredSummary(): TaskGraphFinalSummary {
  return reduceTaskGraphFinalSummary({ graphRevision: 9, nodes: [
    node("private-scout-task", "scout", "completed", {
      schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "partial",
      candidates: [{ jobId: "private-job-1", source: "private-source", url: "https://private.invalid", evidenceIds: ["private-evidence-1"] }],
      evidence: [{ id: "private-evidence-1", kind: "job", ref: "private-job-1", source: "private-source" }], summary: "PRIVATE_MODEL_PROSE",
    }),
    node("private-analyst-task", "analyst", "failed"),
    node("private-prepare-partial", "prepare", "completed", {
      schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare", status: "partial", taskId: "private-prepare-partial", attemptCount: 1,
      snapshotDigest: digest("c"), checkpointDigest: "d".repeat(64),
      jobs: [{ jobId: "private-job-1", status: "prepared" }, { jobId: "private-job-2", status: "failed" }],
      materials: [{ jobId: "private-job-1", kind: "cover_letter", artifactRef }],
    }),
    node("private-prepare-complete", "prepare", "completed", {
      schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare", status: "completed", taskId: "private-prepare-complete", attemptCount: 1,
      snapshotDigest: digest("e"), checkpointDigest: "f".repeat(64), jobs: [{ jobId: "private-job-3", status: "skipped" }], materials: [],
    }),
    node("private-writer-task", "writer", "completed", { schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef }),
    node("private-review-passed", "reviewer", "completed", {
      schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer", status: "completed", artifactRef, reviewStatus: "passed", reviewHash: digest("1"),
    }),
    node("private-review-revision", "reviewer", "completed", {
      schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer", status: "completed", artifactRef, reviewStatus: "needs_revision", reviewHash: digest("2"),
    }),
  ] })
}

describe("grounded TaskGraph final response", () => {
  it("renders task-reported counts and limits without freeform task data", () => {
    const response = buildGroundedTaskGraphFinalResponse(binding(structuredSummary()))

    expect(response).toContain("Task-reported results:")
    expect(response).toContain("Search results: 1 unique job reported (partial coverage).")
    expect(response).toContain("Analysis results: unavailable (no valid structured result).")
    expect(response).toContain("Preparation outcomes: 3 job outcome records reported (partial coverage).")
    expect(response).toContain("Preparation statuses reported: prepared 1, skipped 1, failed 1.")
    expect(response).toContain("These records may repeat a job across tasks and do not count applications or submissions.")
    expect(response).toContain("Artifact references: 1 artifact reference reported (partial coverage).")
    expect(response).toContain("See structured task details for the available artifact version references.")
    expect(response).toContain("Reviewer outcomes: 2 review outcomes reported (complete coverage).")
    expect(response).toContain("Reviewer tasks reported passed 1, needs revision 1, rejected 0, stale 0.")
    expect(response).toContain("These are reviewer task reports, not independent verification.")
    expect(response).toContain("Analysis: 1 failed task; structured result missing.")
    expect(response).toContain("These are structured task reports, not independent verification.")
    expect(response).toContain("Prepared materials do not confirm that an application was submitted or received by an employer.")
    for (const privateValue of ["private-", "PRIVATE_MODEL_PROSE", "private.invalid", "private-source", "sha256:"]) {
      expect(response).not.toContain(privateValue)
    }
    expect(new TextEncoder().encode(response).byteLength).toBeLessThanOrEqual(4_096)
  })

  it("renders only exact private batch proof as bounded per-Job review outcomes", () => {
    const response = buildGroundedTaskGraphFinalResponse(batchBinding())
    expect(response).toContain("Per-Job preparation outcomes:")
    expect(response).toContain("Job 1: Writer completed; Reviewer completed; review passed.")
    expect(response).toContain("Job 2: Writer completed; Reviewer completed; review rejected.")
    for (const privateValue of ["private-job-", "private-artifact-", "sha256:", "reviewHash"]) expect(response).not.toContain(privateValue)
    expect(new TextEncoder().encode(response).byteLength).toBeLessThanOrEqual(4_096)

    const ordinary = buildGroundedTaskGraphFinalResponse(currentBinding(structuredSummary()))
    expect(ordinary).not.toContain("Per-Job preparation outcomes:")
  })

  it("renders only fixed Objective Tailor slot outcomes and preserves source repair evidence", () => {
    const summary = reduceTaskGraphFinalSummary({ graphRevision: 12, nodes: [
      node("source-scout", "scout", "completed"), node("source-analyst", "analyst", "failed", {
        schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed",
        findings: [{ jobId: "source-job", score: 8, evidenceIds: ["source-evidence"] }],
        evidence: [{ id: "source-evidence", kind: "job", ref: "source-job", source: "synthetic" }], summary: "PRIVATE_SOURCE_SUMMARY",
      }),
    ] })
    const base = currentBinding(summary)
    const projection = { schemaVersion: "agent-harness.v2.objective-tailor-final-outcome.v1" as const,
      graphRevision: 12, rootAttemptCount: 2, graphDigest: "a".repeat(64), sourceNodeCount: 2,
      sourceGraphDigest: "b".repeat(64), sourceStatusDigest: "c".repeat(64),
      slots: [{ ordinal: 1, status: "ready" as const, evidenceDigest: "d".repeat(64) },
        { ordinal: 2, status: "needs_revision" as const, evidenceDigest: "e".repeat(64) }] }
    const bound = { ...base, graphItemId: taskGraphItemId(base.rootTaskId!), resolvedRepairTaskIds: ["source-analyst"],
      objectiveTailorFinalOutcome: projection }
    expect(readBoundObjectiveTailorFinalOutcome(bound)).not.toBeNull()
    expect(readResolvedRepairTaskIds(bound)).toEqual(new Set(["source-analyst"]))
    const response = buildGroundedTaskGraphFinalResponse(bound)

    expect(response).toContain("Objective Tailor review: 1 ready (review passed and source current), 1 not ready (1 needs revision).")
    expect(response).toContain("Per-slot review: slot 1 ready, slot 2 needs revision.")
    expect(response).not.toContain("Inspect the reported Analysis task outcome.")
    expect(response).not.toMatch(/source-analyst|graphDigest|sha256:|Application submitted/)
    const invalid = { ...bound, objectiveTailorFinalOutcome: { ...projection, graphRevision: 13 } }
    expect(buildGroundedTaskGraphFinalResponse(invalid)).toContain("Task-reported results are unavailable.")
    expect(buildGroundedTaskGraphFinalResponse(invalid)).not.toContain("Objective Tailor review:")
  })

  it("labels only gate-bound repaired failures while preserving counts and legacy output", () => {
    const summary = structuredSummary(), current = currentBinding(summary)
    const baseline = buildGroundedTaskGraphFinalResponse(current)
    const resolved = buildGroundedTaskGraphFinalResponse({ ...current, resolvedRepairTaskIds: ["private-analyst-task"] })
    const legacy = binding(summary), legacyWithMetadata = { ...legacy, resolvedRepairTaskIds: ["private-analyst-task"] }
    const stale = { ...current, resolvedRepairTaskIds: ["private-analyst-task"], members: current.members?.map(member =>
      member.taskId === "private-analyst-task" ? { ...member, taskStatus: "completed" as const } : member) }
    const staleResponse = buildGroundedTaskGraphFinalResponse(stale)

    expect(resolved).toContain("Analysis: 1 failed task; structured result missing. Verified repair evidence covers the affected criteria.")
    expect(resolved).toContain("Search results: 1 unique job reported (partial coverage).")
    expect(resolved).toContain("Preparation outcomes: 3 job outcome records reported (partial coverage).")
    expect(resolved).not.toContain("private-analyst-task")
    expect(resolved).toContain("Inspect the reported Analysis task outcome.")
    expect(baseline).toContain("Analysis: 1 failed task; structured result missing.")
    expect(baseline).not.toContain("Verified repair evidence covers the affected criteria.")
    expect(buildGroundedTaskGraphFinalResponse(legacyWithMetadata)).toBe(buildGroundedTaskGraphFinalResponse(legacy))
    expect(staleResponse).not.toContain("Verified repair evidence covers the affected criteria.")
    expect(staleResponse).toContain("Analysis: 1 failed task; structured result missing.")

    const validFailure = reduceTaskGraphFinalSummary({ graphRevision: 10, nodes: [node("failed-analysis", "analyst", "failed", {
      schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed",
      findings: [{ jobId: "private-analysis-job", score: 7, evidenceIds: ["private-analysis-evidence"] }],
      evidence: [{ id: "private-analysis-evidence", kind: "job", ref: "private-analysis-job", source: "private-source" }], summary: "PRIVATE_MODEL_PROSE",
    })] })
    const currentFailure = currentBinding(validFailure)
    expect(buildGroundedTaskGraphFinalResponse(currentFailure)).toContain("Inspect the reported Analysis task outcome.")
    expect(buildGroundedTaskGraphFinalResponse({ ...currentFailure, resolvedRepairTaskIds: ["failed-analysis"] }))
      .not.toContain("Inspect the reported Analysis task outcome.")
  })

  it("keeps not-requested, observed zero, and unavailable distinct", () => {
    const empty = reduceTaskGraphFinalSummary({ graphRevision: 1, nodes: [] })
    const zero = reduceTaskGraphFinalSummary({ graphRevision: 1, nodes: [node("empty-scout", "scout", "completed", {
      schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed", candidates: [], evidence: [], summary: "",
    })] })
    const unavailable = reduceTaskGraphFinalSummary({ graphRevision: 1, nodes: [node("missing-scout", "scout", "failed")] })

    expect(buildGroundedTaskGraphFinalResponse(binding(empty))).toContain("Search results: not requested.")
    expect(buildGroundedTaskGraphFinalResponse(binding(zero))).toContain("Search results: 0 unique jobs reported (complete coverage).")
    expect(buildGroundedTaskGraphFinalResponse(binding(unavailable))).toContain("Search results: unavailable (no valid structured result).")
    expect(buildGroundedTaskGraphFinalResponse(binding(empty))).not.toContain("Search results: 0")
    expect(buildGroundedTaskGraphFinalResponse(binding(unavailable))).not.toContain("Search results: 0")
  })

  it("fails closed on a stale binding and bounds malformed summary arrays", () => {
    const summary = structuredSummary()
    const stale = { ...binding(summary), graphRevision: summary.graphRevision + 1 }
    const malformed = { ...summary, artifactReferences: Array.from({ length: 1_200 }, () => summary.artifactReferences[0]!) }
    const malformedResponse = buildGroundedTaskGraphFinalResponse(binding(malformed))

    expect(buildGroundedTaskGraphFinalResponse(stale)).toContain("Task-reported results are unavailable.")
    expect(malformedResponse).toContain("Artifact references: unavailable (summary details are inconsistent).")
    expect(new TextEncoder().encode(malformedResponse).byteLength).toBeLessThanOrEqual(4_096)
    expect(malformedResponse).not.toContain("private-cover-letter-1")
  })

  it("appends neutral, bounded next-step text without changing grounded facts", () => {
    const summary = reduceTaskGraphFinalSummary({ graphRevision: 9, nodes: [
      node("private-scout-task", "scout", "completed", {
        schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed", candidates: [{ jobId: "private-job-1", source: "private-source", url: "https://private.invalid", evidenceIds: ["private-evidence-1"] }],
        evidence: [{ id: "private-evidence-1", kind: "job", ref: "private-job-1", source: "private-source" }], summary: "PRIVATE_MODEL_PROSE",
      }),
      node("private-analyst-task", "analyst", "completed", {
        schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed", findings: [{ jobId: "private-job-1", score: 8, evidenceIds: ["private-evidence-2"] }],
        evidence: [{ id: "private-evidence-2", kind: "job", ref: "private-job-1", source: "private-source" }], summary: "PRIVATE_MODEL_PROSE",
      }),
      node("private-review-task", "reviewer", "completed", {
        schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer", status: "completed", artifactRef, reviewStatus: "needs_revision", reviewHash: digest("3"),
      }),
    ] })
    const factual = buildGroundedTaskGraphFinalResponse(binding(summary))
    const response = buildGroundedTaskGraphFinalResponse(currentBinding(summary))
    const limitation = "These are structured task reports, not independent verification. Prepared materials do not confirm that an application was submitted or received by an employer."

    expect(response).toContain("Suggested next steps (optional):")
    expect(response).toContain("Inspect the recorded material review marked needs revision.")
    expect(response).toContain("View the reported Analysis results.")
    expect(response).toContain("View the reported material results.")
    expect(response).not.toContain("private-")
    expect(response).not.toContain("PRIVATE_MODEL_PROSE")
    expect(response).not.toContain("private.invalid")
    expect(response).not.toContain("retry")
    expect(response).toContain("Task-reported results:")
    expect(response).toContain("These are structured task reports, not independent verification.")
    expect(response).toContain("Prepared materials do not confirm that an application was submitted or received by an employer.")
    expect(response.startsWith(factual.slice(0, -limitation.length - 1))).toBe(true)
    expect(response.endsWith(limitation)).toBe(true)
    expect(response.indexOf("Suggested next steps (optional):")).toBeLessThan(response.lastIndexOf("These are structured task reports, not independent verification."))
    expect(new TextEncoder().encode(response).byteLength).toBeLessThanOrEqual(4_096)

    const searchOnly = reduceTaskGraphFinalSummary({ graphRevision: 10, nodes: [node("private-search-task", "scout", "completed", {
      schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed", candidates: [{ jobId: "private-search-job", source: "private-source", url: null, evidenceIds: ["private-search-evidence"] }],
      evidence: [{ id: "private-search-evidence", kind: "job", ref: "private-search-job", source: "private-source" }], summary: "PRIVATE_MODEL_PROSE",
    })] })
    expect(buildGroundedTaskGraphFinalResponse(currentBinding(searchOnly))).toContain("View the reported Search results.")
  })

  it("appends only whole advice lines that fit and never displaces factual text", () => {
    const factual = "f".repeat(4_000)
    const result = appendTaskGraphFollowUpSuggestions(factual, [
      { kind: "inspect_task_result", taskId: "private-task", role: "scout", taskStatus: "failed", resultState: "missing" },
      { kind: "view_reported_results", taskId: "private-task", resultKind: "materials", jobIds: [], artifactRefs: [artifactRef] },
    ])

    expect(result.startsWith(factual)).toBe(true)
    expect(result).toContain("Inspect the reported Search task outcome.")
    expect(result).not.toContain("View the reported material results.")
    expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(4_096)
    expect(appendTaskGraphFollowUpSuggestions("x".repeat(4_096), [
      { kind: "inspect_task_result", taskId: "private-task", role: "scout", taskStatus: "failed", resultState: "missing" },
    ])).toBe("x".repeat(4_096))
  })

  it("renders parallel Scout advice once and retains distinct review and material actions", () => {
    const summary = reduceTaskGraphFinalSummary({ graphRevision: 11, nodes: [
      ...["a", "b", "c", "d"].map(suffix => node(`private-scout-${suffix}`, "scout", "completed", {
        schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "partial", candidates: [{ jobId: `private-job-${suffix}`, source: "private-source", url: null, evidenceIds: [`evidence-${suffix}`] }],
        evidence: [{ id: `evidence-${suffix}`, kind: "job", ref: `private-job-${suffix}`, source: "private-source" }], summary: "PRIVATE_MODEL_PROSE",
      })),
      node("private-reviewer", "reviewer", "completed", { schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer", status: "completed", artifactRef,
        reviewStatus: "needs_revision", reviewHash: digest("4") }),
    ] })
    const response = buildGroundedTaskGraphFinalResponse(currentBinding(summary))
    const header = "Suggested next steps (optional):"
    const limitation = "These are structured task reports, not independent verification. Prepared materials do not confirm that an application was submitted or received by an employer."
    const advice = response.slice(response.indexOf(header) + header.length, response.lastIndexOf(limitation)).trim().split("\n")

    expect(advice).toEqual([
      "Inspect the reported Search task outcome.",
      "Inspect the recorded material review marked needs revision.",
      "View the reported material results.",
    ])
    expect(new Set(advice).size).toBe(advice.length)
    expect(response).not.toContain("private-scout-")
    expect(response).not.toContain("PRIVATE_MODEL_PROSE")
    expect(response.endsWith(limitation)).toBe(true)
  })
})
