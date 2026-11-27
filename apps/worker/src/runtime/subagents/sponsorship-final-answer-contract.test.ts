import { describe, expect, it } from "vitest"
import { parseSponsorshipFinalAnswerBinding, renderSponsorshipFinalAnswer, SPONSORSHIP_FINAL_ANSWER_SCHEMA } from "./sponsorship-final-answer-contract.js"

const empty = { schemaVersion: SPONSORSHIP_FINAL_ANSWER_SCHEMA, rootTaskId: "root-1", rootAttemptCount: 1,
  candidateStepId: "step-1", targetCountryCode: "IE", outcomes: [] }

describe("sponsorship final answer contract", () => {
  it("renders no-review as unknown while preserving a closed, empty projection", () => {
    const parsed = parseSponsorshipFinalAnswerBinding(empty)
    expect(parsed).not.toBeNull()
    const rendered = renderSponsorshipFinalAnswer(parsed, code => code === "IE" ? "Ireland" : null)
    expect(rendered).toEqual([expect.stringContaining("availability is unknown")])
    expect(rendered?.[0]).toContain("An absent review is not evidence that sponsorship is unavailable")
  })

  it("renders only the verified listing interpretation and omits private proof identity", () => {
    const binding = parseSponsorshipFinalAnswerBinding({ ...empty, outcomes: [{ jobId: "private-job-id", role: "Backend Engineer",
      status: "explicit", polarity: "available", reviewerTaskId: "private-reviewer-id", reviewerAttempt: 2,
      reviewBindingDigest: `sha256:${"a".repeat(64)}` }] })
    expect(binding).not.toBeNull()
    const rendered = renderSponsorshipFinalAnswer(binding, code => code === "IE" ? "Ireland" : null)?.join("\n") ?? ""
    expect(rendered).toContain('Saved listing assessment for "Backend Engineer" in Ireland')
    expect(rendered).toContain("listing text at review time, not employer policy or a guarantee")
    for (const secret of ["private-job-id", "private-reviewer-id", "sha256:"]) {
      expect(rendered).not.toContain(secret)
    }
  })

  it("rejects duplicate, malformed, and unknown country bindings", () => {
    const outcome = { jobId: "job-1", role: "Backend Engineer", status: "inconclusive", reviewerTaskId: "review-1",
      reviewerAttempt: 1, reviewBindingDigest: `sha256:${"b".repeat(64)}` }
    expect(parseSponsorshipFinalAnswerBinding({ ...empty, outcomes: [outcome, outcome] })).toBeNull()
    expect(parseSponsorshipFinalAnswerBinding({ ...empty, targetCountryCode: "ZZ" })).toBeNull()
    expect(parseSponsorshipFinalAnswerBinding({ ...empty, unknown: true })).toBeNull()
    expect(renderSponsorshipFinalAnswer(empty, () => null)).toBeNull()
  })
})
