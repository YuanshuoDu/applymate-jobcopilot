import { describe, expect, it } from "vitest"

import {
  createObservedJobFacts,
  observedJobLocationProjection,
  recordObservedJobFact,
} from "./child-observed-job-facts.js"

describe("observed Job location facts", () => {
  it("canonicalizes a current observed value and tolerates equivalent repeat observations", () => {
    const facts = createObservedJobFacts()
    recordObservedJobFact(facts, "job-1", "greenhouse", "  Dublin,   Ireland  ")
    recordObservedJobFact(facts, "job-1", "greenhouse", "dublin, ireland")

    expect(observedJobLocationProjection(facts, "job-1")).toEqual({
      observedLocation: "dublin, ireland", locationEvidenceStatus: "verified",
    })
  })

  it.each([
    ["source", "lever", "Dublin"],
    ["location", "greenhouse", "Cork"],
  ] as const)("marks a repeated Job with a different %s as conflicting", (_name, secondSource, secondLocation) => {
    const facts = createObservedJobFacts()
    recordObservedJobFact(facts, "job-1", "greenhouse", "Dublin")
    recordObservedJobFact(facts, "job-1", secondSource, secondLocation)

    expect(observedJobLocationProjection(facts, "job-1")).toEqual({
      observedLocation: null, locationEvidenceStatus: "conflicting",
    })
  })

  it.each([null, undefined, " \t "]) ("treats a null or empty observed location as missing", location => {
    const facts = createObservedJobFacts()
    recordObservedJobFact(facts, "job-1", "greenhouse", location)
    expect(observedJobLocationProjection(facts, "job-1")).toEqual({
      observedLocation: null, locationEvidenceStatus: "missing",
    })
  })

  it("does not turn missing data into proof when another observation later supplies a value", () => {
    const facts = createObservedJobFacts()
    recordObservedJobFact(facts, "job-1", "greenhouse", null)
    recordObservedJobFact(facts, "job-1", "greenhouse", "Dublin")
    expect(observedJobLocationProjection(facts, "job-1")).toEqual({
      observedLocation: null, locationEvidenceStatus: "conflicting",
    })
  })

  it("accepts a real location with a nullable source and fails closed for unobserved IDs", () => {
    const facts = createObservedJobFacts()
    recordObservedJobFact(facts, "job-1", undefined, "Dublin")
    expect(observedJobLocationProjection(facts, "job-2")).toEqual({
      observedLocation: null, locationEvidenceStatus: "missing",
    })
    expect(observedJobLocationProjection(facts, "job-1")).toEqual({
      observedLocation: "dublin", locationEvidenceStatus: "verified",
    })
  })
})
