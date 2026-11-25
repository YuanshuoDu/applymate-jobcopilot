import { beforeEach, describe, expect, it, vi } from "vitest"
import { readObjectiveJourneyRequirementCoverage } from "./objective-journey-report-requirements"
import type { ObjectiveJourneySource } from "./objective-journey-report-source"

const mocks = vi.hoisted(() => ({ receipts: vi.fn(), proof: vi.fn() }))
vi.mock("./objective-journey-report-requirement-receipts", () => ({ readObjectiveJourneyRequirementReceipts: mocks.receipts }))
vi.mock("./objective-journey-report-requirement-proof", () => ({ verifyObjectiveJourneyRequirementProof: mocks.proof }))

describe("readObjectiveJourneyRequirementCoverage", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.receipts.mockResolvedValue({}); mocks.proof.mockReturnValue({ checked: true, hasVerifiedRequirements: true }) })

  it("keeps no-ready legacy source reports without a requirement block", async () => {
    const source = sourceFixture([])
    await expect(readObjectiveJourneyRequirementCoverage({} as never, source)).resolves.toBeUndefined()
    expect(mocks.receipts).not.toHaveBeenCalled()
  })

  it("uses every recorded ready slot as denominator, excluding source-unready slots from checks", async () => {
    const source = sourceFixture([slot(1, true), slot(2, false)])
    await expect(readObjectiveJourneyRequirementCoverage({} as never, source)).resolves.toEqual({
      status: "partial", checkedReadyJobs: 1, verifiedReadyJobs: 1,
    })
    expect(mocks.receipts).toHaveBeenCalledTimes(1)
  })

  it("reports unavailable when ready slots exist but none has a checkable Analyst proof", async () => {
    const source = sourceFixture([slot(1, false), slot(2, false)])
    await expect(readObjectiveJourneyRequirementCoverage({} as never, source)).resolves.toEqual({ status: "unavailable" })
    expect(mocks.receipts).not.toHaveBeenCalled()
  })

  it("counts a validated zero-proposal Analyst as checked without positive requirements", async () => {
    mocks.proof.mockReturnValue({ checked: true, hasVerifiedRequirements: false })
    await expect(readObjectiveJourneyRequirementCoverage({} as never, sourceFixture([slot(1, true)]))).resolves.toEqual({
      status: "complete", checkedReadyJobs: 1, verifiedReadyJobs: 0,
    })
  })

  it("does not count an unverified receipt as checked", async () => {
    mocks.proof.mockReturnValue({ checked: false, hasVerifiedRequirements: false })
    await expect(readObjectiveJourneyRequirementCoverage({} as never, sourceFixture([slot(1, true)]))).resolves.toEqual({ status: "unavailable" })
  })
})

function slot(ordinal: number, sourceReady: boolean) {
  return { ordinal, tailoringStatus: "ready" as const, sourceReady, jobId: sourceReady ? `job-${ordinal}` : null,
    job: sourceReady ? { company: "Example", role: "Engineer" } : null, writerTaskId: null, reviewerTaskId: null,
    requirementAnalyst: sourceReady ? { nodeKey: `analyst-${ordinal}`, taskId: `task-${ordinal}`, attemptCount: 1,
      proofDigest: "a".repeat(64), jobMaterialDigest: `sha256:${"b".repeat(64)}`, criteriaIds: ["finding-count"], dependencyNodeKeys: ["scout"] } : null }
}
function sourceFixture(slots: ReturnType<typeof slot>[]): ObjectiveJourneySource {
  return { userId: "owner", sessionId: "session", sourceTurnId: "turn", rootTaskId: "root", finalItemId: "final", graphRevision: 2,
    sourceCounts: { discoveredJobs: { knownCount: null, coverage: "unavailable" }, analyzedJobs: { knownCount: null, coverage: "unavailable" } }, slots }
}
