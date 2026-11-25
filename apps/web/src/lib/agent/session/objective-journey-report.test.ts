import { beforeEach, describe, expect, it, vi } from "vitest"
import { OBJECTIVE_JOURNEY_REPORT_SCHEMA_V2 } from "./objective-journey-report-contract"
import { readObjectiveJourneyReport } from "./objective-journey-report"

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(), source: vi.fn(), approvals: vi.fn(), application: vi.fn(),
}))
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }))
vi.mock("./objective-journey-report-source", () => ({ readObjectiveJourneySource: mocks.source }))
vi.mock("./objective-journey-report-approvals", () => ({ readObjectiveJourneyReportApprovals: mocks.approvals }))
vi.mock("./objective-journey-report-application", () => ({ readObjectiveJourneyReportApplication: mocks.application }))

const binding = { userId: "user-1", sessionId: "session-1", sourceTurnId: "source-turn", slotOrdinal: 1, jobId: "job-1",
  reviewTurnId: "review-turn", setId: "set-1", approvalId: "approval-1", applicationTaskId: "task-1", materialProofHash: "a".repeat(64) }
const source = { userId: "user-1", sessionId: "session-1", sourceTurnId: "source-turn", rootTaskId: "root-1",
  finalItemId: "final-1", graphRevision: 12, sourceCounts: {
    discoveredJobs: { knownCount: 8, coverage: "complete" }, analyzedJobs: { knownCount: 6, coverage: "partial" },
  }, slots: [
    { ordinal: 1, tailoringStatus: "ready", sourceReady: true, jobId: "job-1", job: { company: "Acme", role: "Engineer" },
      writerTaskId: "writer-1", reviewerTaskId: "reviewer-1" },
    { ordinal: 2, tailoringStatus: "stale", sourceReady: false, jobId: null, job: null, writerTaskId: null, reviewerTaskId: null },
  ] } as const

describe("readObjectiveJourneyReport", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.transaction.mockImplementation(async (callback, options) => {
      expect(options).toEqual({ isolationLevel: "RepeatableRead" })
      return callback({} as never)
    })
    mocks.source.mockResolvedValue(source)
    mocks.approvals.mockResolvedValue([
      { slotOrdinal: 1, reviewStatus: "approved", reviewTurnId: "review-turn", retirementReason: null, approvedBinding: binding },
      { slotOrdinal: 2, reviewStatus: "unknown", reviewTurnId: null, retirementReason: null },
    ])
    mocks.application.mockImplementation(async (_tx, selected) => selected
      ? { applicationStatus: "submitted", submissionEvidence: { fillTurnId: "fill-1", finalItemId: "submit-final" } }
      : { applicationStatus: "not_started", submissionEvidence: null })
  })

  it("composes slot facts from the same repeatable snapshot and exposes only confirmed evidence", async () => {
    const report = await readObjectiveJourneyReport({ userId: "user-1", sessionId: "session-1", finalItemId: "final-1" })
    expect(report?.schemaVersion).not.toBe(OBJECTIVE_JOURNEY_REPORT_SCHEMA_V2)
    expect(report).toMatchObject({ graphRevision: 12, reviewCoverage: "partial", slots: [
      { ordinal: 1, reviewStatus: "approved", applicationStatus: "submitted", submissionEvidence: { fillTurnId: "fill-1", finalItemId: "submit-final" } },
      { ordinal: 2, tailoringStatus: "stale", reviewStatus: "unknown", applicationStatus: "unknown", job: null },
    ] })
    expect(mocks.application.mock.calls.map(call => call[1])).toEqual([binding])
  })

  it("carries a verified V3 complete floor into report V2, including numeric zero", async () => {
    mocks.source.mockResolvedValue({ ...source, sourceCounts: { ...source.sourceCounts,
      analyzedJobs: { knownCount: 6, coverage: "complete" } },
      reportedScoreFloor: { status: "complete", minimumScore: 0, qualifyingJobCount: 0 } })
    const report = await readObjectiveJourneyReport({ userId: "user-1", sessionId: "session-1", finalItemId: "final-1" })
    expect(report).toMatchObject({ schemaVersion: OBJECTIVE_JOURNEY_REPORT_SCHEMA_V2,
      reportedScoreFloor: { status: "complete", minimumScore: 0, qualifyingJobCount: 0 } })
  })

  it("fails closed on sparse, reordered, or duplicated slot projections", async () => {
    mocks.approvals.mockResolvedValue([{ slotOrdinal: 2, reviewStatus: "unknown", reviewTurnId: null, retirementReason: null },
      { slotOrdinal: 1, reviewStatus: "not_requested", reviewTurnId: null, retirementReason: null }])
    expect(await readObjectiveJourneyReport({ userId: "user-1", sessionId: "session-1", finalItemId: "final-1" })).toBeUndefined()
  })

  it("does not call unavailable or unbound ready slots not started", async () => {
    mocks.source.mockResolvedValue({ ...source, slots: [
      source.slots[0]!, { ...source.slots[1]!, tailoringStatus: "ready", job: { company: "Example", role: "Engineer" } },
    ] })
    mocks.approvals.mockResolvedValue([
      { slotOrdinal: 1, reviewStatus: "approved", reviewTurnId: "review-turn", retirementReason: null },
      { slotOrdinal: 2, reviewStatus: "not_requested", reviewTurnId: null, retirementReason: null },
    ])
    const report = await readObjectiveJourneyReport({ userId: "user-1", sessionId: "session-1", finalItemId: "final-1" })
    expect(report?.slots.map(slot => slot.applicationStatus)).toEqual(["unknown", "unknown"])
    expect(report?.reviewCoverage).toBe("complete")
    expect(mocks.application).not.toHaveBeenCalled()
  })
})
