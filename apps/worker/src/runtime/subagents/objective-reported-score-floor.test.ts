import { describe, expect, it } from "vitest"
import type { TaskGraphCurrentState } from "./task-graph-command-port.js"
import type { TaskGraphFinalSummary } from "./task-graph-final-summary.js"
import type { StoredTaskGraphNode } from "./task-graph-snapshot.js"
import {
  deriveObjectiveReportedScoreFloor,
  parseObjectiveTailorFinalOutcome,
  OBJECTIVE_TAILOR_FINAL_OUTCOME_SCHEMA,
} from "./objective-reported-score-floor.js"

const revision = 9
type Floor = Readonly<{ minimumScore: number; minimumFindings: number; aggregation: "any" | "all" }>
function fixture(input: Readonly<{
  floors?: readonly (Floor | null)[]; reportsPassed?: boolean; coverage?: "complete" | "partial" | "unavailable"
  jobs?: readonly Readonly<{ jobId: string; findings: readonly Readonly<{ taskId: string; score: number }>[] }>[]
}> = {}) {
  const floor = (value: Floor | null) => value ? { kind: "reported_score_gte", ...value } : { kind: "finding_count_gte", minimum: 1 }
  const floors = input.floors ?? [{ minimumScore: 7, minimumFindings: 1, aggregation: "any" }, { minimumScore: 7, minimumFindings: 1, aggregation: "any" }]
  const analysts = floors.map((value, index) => ({ key: `analyst-${index + 1}`, taskId: `task-${index + 1}`, templateId: "analyst",
    verificationDisposition: "typed", verification: { schemaVersion: "agent-harness.v2.task-graph-verification.v1", role: "analyst",
      criteria: [{ id: "score-floor", check: floor(value) }] } }))
  const sourceNodes = [{ key: "scout-1", taskId: "scout-1", templateId: "scout" }, ...analysts] as unknown as StoredTaskGraphNode[]
  const currentGraph = { revision, nodes: [{ key: "scout-1", taskId: "scout-1", templateId: "scout" }, ...analysts.map(node => ({ ...node,
    status: "completed", verificationReport: { status: input.reportsPassed === false ? "failed" : "passed",
      criteria: [{ criterionId: "score-floor", status: input.reportsPassed === false ? "failed" : "passed" }] } }))] } as unknown as TaskGraphCurrentState
  const jobs = input.jobs ?? [{ jobId: "job-a", findings: [{ taskId: "task-1", score: 8 }, { taskId: "task-2", score: 9 }] }]
  const summary = { graphRevision: revision,
    counts: { analyzedJobs: { knownCount: jobs.length, coverage: input.coverage ?? "complete" } },
    analyzedJobs: jobs,
    taskOutcomes: analysts.map(node => ({ taskId: node.taskId, role: "analyst", taskStatus: "completed", resultState: "valid", roleResultStatus: "completed" }))
  } as unknown as TaskGraphFinalSummary
  return { sourceNodes, currentGraph, summary, effectiveAnalystTaskIds: analysts.map(node => node.taskId) }
}

describe("deriveObjectiveReportedScoreFloor", () => {
  it("counts overlapping Jobs once when all Analyst reports are on the same side", () => {
    const input = fixture({ jobs: [
      { jobId: "job-a", findings: [{ taskId: "task-1", score: 8 }, { taskId: "task-2", score: 9 }] },
      { jobId: "job-b", findings: [{ taskId: "task-1", score: 7 }] },
      { jobId: "job-c", findings: [{ taskId: "task-2", score: 6.9 }] },
    ] })
    expect(deriveObjectiveReportedScoreFloor(input)).toEqual({ status: "complete", minimumScore: 7,
      minimumFindings: 1, aggregation: "any", qualifyingJobCount: 2 })
  })

  it("uses the inclusive floor and rejects a stale passed report", () => {
    expect(deriveObjectiveReportedScoreFloor(fixture({ jobs: [{ jobId: "job-a", findings: [
      { taskId: "task-1", score: 7 }, { taskId: "task-2", score: 7 },
    ] }] }))).toMatchObject({ status: "complete", qualifyingJobCount: 1 })
    expect(deriveObjectiveReportedScoreFloor(fixture({ jobs: [{ jobId: "job-a", findings: [
      { taskId: "task-1", score: 6 }, { taskId: "task-2", score: 6.9 },
    ] }] }))).toEqual({ status: "unavailable" })
  })

  it("rechecks each Analyst minimum finding count and any/all aggregation", () => {
    const anyFloor = { minimumScore: 7, minimumFindings: 2, aggregation: "any" as const }
    const allFloor = { minimumScore: 7, minimumFindings: 2, aggregation: "all" as const }
    const any = fixture({ floors: [anyFloor, anyFloor], jobs: [
      { jobId: "job-a", findings: [{ taskId: "task-1", score: 8 }, { taskId: "task-2", score: 9 }] },
      { jobId: "job-b", findings: [{ taskId: "task-1", score: 6 }, { taskId: "task-2", score: 6.9 }] },
    ] })
    expect(deriveObjectiveReportedScoreFloor(any)).toMatchObject({ status: "complete", qualifyingJobCount: 1 })

    const all = fixture({ floors: [allFloor, allFloor], jobs: [
      { jobId: "job-a", findings: [{ taskId: "task-1", score: 8 }, { taskId: "task-2", score: 9 }] },
      { jobId: "job-b", findings: [{ taskId: "task-1", score: 7 }, { taskId: "task-2", score: 7 }] },
    ] })
    expect(deriveObjectiveReportedScoreFloor(all)).toMatchObject({ status: "complete", qualifyingJobCount: 2 })
    const tooFew = fixture({ floors: [anyFloor, anyFloor] })
    expect(deriveObjectiveReportedScoreFloor(tooFew)).toEqual({ status: "unavailable" })
  })

  it("withholds the count when overlapping reports straddle the floor", () => {
    expect(deriveObjectiveReportedScoreFloor(fixture({ jobs: [{ jobId: "job-a", findings: [
      { taskId: "task-1", score: 8 }, { taskId: "task-2", score: 6 },
    ] }] }))).toEqual({ status: "unavailable" })
  })

  it("withholds the count for different or missing Analyst floors", () => {
    expect(deriveObjectiveReportedScoreFloor(fixture({ floors: [
      { minimumScore: 7, minimumFindings: 1, aggregation: "any" },
      { minimumScore: 8, minimumFindings: 1, aggregation: "any" },
    ] }))).toEqual({ status: "unavailable" })
    expect(deriveObjectiveReportedScoreFloor(fixture({ floors: [
      { minimumScore: 7, minimumFindings: 1, aggregation: "any" }, null,
    ] }))).toEqual({ status: "unavailable" })
  })

  it("reports not_requested when no effective Analyst asks for a score floor", () => {
    const input = fixture({ floors: [null, null] })
    expect(deriveObjectiveReportedScoreFloor({ ...input, currentGraph: undefined })).toEqual({ status: "not_requested" })
  })

  it("withholds the count for partial, failed, or out-of-contract Analyst evidence", () => {
    expect(deriveObjectiveReportedScoreFloor(fixture({ coverage: "partial" }))).toEqual({ status: "unavailable" })
    expect(deriveObjectiveReportedScoreFloor(fixture({ reportsPassed: false }))).toEqual({ status: "unavailable" })
    expect(deriveObjectiveReportedScoreFloor(fixture({ jobs: [{ jobId: "job-a", findings: [
      { taskId: "task-1", score: 11 }, { taskId: "task-2", score: 9 },
    ] }] }))).toEqual({ status: "unavailable" })
  })

  it("withholds the count when the current graph no longer has the exact source prefix", () => {
    const input = fixture()
    const nodes = [...input.currentGraph.nodes]
    nodes[0] = { ...nodes[0]!, taskId: "different-scout-task" }
    expect(deriveObjectiveReportedScoreFloor({ ...input, currentGraph: { ...input.currentGraph, nodes } }))
      .toEqual({ status: "unavailable" })
  })
})

describe("parseObjectiveTailorFinalOutcome", () => {
  const legacy = {
    schemaVersion: OBJECTIVE_TAILOR_FINAL_OUTCOME_SCHEMA,
    graphRevision: 3,
    rootAttemptCount: 1,
    graphDigest: "a".repeat(64),
    sourceNodeCount: 2,
    sourceGraphDigest: "b".repeat(64),
    sourceStatusDigest: "c".repeat(64),
    slots: [{ ordinal: 1, status: "ready", evidenceDigest: "d".repeat(64) }],
  }

  it("normalizes only the exact historical shape without a score floor", () => {
    expect(parseObjectiveTailorFinalOutcome(legacy)?.reportedScoreFloor).toEqual({ status: "unavailable" })
    expect(parseObjectiveTailorFinalOutcome({ ...legacy, extra: true })).toBeNull()
  })

  it("rejects a present malformed score floor instead of treating it as historical", () => {
    expect(parseObjectiveTailorFinalOutcome({ ...legacy, reportedScoreFloor: { status: "complete" } })).toBeNull()
  })
})
