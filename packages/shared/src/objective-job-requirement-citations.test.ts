import { describe, expect, it } from "vitest"
import { objectiveJobRequirementProposals, parseObjectiveJobRequirementCitations, uniqueObjectiveRequirementQuoteOffsets } from "./objective-job-requirement-citations.js"

const jobId = "123e4567-e89b-42d3-a456-426614174000"
const evidence = [{ id: "job-proof", kind: "job", ref: jobId, source: "jobs.get" },
  { id: "persona-proof", kind: "persona", ref: "persona:one", source: "persona.retrieve" }]
const citation = { evidenceId: "job-proof", quote: "Requires Rust" }
function analyst(findings: unknown[] = [{ jobId, score: 8, evidenceIds: ["job-proof"], requirementCitations: [citation] }]) {
  return { schemaVersion: "agent-harness.v2.subagent.result", role: "analyst", status: "completed", evidence,
    findings, summary: "Reviewed one posting." }
}

describe("shared Objective requirement citation policy", () => {
  it("extracts only same-finding citations bound to selected Job evidence", () => {
    expect(objectiveJobRequirementProposals(analyst(), [jobId])).toEqual([{ jobId, ...citation }])
    expect(objectiveJobRequirementProposals(analyst(), [])).toEqual([])
    expect(parseObjectiveJobRequirementCitations([citation], jobId, ["job-proof"], evidence)).toEqual([citation])
  })

  it.each([
    ["foreign evidence", [{ evidenceId: "persona-proof", quote: "Requires Rust" }]],
    ["extra citation field", [{ ...citation, rationale: "Unsupported claim" }]],
    ["duplicate citation", [citation, citation]],
    ["empty quote", [{ evidenceId: "job-proof", quote: " " }]],
  ])("drops an invalid optional citation without changing result eligibility (%s)", (_name, value) => {
    expect(parseObjectiveJobRequirementCitations(value, jobId, ["job-proof"], evidence)).toBeUndefined()
    expect(objectiveJobRequirementProposals(analyst([{ jobId, score: 8, evidenceIds: ["job-proof"], requirementCitations: value }]), [jobId])).toEqual([])
  })

  it("rejects malformed closed Analyst input and derives unique UTF-16 source offsets", () => {
    expect(objectiveJobRequirementProposals({ ...analyst(), unexpected: true }, [jobId])).toBeNull()
    expect(objectiveJobRequirementProposals(analyst(), ["foreign-job"])).toBeNull()
    expect(uniqueObjectiveRequirementQuoteOffsets("🙂 Requires Rust elsewhere", "Requires Rust")).toEqual({ startUtf16: 3, endUtf16: 16 })
    expect(uniqueObjectiveRequirementQuoteOffsets("Requires Rust; Requires Rust", "Requires Rust")).toBeUndefined()
    expect(uniqueObjectiveRequirementQuoteOffsets("Requires Rust", "Not present")).toBeUndefined()
    expect(uniqueObjectiveRequirementQuoteOffsets("Requires Rust", "x".repeat(513))).toBeUndefined()
  })
})
