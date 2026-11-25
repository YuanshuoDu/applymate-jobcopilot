import { beforeEach, describe, expect, it, vi } from "vitest"
import { OBJECTIVE_JOURNEY_REPORT_SCHEMA_V2 } from "./objective-journey-report-contract"
import { readObjectiveJourneyReport } from "./objective-journey-report"

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(), source: vi.fn(), approvals: vi.fn(), application: vi.fn(), requirements: vi.fn(),
}))
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }))
vi.mock("./objective-journey-report-source", () => ({ readObjectiveJourneySource: mocks.source }))
vi.mock("./objective-journey-report-approvals", () => ({ readObjectiveJourneyReportApprovals: mocks.approvals }))
vi.mock("./objective-journey-report-application", () => ({ readObjectiveJourneyReportApplication: mocks.application }))
vi.mock("./objective-journey-report-requirements", () => ({ readObjectiveJourneyRequirementCoverage: mocks.requirements }))

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
    mocks.requirements.mockResolvedValue({ status: "complete", checkedReadyJobs: 1, verifiedReadyJobs: 1 })
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
    expect(report?.schemaVersion).toBe("agent-harness.v2.objective-journey-report.v3")
    expect(report).toMatchObject({ requirementEvidenceCoverage: { status: "complete", checkedReadyJobs: 1, verifiedReadyJobs: 1 } })
    expect(report).toMatchObject({ graphRevision: 12, reviewCoverage: "partial", slots: [
      { ordinal: 1, reviewStatus: "approved", applicationStatus: "submitted", submissionEvidence: { fillTurnId: "fill-1", finalItemId: "submit-final" } },
      { ordinal: 2, tailoringStatus: "stale", reviewStatus: "unknown", applicationStatus: "unknown", job: null },
    ] })
    expect(mocks.application.mock.calls.map(call => call[1])).toEqual([binding])
  })

  it("carries a verified V3 complete floor into report V2, including numeric zero", async () => {
    mocks.source.mockResolvedValue({ ...source, slots: source.slots.map(slot => ({ ...slot, tailoringStatus: "stale", sourceReady: false })),
      sourceCounts: { ...source.sourceCounts,
      analyzedJobs: { knownCount: 6, coverage: "complete" } },
      reportedScoreFloor: { status: "complete", minimumScore: 0, qualifyingJobCount: 0 } })
    mocks.requirements.mockResolvedValue(undefined)
    const report = await readObjectiveJourneyReport({ userId: "user-1", sessionId: "session-1", finalItemId: "final-1" })
    expect(report).toMatchObject({ schemaVersion: OBJECTIVE_JOURNEY_REPORT_SCHEMA_V2,
      reportedScoreFloor: { status: "complete", minimumScore: 0, qualifyingJobCount: 0 } })
  })

  it("publishes bounded requirement coverage in V3 for source-ready Jobs", async () => {
    mocks.source.mockResolvedValue({ ...source, slots: [source.slots[0]!, {
      ...source.slots[1]!, tailoringStatus: "ready", job: { company: "Other", role: "Engineer" },
    }] })
    mocks.requirements.mockResolvedValue({ status: "partial", checkedReadyJobs: 1, verifiedReadyJobs: 0 })
    const report = await readObjectiveJourneyReport({ userId: "user-1", sessionId: "session-1", finalItemId: "final-1" })
    expect(report).toMatchObject({ schemaVersion: "agent-harness.v2.objective-journey-report.v3",
      requirementEvidenceCoverage: { status: "partial", checkedReadyJobs: 1, verifiedReadyJobs: 0 } })
    expect(report?.slots).toHaveLength(2)
    expect(report?.slots[0]).toMatchObject({ ordinal: 1, job: { company: "Acme", role: "Engineer" } })
  })

  it("keeps unavailable coverage status-only and rejects counts beyond ready slots", async () => {
    mocks.requirements.mockResolvedValue({ status: "unavailable" })
    const unavailable = await readObjectiveJourneyReport({ userId: "user-1", sessionId: "session-1", finalItemId: "final-1" })
    expect(unavailable).toMatchObject({ requirementEvidenceCoverage: { status: "unavailable" } })
    mocks.requirements.mockResolvedValue({ status: "complete", checkedReadyJobs: 2, verifiedReadyJobs: 2 })
    expect(await readObjectiveJourneyReport({ userId: "user-1", sessionId: "session-1", finalItemId: "final-1" })).toBeUndefined()
  })

  it("uses V3 unavailable when a recorded ready slot lacks recoverable source proof", async () => {
    mocks.source.mockResolvedValue({ ...source, slots: [
      { ...source.slots[0]!, sourceReady: false }, source.slots[1]!,
    ] })
    mocks.requirements.mockResolvedValue({ status: "unavailable" })
    const report = await readObjectiveJourneyReport({ userId: "user-1", sessionId: "session-1", finalItemId: "final-1" })
    expect(report).toMatchObject({ schemaVersion: "agent-harness.v2.objective-journey-report.v3",
      requirementEvidenceCoverage: { status: "unavailable" } })
  })

  it("preserves historical report versions when no source-ready Job can be checked", async () => {
    mocks.source.mockResolvedValue({ ...source, reportedScoreFloor: { status: "not_requested" },
      slots: source.slots.map(slot => ({ ...slot, tailoringStatus: "stale", sourceReady: false })) })
    mocks.requirements.mockResolvedValue(undefined)
    mocks.approvals.mockResolvedValue(source.slots.map(slot => ({ slotOrdinal: slot.ordinal, reviewStatus: "not_requested",
      reviewTurnId: null, retirementReason: null })))
    const report = await readObjectiveJourneyReport({ userId: "user-1", sessionId: "session-1", finalItemId: "final-1" })
    expect(report?.schemaVersion).toBe(OBJECTIVE_JOURNEY_REPORT_SCHEMA_V2)
    expect(report).toHaveProperty("reportedScoreFloor", { status: "not_requested" })
    expect(report).not.toHaveProperty("requirementEvidenceCoverage")
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
    mocks.requirements.mockResolvedValue({ status: "partial", checkedReadyJobs: 1, verifiedReadyJobs: 0 })
    const report = await readObjectiveJourneyReport({ userId: "user-1", sessionId: "session-1", finalItemId: "final-1" })
    expect(report?.slots.map(slot => slot.applicationStatus)).toEqual(["unknown", "unknown"])
    expect(report?.reviewCoverage).toBe("complete")
    expect(mocks.application).not.toHaveBeenCalled()
  })
})
