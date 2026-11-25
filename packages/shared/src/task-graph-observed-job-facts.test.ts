import { describe, expect, it } from "vitest"

import { createObservedJobFacts, observedJobLocationProjection, recordObservedJobFact } from "./task-graph-observed-job-facts.js"

describe("shared observed Job facts", () => {
  it("normalizes equal locations and marks distinct observations as conflict", () => {
    const facts = createObservedJobFacts()
    recordObservedJobFact(facts, "job-a", "greenhouse", "  Dublin, Ireland ")
    recordObservedJobFact(facts, "job-a", "greenhouse", "dublin, ireland")
    expect(observedJobLocationProjection(facts, "job-a")).toEqual({
      observedLocation: "dublin, ireland", locationEvidenceStatus: "verified",
    })
    recordObservedJobFact(facts, "job-a", "lever", "Dublin, Ireland")
    expect(observedJobLocationProjection(facts, "job-a")).toEqual({
      observedLocation: null, locationEvidenceStatus: "conflicting",
    })
  })

  it("does not claim an unobserved or absent location", () => {
    const facts = createObservedJobFacts()
    recordObservedJobFact(facts, "job-b", null, null)
    expect(observedJobLocationProjection(facts, "job-b")).toEqual({
      observedLocation: null, locationEvidenceStatus: "missing",
    })
    expect(observedJobLocationProjection(facts, "job-c")).toEqual({
      observedLocation: null, locationEvidenceStatus: "missing",
    })
  })
})
