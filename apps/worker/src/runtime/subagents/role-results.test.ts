import { describe, expect, it } from "vitest"

import { adaptLegacyRoleResult } from "./legacy-adapter.js"
import { ROLE_RESULT_SCHEMA, validateRoleResult, RoleResultValidationError } from "./role-results.js"

const evidence = [{ id: "ev-job-1", kind: "job" as const, ref: "job-1", source: "greenhouse" }]

function validScoutResult() {
  return {
    schemaVersion: ROLE_RESULT_SCHEMA,
    role: "scout" as const,
    status: "completed" as const,
    candidates: [{ jobId: "job-1", source: "greenhouse", url: "https://example.test/job-1", evidenceIds: ["ev-job-1"] }],
    evidence,
    summary: "one candidate",
  }
}

function validAnalystResult() {
  return {
    schemaVersion: ROLE_RESULT_SCHEMA,
    role: "analyst" as const,
    status: "partial" as const,
    findings: [{ jobId: "job-1", score: 8.5, evidenceIds: ["ev-job-1"] }],
    evidence,
    summary: "one finding",
  }
}

function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...value }
  delete copy[key]
  return copy
}

function expectInvalidShape(value: unknown): void {
  let caught: unknown
  try { validateRoleResult(value) } catch (error: unknown) { caught = error }
  expect(caught).toBeInstanceOf(RoleResultValidationError)
  expect(caught).toMatchObject({ code: "invalid_shape" })
}

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

  it.each([
    { name: "Scout top level", value: { ...validScoutResult(), extra: "unexpected" } },
    { name: "Analyst top level", value: { ...validAnalystResult(), extra: "unexpected" } },
    { name: "evidence", value: { ...validScoutResult(), evidence: [{ ...evidence[0], extra: "unexpected" }] } },
    { name: "candidate", value: { ...validScoutResult(), candidates: [{ ...validScoutResult().candidates[0], extra: "unexpected" }] } },
    { name: "finding", value: { ...validAnalystResult(), findings: [{ ...validAnalystResult().findings[0], extra: "unexpected" }] } },
  ])("rejects extra keys in $name", ({ value }) => {
    expectInvalidShape(value)
  })

  it.each([
    { name: "Scout summary", value: withoutKey(validScoutResult(), "summary") },
    { name: "Analyst findings", value: withoutKey(validAnalystResult(), "findings") },
    { name: "evidence source", value: { ...validScoutResult(), evidence: [withoutKey(evidence[0]!, "source")] } },
    { name: "candidate source", value: { ...validScoutResult(), candidates: [withoutKey(validScoutResult().candidates[0]!, "source")] } },
    { name: "finding evidenceIds", value: { ...validAnalystResult(), findings: [withoutKey(validAnalystResult().findings[0]!, "evidenceIds")] } },
  ])("rejects missing keys in $name", ({ value }) => {
    expectInvalidShape(value)
  })

  it.each([
    { name: "top-level nested userId", value: { ...validScoutResult(), metadata: { userId: "forged-user" } } },
    { name: "evidence nested sessionId", value: { ...validScoutResult(), evidence: [{ ...evidence[0], metadata: { sessionId: "forged-session" } }] } },
    { name: "candidate nested turnId", value: { ...validScoutResult(), candidates: [{ ...validScoutResult().candidates[0], metadata: { turnId: "forged-turn" } }] } },
    { name: "finding nested taskId", value: { ...validAnalystResult(), findings: [{ ...validAnalystResult().findings[0], metadata: { taskId: "forged-task" } }] } },
    { name: "array nested permissions", value: { ...validScoutResult(), metadata: [[{ permissions: ["admin"] }]] } },
    { name: "array nested allowedCapabilities", value: { ...validAnalystResult(), metadata: [{ policy: { allowedCapabilities: ["write"] } }] } },
  ])("rejects $name", ({ value }) => {
    expectInvalidShape(value)
  })

  it.each([
    {
      name: "a cyclic object",
      value: (() => {
        const cycle: Record<string, unknown> = {}
        cycle.self = cycle
        return { ...validScoutResult(), metadata: cycle }
      })(),
    },
    { name: "a non-plain object", value: { ...validScoutResult(), metadata: new Date("2026-01-01T00:00:00.000Z") } },
    { name: "NaN", value: { ...validAnalystResult(), findings: [{ ...validAnalystResult().findings[0], score: Number.NaN }] } },
    { name: "Infinity", value: { ...validAnalystResult(), findings: [{ ...validAnalystResult().findings[0], score: Number.POSITIVE_INFINITY }] } },
  ])("rejects $name in the result JSON", ({ value }) => {
    expectInvalidShape(value)
  })

  it("accepts nested business arrays, all evidence kinds, and legacy adapter output", () => {
    const allEvidence = [
      { id: "ev-job-1", kind: "job" as const, ref: "job-1", source: "greenhouse" },
      { id: "ev-persona-1", kind: "persona" as const, ref: "persona:target", source: "persona" },
      { id: "ev-resume-1", kind: "resume" as const, ref: "resume:base", source: "resume" },
      { id: "ev-source-1", kind: "source" as const, ref: "source:search", source: "lever" },
    ]
    const scout = { ...validScoutResult(), evidence: allEvidence, candidates: [{ ...validScoutResult().candidates[0], evidenceIds: allEvidence.map(item => item.id) }] }
    const analyst = { ...validAnalystResult(), evidence: allEvidence, findings: [{ ...validAnalystResult().findings[0], evidenceIds: allEvidence.map(item => item.id) }] }
    expect(validateRoleResult(scout, "scout").evidence).toHaveLength(4)
    expect(validateRoleResult(analyst, "analyst").evidence).toHaveLength(4)
    expect(validateRoleResult(adaptLegacyRoleResult("scout", { jobs: [{ id: "job-1", source: "lever", url: "https://example.test/job-1" }] }), "scout").role).toBe("scout")
    expect(validateRoleResult(adaptLegacyRoleResult("analyst", { analyses: [{ jobId: "job-1", score: 7 }] }), "analyst").role).toBe("analyst")
  })
})
