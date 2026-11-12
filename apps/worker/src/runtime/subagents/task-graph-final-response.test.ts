import { describe, expect, it } from "vitest"
import { appendTaskGraphFollowUpSuggestions, buildGroundedTaskGraphFinalResponse } from "./task-graph-final-response.js"
import { ROLE_RESULT_SCHEMA, type ArtifactVersionReference } from "./role-results.js"
import { reduceTaskGraphFinalSummary, type TaskGraphFinalSummary, type TaskGraphFinalSummaryNode } from "./task-graph-final-summary.js"
import type { TaskGraphFinalSummaryBinding } from "./task-graph-final-summary-binding.js"

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
