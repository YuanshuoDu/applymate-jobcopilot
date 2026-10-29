import { describe, expect, it } from "vitest"
import { formatTaskGraphFinalSummary } from "./task-graph-final-summary-format.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { reduceTaskGraphFinalSummary, type TaskGraphFinalSummary, type TaskGraphFinalSummaryNode } from "./task-graph-final-summary.js"

function summary(): TaskGraphFinalSummary {
  return {
    graphRevision: 17,
    counts: {
      discoveredJobs: { knownCount: 0, coverage: "complete" },
      analyzedJobs: { knownCount: 2, coverage: "partial" },
      prepareJobs: { knownCount: null, coverage: "not_requested" },
      artifactReferences: { knownCount: null, coverage: "unavailable" },
      reviewOutcomes: { knownCount: null, coverage: "not_requested" },
    },
    discoveredJobs: [{ jobId: "PRIVATE_JOB_ID", taskIds: ["PRIVATE_TASK_ID"] }],
    analyzedJobs: [],
    prepareResults: [],
    artifactReferences: [],
    reviewOutcomes: [],
    taskOutcomes: [{ taskId: "PRIVATE_TASK_ID", role: "scout", taskStatus: "completed", resultState: "valid", roleResultStatus: "completed" }],
  }
}

function withOutcomes(taskOutcomes: unknown): TaskGraphFinalSummary {
  return { ...summary(), taskOutcomes: taskOutcomes as TaskGraphFinalSummary["taskOutcomes"] }
}

type PrepareJobStatus = "prepared" | "skipped" | "failed"

function prepareNode(taskId: string, jobs?: readonly Readonly<{ jobId: string; status: PrepareJobStatus }>[], taskStatus: "completed" | "failed" = "completed"): TaskGraphFinalSummaryNode {
  const node = { kind: "business" as const, taskId, role: "prepare", taskStatus, attemptCount: 1 }
  if (!jobs) return node
  const status = jobs.some(job => job.status === "failed") ? "partial" : "completed"
  return {
    ...node,
    structuredResult: {
      schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare", status, taskId, attemptCount: 1,
      snapshotDigest: `sha256:${"a".repeat(64)}`, checkpointDigest: "b".repeat(64), jobs, materials: [],
    },
  }
}

const COUNT_SUMMARY = "Task-reported results: discovered jobs: 0 (complete); analyzed jobs: 2 observed (partial); Prepare outcome records: not requested; artifact references: unavailable; review outcomes: not requested."
const EMPTY_COUNT_SUMMARY = "Task-reported results: discovered jobs: not requested; analyzed jobs: not requested; Prepare outcome records: not requested; artifact references: not requested; review outcomes: not requested."

describe("TaskGraph final-summary formatter", () => {
  it("preserves count coverage and adds a bounded, non-verifying task history overview", () => {
    const formatted = formatTaskGraphFinalSummary(summary())
    expect(formatted).toBe(`${COUNT_SUMMARY} Recorded task outcomes (earlier attempts may be superseded; not verification): role=scout, task state=completed, result structure=valid, reported result status=completed: 1.`)
    expect(formatted.length).toBeLessThanOrEqual(1_000)
    expect(new TextEncoder().encode(formatted).byteLength).toBeLessThanOrEqual(1_000)
    expect(formatted).not.toContain("PRIVATE")
    expect(formatted).not.toContain("17")
    expect(formatted).not.toContain("verified")
    expect(formatted).not.toContain("authorized")
  })

  it("counts observed Prepare status records across tasks without claiming unique jobs", () => {
    const reduced = reduceTaskGraphFinalSummary({ graphRevision: 1, nodes: [
      prepareNode("prepare-a", [{ jobId: "job-shared", status: "prepared" }, { jobId: "job-failed", status: "failed" }]),
      prepareNode("prepare-b", [{ jobId: "job-shared", status: "skipped" }, { jobId: "job-prepared", status: "prepared" }]),
      prepareNode("prepare-missing", undefined, "failed"),
    ] })
    const formatted = formatTaskGraphFinalSummary(reduced)

    expect(reduced.counts.prepareJobs).toEqual({ knownCount: 4, coverage: "partial" })
    expect(formatted).toContain("Prepare outcome records: 4 observed (partial)")
    expect(formatted).toContain("Prepare-reported outcome records (observed per task; repeated jobs may count separately; submission not verified): prepared=2, skipped=1, failed=1.")
    for (const privateValue of ["job-shared", "job-failed", "job-prepared", "prepare-a", "prepare-b", "prepare-missing"]) {
      expect(formatted).not.toContain(privateValue)
    }
    expect(formatted.length).toBeLessThanOrEqual(1_000)
    expect(new TextEncoder().encode(formatted).byteLength).toBeLessThanOrEqual(1_000)
  })

  it("does not invent zero Prepare statuses when no result is available or requested", () => {
    const unavailable = reduceTaskGraphFinalSummary({ graphRevision: 1, nodes: [prepareNode("prepare-missing", undefined, "failed")] })
    const unavailableText = formatTaskGraphFinalSummary(unavailable)
    const notRequestedText = formatTaskGraphFinalSummary(reduceTaskGraphFinalSummary({ graphRevision: 0, nodes: [] }))

    expect(unavailableText).toContain("Prepare outcome records: unavailable")
    expect(unavailableText).not.toContain("Prepare-reported outcome records")
    expect(unavailableText).not.toContain("prepared=0")
    expect(notRequestedText).toContain("Prepare outcome records: not requested")
    expect(notRequestedText).not.toContain("Prepare-reported outcome records")
    expect(notRequestedText).not.toContain("prepared=0")
  })

  it("fails closed for malformed Prepare status rows and inconsistent observed totals", () => {
    const valid = reduceTaskGraphFinalSummary({ graphRevision: 1, nodes: [
      prepareNode("prepare-valid", [{ jobId: "job-1", status: "prepared" }]),
    ] })
    const malformed = {
      ...valid,
      prepareResults: [{ ...valid.prepareResults[0]!, jobs: [{ jobId: "PRIVATE_JOB", status: "unknown" }] }],
    } as unknown as TaskGraphFinalSummary
    const mismatched = {
      ...valid,
      counts: { ...valid.counts, prepareJobs: { knownCount: 2, coverage: "complete" as const } },
    }
    const partialResult = reduceTaskGraphFinalSummary({ graphRevision: 1, nodes: [prepareNode("prepare-partial", [
      { jobId: "job-prepared", status: "prepared" }, { jobId: "job-failed", status: "failed" },
    ])] })
    const falselyComplete = {
      ...partialResult,
      counts: { ...partialResult.counts, prepareJobs: { knownCount: 2, coverage: "complete" as const } },
    }
    const validPrepare = valid.prepareResults[0]!
    const trailingNewlineJobId = {
      ...valid,
      prepareResults: [{
        ...validPrepare,
        jobs: [{ ...validPrepare.jobs[0]!, jobId: "PRIVATE_JOB\n" }],
      }],
    }
    const trailingNewlineTaskId = {
      ...valid,
      prepareResults: [{ ...validPrepare, taskId: "PRIVATE_TASK\n" }],
    }

    const malformedText = formatTaskGraphFinalSummary(malformed)
    const mismatchedText = formatTaskGraphFinalSummary(mismatched)
    const falselyCompleteText = formatTaskGraphFinalSummary(falselyComplete)
    const trailingNewlineJobIdText = formatTaskGraphFinalSummary(trailingNewlineJobId)
    const trailingNewlineTaskIdText = formatTaskGraphFinalSummary(trailingNewlineTaskId)
    for (const text of [malformedText, mismatchedText, falselyCompleteText, trailingNewlineJobIdText, trailingNewlineTaskIdText]) {
      expect(text).toContain("Prepare status breakdown unavailable")
      expect(text).not.toContain("prepared=0")
      expect(text).not.toContain("PRIVATE_JOB")
      expect(text).not.toContain("PRIVATE_TASK")
    }
  })

  it("groups repeated tuples deterministically and separates task state from result state", () => {
    const outcomes = [
      { taskId: "failure", role: "analyst", taskStatus: "failed", resultState: "valid", roleResultStatus: "completed" },
      { taskId: "scout-partial-1", role: "scout", taskStatus: "completed", resultState: "valid", roleResultStatus: "partial" },
      { taskId: "scout-partial-2", role: "scout", taskStatus: "completed", resultState: "valid", roleResultStatus: "partial" },
      { taskId: "missing", role: "writer", taskStatus: "completed", resultState: "missing" },
      { taskId: "invalid", role: "reviewer", taskStatus: "completed", resultState: "invalid" },
      { taskId: "unknown-role", role: "unsupported", taskStatus: "waiting", resultState: "unsupported_role" },
      { taskId: "non-terminal", role: "scout", taskStatus: "running", resultState: "not_terminal" },
    ]
    const first = formatTaskGraphFinalSummary(withOutcomes(outcomes))
    const second = formatTaskGraphFinalSummary(withOutcomes([...outcomes].reverse()))
    expect(first).toBe(second)
    expect(first).toContain("Recorded task outcomes (earlier attempts may be superseded; not verification):")
    expect(first).toContain("role=analyst, task state=failed, result structure=valid, reported result status=completed: 1")
    expect(first).toContain("role=reviewer, task state=completed, result structure=invalid, reported result status=not reported: 1")
    expect(first).toContain("role=scout, task state=running, result structure=not_terminal, reported result status=not reported: 1")
    expect(first).toContain("role=scout, task state=completed, result structure=valid, reported result status=partial: 2")
    expect(first).toContain("role=writer, task state=completed, result structure=missing, reported result status=not reported: 1")
    expect(first).toContain("role=unsupported, task state=waiting, result structure=unsupported_role, reported result status=not reported: 1")
  })

  it("omits identifiers, private prose, raw result fields and provenance", () => {
    const privateOutcome = {
      taskId: "PRIVATE_TASK_ID",
      role: "scout",
      taskStatus: "failed",
      resultState: "valid",
      roleResultStatus: "partial",
      jobId: "PRIVATE_JOB_ID",
      result: "PRIVATE_RAW_RESULT",
      reason: "PRIVATE_FAILURE_REASON",
      evidence: "PRIVATE_EVIDENCE",
      url: "https://private.example/apply",
      modelText: "PRIVATE_MODEL_TEXT",
    }
    const formatted = formatTaskGraphFinalSummary(withOutcomes([privateOutcome]))
    for (const privateValue of ["PRIVATE_TASK_ID", "PRIVATE_JOB_ID", "PRIVATE_RAW_RESULT", "PRIVATE_FAILURE_REASON", "PRIVATE_EVIDENCE", "private.example", "PRIVATE_MODEL_TEXT"]) {
      expect(formatted).not.toContain(privateValue)
    }
    expect(formatted).toContain("role=scout, task state=failed, result structure=valid, reported result status=partial: 1")
  })

  it("does not turn empty or malformed outcomes into completed work", () => {
    const emptyGraph = reduceTaskGraphFinalSummary({ graphRevision: 0, nodes: [] })
    const empty = formatTaskGraphFinalSummary(emptyGraph)
    expect(empty).toBe(`${EMPTY_COUNT_SUMMARY} No business task outcomes recorded.`)
    expect(empty).not.toContain("task state=")

    const inconsistent = formatTaskGraphFinalSummary(withOutcomes([]))
    expect(inconsistent).toBe(`${COUNT_SUMMARY} Task outcome overview unavailable (inconsistent summary).`)
    expect(inconsistent).not.toContain("No business task outcomes recorded")
    expect(inconsistent).not.toContain("task state=")

    const malformed = formatTaskGraphFinalSummary(withOutcomes([
      { taskId: "PRIVATE", role: "scout", taskStatus: "private status", resultState: "valid", roleResultStatus: "completed" },
      { taskId: "PRIVATE", role: "unknown-role", taskStatus: "completed", resultState: "valid", roleResultStatus: "completed" },
      null,
    ]))
    expect(malformed).toBe(`${COUNT_SUMMARY} Task outcome overview unavailable (invalid entries omitted).`)
    expect(malformed).not.toContain("task state=completed")
    expect(malformed).not.toContain("reported result status=completed")
    expect(malformed).not.toContain("PRIVATE")
  })

  it("fails closed for malformed counts without rendering untrusted fields", () => {
    const malformed = {
      ...summary(),
      counts: {
        ...summary().counts,
        discoveredJobs: { knownCount: "PRIVATE_COUNT", coverage: "private coverage" },
      },
    } as unknown as TaskGraphFinalSummary
    const formatted = formatTaskGraphFinalSummary(malformed)
    expect(formatted).toContain("discovered jobs: unavailable")
    expect(formatted).not.toContain("PRIVATE")
    expect(formatted.length).toBeLessThanOrEqual(1_000)
  })

  it("keeps groups whole and stays within both bounds when many groups do not fit", () => {
    const outcomes: TaskGraphFinalSummary["taskOutcomes"][number][] = []
    for (const role of ["analyst", "prepare", "reviewer", "scout", "writer"] as const) {
      for (const taskStatus of ["completed", "failed", "interrupted"] as const) {
        for (const resultState of ["valid", "missing", "invalid"] as const) {
          outcomes.push({
            taskId: `task-${role}-${taskStatus}-${resultState}`,
            role,
            taskStatus,
            resultState,
            ...resultState === "valid" ? { roleResultStatus: taskStatus === "failed" ? "partial" : "completed" } : {},
          })
        }
      }
    }
    const prepared = reduceTaskGraphFinalSummary({ graphRevision: 1, nodes: [prepareNode("prepare-bounded", [
      { jobId: "job-prepared", status: "prepared" }, { jobId: "job-skipped", status: "skipped" }, { jobId: "job-failed", status: "failed" },
    ])] })
    const formatted = formatTaskGraphFinalSummary({
      ...prepared,
      taskOutcomes: outcomes,
    })
    expect(formatted.length).toBeLessThanOrEqual(1_000)
    expect(new TextEncoder().encode(formatted).byteLength).toBeLessThanOrEqual(1_000)
    expect(formatted).toContain("Prepare-reported outcome records (observed per task; repeated jobs may count separately; submission not verified): prepared=1, skipped=1, failed=1.")
    expect(formatted).toMatch(/; \d+ outcome groups? omitted\.$/)
    const overview = formatted.slice(formatted.indexOf("role="))
    const renderedGroups = overview.replace(/; \d+ outcome groups? omitted\.$/, "").replace(/\.$/, "").split("; ")
    for (const group of renderedGroups) {
      expect(group).toMatch(/^role=(analyst|prepare|reviewer|scout|writer), task state=(completed|failed|interrupted), result structure=(valid|missing|invalid), reported result status=(completed|partial|not reported): \d+$/)
    }
  })
})
