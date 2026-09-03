import { describe, expect, it } from "vitest"

import { validateRoleResult, RoleResultValidationError } from "./role-results.js"

const evidence = [{ id: "ev-job-1", kind: "job" as const, ref: "job-1", source: "greenhouse" }]

describe("structured Scout and Analyst results", () => {
  it("accepts real ids and linked job evidence", () => {
    expect(validateRoleResult({ schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "completed", candidates: [{ jobId: "job-1", source: "greenhouse", url: "https://example.test/job-1", evidenceIds: ["ev-job-1"] }], evidence, summary: "one candidate" }, "scout").role).toBe("scout")
    expect(validateRoleResult({ schemaVersion: "agent-harness.v2.subagent.result", role: "analyst", status: "partial", findings: [{ jobId: "job-1", score: 8.5, evidenceIds: ["ev-job-1"] }], evidence, summary: "one finding" }, "analyst").status).toBe("partial")
  })

  it("rejects missing ids, dangling evidence, and non-job evidence", () => {
    expect(() => validateRoleResult({ schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "completed", candidates: [{ jobId: "", source: "greenhouse", url: null, evidenceIds: ["ev-job-1"] }], evidence, summary: "bad" })).toThrow(RoleResultValidationError)
    expect(() => validateRoleResult({ schemaVersion: "agent-harness.v2.subagent.result", role: "analyst", status: "completed", findings: [{ jobId: "job-1", score: 4, evidenceIds: ["missing"] }], evidence, summary: "bad" })).toThrow(/unknown evidence/)
    expect(() => validateRoleResult({ schemaVersion: "agent-harness.v2.subagent.result", role: "analyst", status: "completed", findings: [{ jobId: "job-1", score: 4, evidenceIds: ["ev-persona"] }], evidence: [{ id: "ev-persona", kind: "persona", ref: "fact-1", source: "persona" }], summary: "bad" })).toThrow(/job evidence/)
  })

  it("rejects scores outside the contract", () => {
    expect(() => validateRoleResult({ schemaVersion: "agent-harness.v2.subagent.result", role: "analyst", status: "completed", findings: [{ jobId: "job-1", score: 11, evidenceIds: ["ev-job-1"] }], evidence, summary: "bad" })).toThrow(/score from 0 to 10/)
  })
})
