import { describe, expect, it } from "vitest"
import { ANALYST_ROLE_RESULT_OUTPUT_SCHEMA, ROLE_RESULT_SCHEMA, parseScoutAnalystResult, uniqueRequirementQuoteOffsets } from "./role-result-job-evidence.js"

const evidence = [{ id: "job-evidence", kind: "job", ref: "job-1", source: "jobs.read" }]
function analyst(extra: Record<string, unknown> = {}) {
  return { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed",
    findings: [{ jobId: "job-1", score: 8, evidenceIds: ["job-evidence"], ...extra }], evidence, summary: "scored" }
}
function parsedAnalyst(value: Record<string, unknown>) {
  const parsed = parseScoutAnalystResult(value)
  if (!parsed || parsed.role !== "analyst") throw new Error("expected_analyst_result")
  return parsed
}

describe("private Analyst requirement quote parsing", () => {
  it("keeps a valid quote proposal attached to the finding Job evidence", () => {
    expect(parseScoutAnalystResult(analyst({ requirementCitations: [{ evidenceId: "job-evidence", quote: "Build APIs" }] })))
      .toMatchObject({ findings: [{ jobId: "job-1", score: 8,
        requirementCitations: [{ evidenceId: "job-evidence", quote: "Build APIs" }] }] })
  })

  it("preserves historical results and explicit no-citation output", () => {
    expect(parsedAnalyst(analyst()).findings[0]).not.toHaveProperty("requirementCitations")
    expect(parsedAnalyst(analyst({ requirementCitations: null })).findings[0]).not.toHaveProperty("requirementCitations")
  })

  const invalidCitationCases: ReadonlyArray<{ name: string; citations: unknown }> = [
    { name: "foreign evidence", citations: [{ evidenceId: "foreign", quote: "Build APIs" }] },
    { name: "extra key", citations: [{ evidenceId: "job-evidence", quote: "Build APIs", rationale: "it matters" }] },
    { name: "duplicate", citations: [{ evidenceId: "job-evidence", quote: "Build APIs" }, { evidenceId: "job-evidence", quote: "Build APIs" }] },
  ]
  it.each(invalidCitationCases)("drops invalid optional citations ($name) without changing the Analyst score", ({ citations }) => {
    expect(parsedAnalyst(analyst({ requirementCitations: citations }))).toMatchObject({
      findings: [{ jobId: "job-1", score: 8, evidenceIds: ["job-evidence"] }],
    })
    expect(parsedAnalyst(analyst({ requirementCitations: citations })).findings[0]).not.toHaveProperty("requirementCitations")
  })

  it("requires a closed nullable citation field in strict provider schema mode", () => {
    const finding = (ANALYST_ROLE_RESULT_OUTPUT_SCHEMA.properties as Record<string, unknown>).findings as Record<string, unknown>
    const item = finding.items as Record<string, unknown>
    expect(item.required).toContain("requirementCitations")
    expect((item.properties as Record<string, unknown>).requirementCitations).toMatchObject({ anyOf: [{ type: "array", maxItems: 8 }, { type: "null" }] })
  })

  it("derives exact UTF-16 offsets and rejects missing or repeated quote text", () => {
    const description = "🙂 Required: Rust. Other requirements follow."
    expect(uniqueRequirementQuoteOffsets(description, "Required: Rust.")).toEqual({ startUtf16: 3, endUtf16: 18 })
    expect(uniqueRequirementQuoteOffsets("Need Rust. Also Need Rust.", "Need Rust.")).toBeUndefined()
    expect(uniqueRequirementQuoteOffsets(description, "Not present")).toBeUndefined()
  })
})
