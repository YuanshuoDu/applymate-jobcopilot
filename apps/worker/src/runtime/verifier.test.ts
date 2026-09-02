import { describe, expect, it } from "vitest"

import { verifyCandidateFinal } from "./verifier.js"

describe("candidate final verifier", () => {
  it("rejects a plausible final with no evidence", () => {
    expect(verifyCandidateFinal({ goal: "Find a role", candidate: { text: "Done", finishReason: "stop" } })).toMatchObject({ ok: false, code: "evidence_missing" })
  })

  it("returns typed conflicting and business failures", () => {
    expect(verifyCandidateFinal({ goal: "Find a role", candidate: { text: "Done", finishReason: "stop", evidenceRefs: ["job-1"] }, evidence: [{ id: "job-1", status: "conflicting" }] })).toMatchObject({ ok: false, code: "evidence_conflict" })
    expect(verifyCandidateFinal({ goal: "Find a role", candidate: { text: "Done", finishReason: "stop", evidenceRefs: ["job-1"] }, evidence: [{ id: "job-1" }], businessChecks: [{ name: "approval", ok: false, message: "Approval is required" }] })).toMatchObject({ ok: false, code: "business_precondition_failed" })
  })

  it("accepts only a stopped response with verified evidence", () => {
    expect(verifyCandidateFinal({ goal: "Find a role", candidate: { text: "Done", finishReason: "stop", evidenceRefs: ["job-1"] }, evidence: [{ id: "job-1" }] })).toMatchObject({ ok: true, evidenceRefs: ["job-1"] })
  })
})
