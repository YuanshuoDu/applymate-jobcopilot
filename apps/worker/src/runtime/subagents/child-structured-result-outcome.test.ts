import { Buffer } from "node:buffer"
import { describe, expect, it, vi } from "vitest"

import { createObservedEvidenceIndex, parseAndBindStructuredResult, recordReadToolOutput } from "./child-evidence.js"
import { MAX_EVIDENCE_BYTES, parseAndBindStructuredResultOutcome } from "./child-structured-result-outcome.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"

function emptyScoutResult(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed", candidates: [], evidence: [], summary: "no jobs", ...overrides }
}

function scoutWithEvidence(ref = "job-1", source = "model") {
  return {
    schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
    candidates: [{ jobId: ref, source: "greenhouse", url: null, evidenceIds: ["model-job"] }],
    evidence: [{ id: "model-job", kind: "job", ref, source }], summary: "one job",
  }
}

describe("single-pass structured result outcomes", () => {
  it("keeps a valid bound result compatible with the result-or-undefined wrapper", () => {
    const index = createObservedEvidenceIndex()
    recordReadToolOutput(index, "jobs.search", { jobs: [{ id: "job-1", source: "greenhouse" }] })
    const value = JSON.stringify(scoutWithEvidence())
    const outcome = parseAndBindStructuredResultOutcome(value, "scout", index)

    expect(outcome.kind).toBe("valid")
    if (outcome.kind !== "valid") throw new Error("valid_result_expected")
    expect(parseAndBindStructuredResult(value, "scout", index)).toEqual(outcome.result)
    expect(JSON.stringify(outcome.result)).toBe(JSON.stringify({
      schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
      candidates: [{ jobId: "job-1", source: "greenhouse", url: null, evidenceIds: ["read:job:job-1"] }],
      evidence: [{ id: "read:job:job-1", kind: "job", ref: "job-1", source: "greenhouse" }], summary: "one job",
    }))
  })

  it("rejects Scout source attribution that differs from the observed job read", () => {
    const index = createObservedEvidenceIndex()
    recordReadToolOutput(index, "jobs.get", { job: { id: "job-1", source: "greenhouse" } })
    const result = scoutWithEvidence()
    result.candidates[0]!.source = "lever"

    expect(parseAndBindStructuredResultOutcome(JSON.stringify(result), "scout", index))
      .toEqual({ kind: "invalid", category: "evidence_binding_invalid" })
  })

  it.each([undefined, null, "", "   "])("uses the generic jobs.read source fallback when the read has no bounded source (%s)", source => {
    const index = createObservedEvidenceIndex()
    const job: Record<string, unknown> = { id: "job-1" }
    if (source !== undefined) job.source = source
    recordReadToolOutput(index, "jobs.get", { job })

    const generic = scoutWithEvidence()
    generic.candidates[0]!.source = "jobs.read"
    expect(parseAndBindStructuredResultOutcome(JSON.stringify(generic), "scout", index).kind).toBe("valid")

    const inventedProvider = scoutWithEvidence()
    inventedProvider.candidates[0]!.source = "greenhouse"
    expect(parseAndBindStructuredResultOutcome(JSON.stringify(inventedProvider), "scout", index))
      .toEqual({ kind: "invalid", category: "evidence_binding_invalid" })
  })

  it("fails closed when current reads disagree about a job source", () => {
    const index = createObservedEvidenceIndex()
    recordReadToolOutput(index, "jobs.get", { job: { id: "job-1", source: "greenhouse" } })
    recordReadToolOutput(index, "jobs.get", { job: { id: "job-1", source: "lever" } })

    expect(parseAndBindStructuredResultOutcome(JSON.stringify(scoutWithEvidence()), "scout", index))
      .toEqual({ kind: "invalid", category: "evidence_binding_invalid" })
  })

  it("labels missing final output, raw overflow, and malformed JSON without exposing source data", () => {
    expect(parseAndBindStructuredResultOutcome(undefined, "scout", createObservedEvidenceIndex()))
      .toEqual({ kind: "invalid", category: "missing_final_output" })
    const tooLarge = JSON.stringify(emptyScoutResult({ summary: "private-raw-".repeat(800) }))
    expect(Buffer.byteLength(tooLarge, "utf8")).toBeGreaterThan(MAX_EVIDENCE_BYTES)
    expect(parseAndBindStructuredResultOutcome(tooLarge, "scout", createObservedEvidenceIndex()))
      .toEqual({ kind: "invalid", category: "result_too_large" })
    expect(parseAndBindStructuredResultOutcome("{private malformed", "scout", createObservedEvidenceIndex()))
      .toEqual({ kind: "invalid", category: "result_shape_invalid" })
  })

  it("accepts exactly 8 KiB and rejects the next raw UTF-8 byte as too large", () => {
    const base = emptyScoutResult({ summary: "" })
    const baseBytes = Buffer.byteLength(JSON.stringify(base), "utf8")
    const atLimit = JSON.stringify(emptyScoutResult({ summary: "x".repeat(MAX_EVIDENCE_BYTES - baseBytes) }))
    const overLimit = JSON.stringify(emptyScoutResult({ summary: "x".repeat(MAX_EVIDENCE_BYTES - baseBytes + 1) }))

    expect(Buffer.byteLength(atLimit, "utf8")).toBe(MAX_EVIDENCE_BYTES)
    expect(parseAndBindStructuredResultOutcome(atLimit, "scout", createObservedEvidenceIndex()).kind).toBe("valid")
    expect(Buffer.byteLength(overLimit, "utf8")).toBe(MAX_EVIDENCE_BYTES + 1)
    expect(parseAndBindStructuredResultOutcome(overLimit, "scout", createObservedEvidenceIndex()))
      .toEqual({ kind: "invalid", category: "result_too_large" })
  })

  it.each([
    ["invalid shape", emptyScoutResult({ extra: "private" })],
    ["missing identifier", emptyScoutResult({ candidates: [{ jobId: "", source: "greenhouse", url: null, evidenceIds: ["e"] }] })],
    ["invalid score", { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed", findings: [{ jobId: "job-1", score: 11, evidenceIds: ["e"] }], evidence: [{ id: "e", kind: "job", ref: "job-1", source: "model" }], summary: "bad score" }],
  ] as const)("classifies known %s validation failures as result shape", (_name, value) => {
    expect(parseAndBindStructuredResultOutcome(JSON.stringify(value), value.role === "analyst" ? "analyst" : "scout", createObservedEvidenceIndex()))
      .toEqual({ kind: "invalid", category: "result_shape_invalid" })
  })

  it("separates known missing evidence from evidence that fails observed binding", () => {
    const missingEvidence = scoutWithEvidence()
    missingEvidence.candidates[0]!.evidenceIds = []
    expect(parseAndBindStructuredResultOutcome(JSON.stringify(missingEvidence), "scout", createObservedEvidenceIndex()))
      .toEqual({ kind: "invalid", category: "evidence_binding_invalid" })
    expect(parseAndBindStructuredResultOutcome(JSON.stringify(scoutWithEvidence()), "scout", createObservedEvidenceIndex()))
      .toEqual({ kind: "invalid", category: "evidence_binding_invalid" })
  })

  it("classifies the normalized serialized-size check separately from raw input size", () => {
    const refs = Array.from({ length: 15 }, (_, index) => `job-${index}-${"x".repeat(110)}`)
    const index = createObservedEvidenceIndex()
    const source = "s".repeat(198)
    recordReadToolOutput(index, "jobs.search", { jobs: refs.map(id => ({ id, source })) })
    const value = JSON.stringify({
      schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
      candidates: refs.map((jobId, number) => ({ jobId, source, url: null, evidenceIds: [`m${number}`] })),
      evidence: refs.map((ref, number) => ({ id: `m${number}`, kind: "job", ref, source: "x" })), summary: "normalized size",
    })

    expect(index.entries.size).toBe(refs.length)
    expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(MAX_EVIDENCE_BYTES)
    expect(parseAndBindStructuredResultOutcome(value, "scout", index))
      .toEqual({ kind: "invalid", category: "result_too_large" })
  })

  it("keeps unexpected internal exceptions generic and omits their messages", () => {
    const index = createObservedEvidenceIndex()
    Object.defineProperty(index.entries, "get", { value: () => { throw new Error("private normalization detail") } })
    const outcome = parseAndBindStructuredResultOutcome(JSON.stringify(scoutWithEvidence()), "scout", index)

    expect(outcome).toEqual({ kind: "invalid" })
    expect(JSON.stringify(outcome)).not.toContain("private normalization detail")
    expect(parseAndBindStructuredResult(JSON.stringify(scoutWithEvidence()), "scout", index)).toBeUndefined()
  })

  it("does not classify unexpected JSON parser exceptions as malformed output", () => {
    const parseSpy = vi.spyOn(JSON, "parse").mockImplementation(() => {
      throw new Error("private parser failure")
    })
    try {
      const value = JSON.stringify(emptyScoutResult())
      const outcome = parseAndBindStructuredResultOutcome(value, "scout", createObservedEvidenceIndex())

      expect(outcome).toEqual({ kind: "invalid" })
      expect(JSON.stringify(outcome)).not.toContain("private parser failure")
      expect(parseAndBindStructuredResult(value, "scout", createObservedEvidenceIndex())).toBeUndefined()
    } finally {
      parseSpy.mockRestore()
    }
  })
})
