import { describe, expect, it } from "vitest"
import { reduceTaskGraphFinalSummary } from "./task-graph-final-summary.js"
import type { TaskGraphFinalSummaryBinding, TaskGraphFinalSummaryMember } from "./task-graph-final-summary-binding.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { reduceTaskGraphFollowUpSuggestions } from "./task-graph-follow-up-suggestions.js"
import type { SubagentTaskStatus } from "./types.js"

const hash = (value: string) => `sha256:${value.repeat(64)}`
const artifact = (artifactId: string, content = "a") => ({ artifactId, version: 1, contentHash: hash(content), sourceDigest: hash("b") })
type Entry = { taskId: string; role: string; taskStatus: SubagentTaskStatus; taskType?: string; structuredResult?: unknown }

function binding(entries: readonly Entry[], graphRevision = 7): TaskGraphFinalSummaryBinding {
  const nodes = entries.map(entry => ({ kind: "business" as const, taskId: entry.taskId, role: entry.role, taskStatus: entry.taskStatus,
    ...(entry.role === "prepare" ? { attemptCount: 1 } : {}), ...(entry.structuredResult === undefined ? {} : { structuredResult: entry.structuredResult }) }))
  const summary = reduceTaskGraphFinalSummary({ graphRevision, nodes })
  const members: TaskGraphFinalSummaryMember[] = entries.map((entry, nodeIndex) => ({ nodeIndex, nodeKey: `node-${nodeIndex}`, templateId: entry.role,
    taskId: entry.taskId, role: entry.role, taskType: entry.taskType ?? `${entry.role}_task`, taskStatus: entry.taskStatus, kind: "business" }))
  return { rootTaskId: "root-task-1", graphItemId: "graph-item-1", graphRevision, members, summary }
}

function scout(jobId: string, status: "completed" | "partial" = "completed") {
  return { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status, candidates: [{ jobId, source: "private-source", url: "https://private.invalid", evidenceIds: ["evidence-1"] }],
    evidence: [{ id: "evidence-1", kind: "job", ref: jobId, source: "private-source" }], summary: "PRIVATE_MODEL_PROSE" }
}
function analyst(jobId: string) {
  return { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed", findings: [{ jobId, score: 8, evidenceIds: ["evidence-1"] }],
    evidence: [{ id: "evidence-1", kind: "job", ref: jobId, source: "private-source" }], summary: "PRIVATE_MODEL_PROSE" }
}
function writer(ref: ReturnType<typeof artifact>) { return { schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef: ref } }
function reviewer(ref: ReturnType<typeof artifact>, reviewStatus: "passed" | "needs_revision" | "rejected" | "stale") {
  return { schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer", status: "completed", artifactRef: ref, reviewStatus, reviewHash: hash("c") }
}
function prepare(taskId: string, status: "completed" | "partial", jobs: readonly { jobId: string; status: "prepared" | "skipped" | "failed" }[], materials: readonly { jobId: string; kind: "resume" | "cover_letter"; artifactRef: ReturnType<typeof artifact> }[]) {
  return { schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare", status, taskId, attemptCount: 1, snapshotDigest: hash("d"), checkpointDigest: "e".repeat(64), jobs, materials }
}

describe("TaskGraph follow-up suggestion reducer", () => {
  it("emits stable optional inspection suggestions for incomplete, missing, and partial reports", () => {
    const current = binding([
      { taskId: "task-z", role: "scout", taskStatus: "completed", structuredResult: scout("job-z", "partial") },
      { taskId: "task-a", role: "analyst", taskStatus: "failed" },
      { taskId: "task-m", role: "reviewer", taskStatus: "waiting" },
    ])

    const suggestions = reduceTaskGraphFollowUpSuggestions(current)
    expect(suggestions).toEqual([
      { kind: "inspect_task_result", taskId: "task-a", role: "analyst", taskStatus: "failed", resultState: "missing" },
      { kind: "inspect_task_result", taskId: "task-m", role: "reviewer", taskStatus: "waiting", resultState: "not_terminal" },
      { kind: "inspect_task_result", taskId: "task-z", role: "scout", taskStatus: "completed", resultState: "valid" },
    ])
    expect(reduceTaskGraphFollowUpSuggestions(current)).toEqual(suggestions)
    expect(suggestions).toHaveLength(3)
  })

  it.each(["needs_revision", "rejected", "stale"] as const)("references the exact current artifact for a %s review", reviewStatus => {
    const ref = artifact(`private-artifact-${reviewStatus}`)
    const suggestions = reduceTaskGraphFollowUpSuggestions(binding([
      { taskId: "writer-1", role: "writer", taskStatus: "completed", structuredResult: writer(ref) },
      { taskId: "reviewer-1", role: "reviewer", taskStatus: "completed", structuredResult: reviewer(ref, reviewStatus) },
    ]))
    expect(suggestions).toContainEqual({ kind: "inspect_material_review", taskIds: ["reviewer-1"], artifactRef: ref, reviewStatus })
  })

  it("omits an ambiguous review suggestion but keeps safe artifact-view advice", () => {
    const ref = artifact("private-conflicted-artifact")
    const suggestions = reduceTaskGraphFollowUpSuggestions(binding([
      { taskId: "writer-1", role: "writer", taskStatus: "completed", structuredResult: writer(ref) },
      { taskId: "reviewer-a", role: "reviewer", taskStatus: "completed", structuredResult: reviewer(ref, "passed") },
      { taskId: "reviewer-b", role: "reviewer", taskStatus: "completed", structuredResult: reviewer(ref, "needs_revision") },
    ]))
    expect(suggestions.some(item => item.kind === "inspect_material_review")).toBe(false)
    expect(suggestions).toContainEqual({ kind: "view_reported_results", taskId: "reviewer-a", resultKind: "materials", jobIds: [], artifactRefs: [ref] })
  })

  it("links reported search, analysis, and material results only to their producing task", () => {
    const material = artifact("private-material")
    const suggestions = reduceTaskGraphFollowUpSuggestions(binding([
      { taskId: "scout-1", role: "scout", taskStatus: "completed", structuredResult: scout("job-1") },
      { taskId: "analyst-1", role: "analyst", taskStatus: "completed", structuredResult: analyst("job-1") },
      { taskId: "writer-1", role: "writer", taskStatus: "completed", structuredResult: writer(material) },
    ]))
    expect(suggestions).toContainEqual({ kind: "view_reported_results", taskId: "analyst-1", resultKind: "analysis", jobIds: ["job-1"], artifactRefs: [] })
    expect(suggestions).toContainEqual({ kind: "view_reported_results", taskId: "scout-1", resultKind: "search", jobIds: ["job-1"], artifactRefs: [] })
    expect(suggestions).toContainEqual({ kind: "view_reported_results", taskId: "writer-1", resultKind: "materials", jobIds: [], artifactRefs: [material] })
  })

  it("accepts reducer-produced completed and partial Prepare material rows at the nested job level", () => {
    const completedRef = artifact("private-prepared-resume")
    const partialRef = artifact("private-partial-cover-letter", "c")
    const completed = binding([{ taskId: "prepare-completed", role: "prepare", taskStatus: "completed", structuredResult: prepare("prepare-completed", "completed",
      [{ jobId: "job-ready", status: "prepared" }], [{ jobId: "job-ready", kind: "resume", artifactRef: completedRef }]) }])
    const partial = binding([{ taskId: "prepare-partial", role: "prepare", taskStatus: "completed", structuredResult: prepare("prepare-partial", "partial",
      [{ jobId: "job-ready", status: "prepared" }, { jobId: "job-failed", status: "failed" }], [{ jobId: "job-ready", kind: "cover_letter", artifactRef: partialRef }]) }])

    expect(completed.summary.prepareResults[0]?.jobs[0]?.materials).toEqual([{ kind: "resume", artifactRef: completedRef }])
    expect(completed.summary.prepareResults[0]).not.toHaveProperty("materials")
    expect(reduceTaskGraphFollowUpSuggestions(completed)).toContainEqual({ kind: "view_reported_results", taskId: "prepare-completed", resultKind: "preparation", jobIds: ["job-ready"], artifactRefs: [completedRef] })
    expect(reduceTaskGraphFollowUpSuggestions(partial)).toEqual(expect.arrayContaining([
      { kind: "inspect_task_result", taskId: "prepare-partial", role: "prepare", taskStatus: "completed", resultState: "valid" },
      { kind: "view_reported_results", taskId: "prepare-partial", resultKind: "preparation", jobIds: ["job-failed", "job-ready"], artifactRefs: [partialRef] },
    ]))
  })

  it("deduplicates parallel same-role advice before the three-action limit", () => {
    const ref = artifact("private-reviewable-material")
    const current = binding([
      ...["a", "b", "c", "d"].map(suffix => ({ taskId: `scout-${suffix}`, role: "scout", taskStatus: "completed" as const, structuredResult: scout(`job-${suffix}`, "partial") })),
      { taskId: "reviewer-1", role: "reviewer", taskStatus: "completed", structuredResult: reviewer(ref, "needs_revision") },
    ])
    const suggestions = reduceTaskGraphFollowUpSuggestions(current)
    expect(suggestions).toHaveLength(3)
    expect(suggestions.filter(item => item.kind === "inspect_task_result")).toHaveLength(1)
    expect(suggestions.filter(item => item.kind === "inspect_material_review")).toHaveLength(1)
    expect(suggestions.some(item => item.kind === "view_reported_results" && item.resultKind === "materials")).toBe(true)
  })

  it("does not infer action from zero or not-requested counts", () => {
    const notRequested = binding([])
    const zero = binding([{ taskId: "scout-zero", role: "scout", taskStatus: "completed", structuredResult: {
      schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed", candidates: [], evidence: [], summary: "" } }])
    expect(reduceTaskGraphFollowUpSuggestions(notRequested)).toEqual([])
    expect(reduceTaskGraphFollowUpSuggestions(zero)).toEqual([])
  })

  it("fails closed for legacy, mismatched, or conflicting-reference bindings", () => {
    const current = binding([{ taskId: "writer-1", role: "writer", taskStatus: "completed", structuredResult: writer(artifact("same-artifact")) }])
    const legacy = { graphRevision: current.graphRevision, summary: current.summary }
    const stale = { ...current, graphRevision: current.graphRevision + 1 }
    const wrongMember = { ...current, members: current.members?.map(member => ({ ...member, taskId: "other-task" })) }
    const conflict = binding([
      { taskId: "writer-a", role: "writer", taskStatus: "completed", structuredResult: writer(artifact("same-version", "a")) },
      { taskId: "writer-b", role: "writer", taskStatus: "completed", structuredResult: writer(artifact("same-version", "c")) },
    ])
    expect(reduceTaskGraphFollowUpSuggestions(legacy)).toEqual([])
    expect(reduceTaskGraphFollowUpSuggestions(stale)).toEqual([])
    expect(reduceTaskGraphFollowUpSuggestions(wrongMember)).toEqual([])
    expect(reduceTaskGraphFollowUpSuggestions(conflict)).toEqual([])
  })
})
