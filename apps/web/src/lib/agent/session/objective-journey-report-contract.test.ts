import { describe, expect, it } from "vitest"
import { OBJECTIVE_JOURNEY_REPORT_SCHEMA, OBJECTIVE_JOURNEY_REPORT_SCHEMA_V2, OBJECTIVE_JOURNEY_REPORT_SCHEMA_V3,
  parseObjectiveJourneyReport } from "./objective-journey-report-contract"

const count = { knownCount: 3, coverage: "complete" }
const baseSlot = {
  ordinal: 1, tailoringStatus: "ready", job: { company: "Acme", role: "Engineer" },
  reviewStatus: "expired", reviewTurnId: "review-turn", retirementReason: "resume_material_changed",
  applicationStatus: "not_started", submissionEvidence: null,
}
const report = {
  schemaVersion: OBJECTIVE_JOURNEY_REPORT_SCHEMA, finalItemId: "final-item", graphRevision: 9,
  sourceCounts: { discoveredJobs: count, analyzedJobs: { knownCount: null, coverage: "unavailable" } },
  reviewCoverage: "partial", slots: [baseSlot],
}

describe("parseObjectiveJourneyReport", () => {
  it("accepts bounded owner facts and preserves count coverage distinctions", () => {
    expect(parseObjectiveJourneyReport(report)).toEqual(report)
    expect(parseObjectiveJourneyReport({ ...report, sourceCounts: {
      discoveredJobs: { knownCount: 0, coverage: "partial" }, analyzedJobs: { knownCount: null, coverage: "not_requested" },
    } })?.sourceCounts.analyzedJobs).toEqual({ knownCount: null, coverage: "not_requested" })
  })

  it("accepts closed score-floor states and preserves a complete numeric zero", () => {
    const base = { ...report, schemaVersion: OBJECTIVE_JOURNEY_REPORT_SCHEMA_V2,
      sourceCounts: { discoveredJobs: count, analyzedJobs: { knownCount: 3, coverage: "complete" } } }
    const complete = { status: "complete", minimumScore: 7.5, qualifyingJobCount: 0 }
    expect(parseObjectiveJourneyReport({ ...base, reportedScoreFloor: complete })).toMatchObject({
      schemaVersion: OBJECTIVE_JOURNEY_REPORT_SCHEMA_V2, reportedScoreFloor: complete,
    })
    expect(parseObjectiveJourneyReport({ ...base, reportedScoreFloor: { status: "not_requested" } }))
      .toMatchObject({ reportedScoreFloor: { status: "not_requested" } })
    expect(parseObjectiveJourneyReport({ ...base, reportedScoreFloor: { status: "unavailable" } }))
      .toMatchObject({ reportedScoreFloor: { status: "unavailable" } })
  })

  it("accepts closed requirement coverage with zero verified Jobs and an optional score floor", () => {
    const base = { ...report, schemaVersion: OBJECTIVE_JOURNEY_REPORT_SCHEMA_V3 }
    const coverage = { status: "complete", checkedReadyJobs: 1, verifiedReadyJobs: 0 }
    expect(parseObjectiveJourneyReport({ ...base, requirementEvidenceCoverage: coverage }))
      .toMatchObject({ requirementEvidenceCoverage: coverage })
    expect(parseObjectiveJourneyReport({ ...base, requirementEvidenceCoverage: { status: "unavailable" } }))
      .toMatchObject({ requirementEvidenceCoverage: { status: "unavailable" } })
    const twoReady = { ...base, slots: [baseSlot, { ...baseSlot, ordinal: 2 }] }
    expect(parseObjectiveJourneyReport({ ...twoReady, reportedScoreFloor: { status: "not_requested" },
      requirementEvidenceCoverage: { status: "partial", checkedReadyJobs: 1, verifiedReadyJobs: 1 } }))
      .toMatchObject({ schemaVersion: OBJECTIVE_JOURNEY_REPORT_SCHEMA_V3, reportedScoreFloor: { status: "not_requested" } })
  })

  it("rejects unbounded, contradictory, or open requirement coverage", () => {
    const base = { ...report, schemaVersion: OBJECTIVE_JOURNEY_REPORT_SCHEMA_V3 }
    for (const requirementEvidenceCoverage of [
      undefined,
      { status: "unavailable", checkedReadyJobs: 0, verifiedReadyJobs: 0 },
      { status: "complete", checkedReadyJobs: 0, verifiedReadyJobs: 0 },
      { status: "partial", checkedReadyJobs: 2, verifiedReadyJobs: 1 },
      { status: "partial", checkedReadyJobs: 1, verifiedReadyJobs: 2 },
      { status: "partial", checkedReadyJobs: 1, verifiedReadyJobs: 0 },
      { status: "unknown" },
      { status: "complete", checkedReadyJobs: 1, verifiedReadyJobs: 0, privateProof: "secret" },
    ]) expect(parseObjectiveJourneyReport({ ...base, requirementEvidenceCoverage })).toBeUndefined()
    const twoReady = { ...base, slots: [baseSlot, { ...baseSlot, ordinal: 2 }] }
    expect(parseObjectiveJourneyReport({ ...twoReady,
      requirementEvidenceCoverage: { status: "complete", checkedReadyJobs: 1, verifiedReadyJobs: 1 } })).toBeUndefined()
    const noReady = { ...base, slots: [{ ...baseSlot, tailoringStatus: "stale" }] }
    expect(parseObjectiveJourneyReport({ ...noReady, requirementEvidenceCoverage: { status: "unavailable" } })).toBeUndefined()
  })

  it("rejects score floors without exact closed evidence or a complete denominator", () => {
    const base = { ...report, schemaVersion: OBJECTIVE_JOURNEY_REPORT_SCHEMA_V2,
      sourceCounts: { discoveredJobs: count, analyzedJobs: { knownCount: 3, coverage: "complete" } } }
    for (const floor of [undefined, { status: "not_requested", qualifyingJobCount: 0 },
      { status: "unavailable", minimumScore: 4 }, { status: "unknown" },
      { status: "complete", minimumScore: 4, qualifyingJobCount: 4 },
      { status: "complete", minimumScore: 11, qualifyingJobCount: 1 }]) {
      expect(parseObjectiveJourneyReport({ ...base, reportedScoreFloor: floor })).toBeUndefined()
    }
    expect(parseObjectiveJourneyReport({ ...base, sourceCounts: report.sourceCounts,
      reportedScoreFloor: { status: "complete", minimumScore: 4, qualifyingJobCount: 1 } })).toBeUndefined()
  })

  it("accepts only dense one-to-eight ordered slots", () => {
    const second = { ...baseSlot, ordinal: 2, reviewStatus: "not_requested", reviewTurnId: null, retirementReason: null }
    expect(parseObjectiveJourneyReport({ ...report, slots: [baseSlot, second] })?.slots.map(slot => slot.ordinal)).toEqual([1, 2])
    const hole = new Array(2); hole[0] = baseSlot
    expect(parseObjectiveJourneyReport({ ...report, slots: hole })).toBeUndefined()
    expect(parseObjectiveJourneyReport({ ...report, slots: Array.from({ length: 9 }, (_, i) => ({ ...baseSlot, ordinal: i + 1 })) })).toBeUndefined()
    expect(parseObjectiveJourneyReport({ ...report, slots: [{ ...baseSlot, ordinal: 2 }] })).toBeUndefined()
  })

  it("requires exact evidence/status pairings and closed retirement causes", () => {
    const evidence = { fillTurnId: "fill-turn", finalItemId: "submitted-final" }
    expect(parseObjectiveJourneyReport({ ...report, slots: [{ ...baseSlot, reviewStatus: "approved", retirementReason: null,
      applicationStatus: "submitted", submissionEvidence: evidence }] })?.slots[0]?.submissionEvidence).toEqual(evidence)
    for (const slot of [
      { ...baseSlot, retirementReason: "free_text" },
      { ...baseSlot, reviewStatus: "approved", retirementReason: "resume_material_changed" },
      { ...baseSlot, applicationStatus: "submitted" },
      { ...baseSlot, submissionEvidence: evidence },
      { ...baseSlot, reviewStatus: "not_requested" },
      { ...baseSlot, reviewStatus: "pending", reviewTurnId: null },
      { ...baseSlot, tailoringStatus: "stale", reviewStatus: "approved", applicationStatus: "preparing", retirementReason: null },
      { ...baseSlot, job: { company: "Acme\nInc", role: "Engineer" } },
    ]) expect(parseObjectiveJourneyReport({ ...report, slots: [slot] })).toBeUndefined()
  })

  it("rejects duplicate confirmed evidence and unknown members under complete coverage", () => {
    const evidence = { fillTurnId: "fill-turn", finalItemId: "submitted-final" }
    const submitted = { ...baseSlot, reviewStatus: "approved", retirementReason: null, applicationStatus: "submitted", submissionEvidence: evidence }
    expect(parseObjectiveJourneyReport({ ...report, slots: [{ ...submitted, ordinal: 1 }, { ...submitted, ordinal: 2 }] })).toBeUndefined()
    expect(parseObjectiveJourneyReport({ ...report, reviewCoverage: "complete", slots: [{ ...baseSlot, reviewStatus: "unknown", reviewTurnId: null, retirementReason: null }] })).toBeUndefined()
    expect(parseObjectiveJourneyReport({ ...report, slots: [{ ...submitted, submissionEvidence: { ...evidence, finalItemId: "final-item" } }] })).toBeUndefined()
  })

  it("rejects unknown keys, bad counts, accessors, and exotic records", () => {
    const badCount = { ...report, sourceCounts: { discoveredJobs: { knownCount: null, coverage: "complete" }, analyzedJobs: count } }
    const extra = { ...baseSlot, privateHash: "secret" }
    const accessor = Object.defineProperty({ ...report }, "finalItemId", { enumerable: true, get: () => "final-item" })
    expect(parseObjectiveJourneyReport({ ...report, extra: true })).toBeUndefined()
    expect(parseObjectiveJourneyReport({ ...report, sourceCounts: badCount.sourceCounts })).toBeUndefined()
    expect(parseObjectiveJourneyReport({ ...report, slots: [extra] })).toBeUndefined()
    expect(parseObjectiveJourneyReport(accessor)).toBeUndefined()
    expect(parseObjectiveJourneyReport(Object.create(report))).toBeUndefined()
  })
})
