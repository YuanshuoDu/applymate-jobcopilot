import { describe, expect, it } from "vitest"
import { ROLE_RESULT_SCHEMA } from "../subagents/role-results.js"
import { validateBoundStructuredEvidence } from "./structured-replay-evidence.js"

function validScout() {
  return {
    schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
    candidates: [{ jobId: "job-1", source: "greenhouse", url: "https://example.test/jobs/job-1", evidenceIds: ["read:job:job-1"] }],
    evidence: [{ id: "read:job:job-1", kind: "job", ref: "job-1", source: "greenhouse" }], summary: "One matching job",
  }
}

function validAnalyst() {
  return {
    schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed",
    findings: [{ jobId: "job-1", score: 8, evidenceIds: ["read:job:job-1"] }],
    evidence: [{ id: "read:job:job-1", kind: "job", ref: "job-1", source: "greenhouse" }], summary: "Strong match",
  }
}

describe("validateBoundStructuredEvidence", () => {
  it.each([validScout(), validAnalyst()])("accepts a role result with canonical evidence", value => {
    expect(validateBoundStructuredEvidence(value)).toBe(true)
  })

  it("allows an empty structured result", () => {
    expect(validateBoundStructuredEvidence({ ...validScout(), candidates: [], evidence: [] })).toBe(true)
    expect(validateBoundStructuredEvidence({ ...validAnalyst(), findings: [], evidence: [] })).toBe(true)
  })

  it.each([
    ["legacy evidence id", { ...validScout(), candidates: [{ ...validScout().candidates[0], evidenceIds: ["evidence-job-1"] }], evidence: [{ ...validScout().evidence[0], id: "evidence-job-1" }] }],
    ["source evidence kind", { ...validScout(), evidence: [...validScout().evidence, { id: "read:source:source-1", kind: "source", ref: "source-1", source: "model" }] }],
    ["mismatched canonical id", { ...validScout(), candidates: [{ ...validScout().candidates[0], evidenceIds: ["read:job:other"] }], evidence: [{ ...validScout().evidence[0], id: "read:job:other" }] }],
    ["duplicate canonical evidence", { ...validScout(), evidence: [validScout().evidence[0], { ...validScout().evidence[0] }] }],
    ["empty evidence ref", { ...validScout(), candidates: [{ ...validScout().candidates[0], evidenceIds: ["read:job:"] }], evidence: [{ ...validScout().evidence[0], id: "read:job:", ref: "" }] }],
    ["empty evidence source", { ...validScout(), evidence: [{ ...validScout().evidence[0], id: "read:job:job-1", source: " " }] }],
    ["oversized evidence source", { ...validScout(), evidence: [{ ...validScout().evidence[0], source: "x".repeat(257) }] }],
  ] as const)("rejects %s", (_name, value) => {
    expect(validateBoundStructuredEvidence(value)).toBe(false)
  })

  it("rejects a structured result above the replay bound", () => {
    expect(validateBoundStructuredEvidence({ ...validScout(), summary: "x".repeat(9_000) })).toBe(false)
  })
})
