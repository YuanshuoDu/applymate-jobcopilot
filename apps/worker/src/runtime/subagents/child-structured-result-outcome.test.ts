import { Buffer } from "node:buffer"
import { describe, expect, it, vi } from "vitest"
import { redactSensitiveValue } from "@jobcopilot/shared"

import { createObservedEvidenceIndex, parseAndBindStructuredResult, recordReadToolOutput } from "./child-evidence.js"
import { MAX_EVIDENCE_BYTES, parseAndBindStructuredResultOutcome, scheduledPrepareToolReceiptKey } from "./child-structured-result-outcome.js"
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

function scheduledPrepareResult(snapshotDigest = `sha256:${"a".repeat(64)}`, contentHash = `sha256:${"c".repeat(64)}`, taskId = "prepare-task-1") {
  return {
    schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare" as const, status: "completed" as const,
    taskId, attemptCount: 2,
    snapshotDigest, checkpointDigest: "b".repeat(64),
    jobs: [{ jobId: "job-1", status: "prepared" as const }],
    materials: [{ jobId: "job-1", kind: "resume" as const, artifactRef: {
      artifactId: "resume-1", version: 2, contentHash, sourceDigest: `sha256:${"d".repeat(64)}`,
    } }],
  }
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseObjectKeys(entry)]))
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

  it("requires the successful registered Prepare tool receipt instead of generic Analyst evidence", () => {
    const index = createObservedEvidenceIndex()
    recordReadToolOutput(index, "jobs.get", { job: { id: "job-1", source: "greenhouse" } })
    const result = scheduledPrepareResult()

    expect(parseAndBindStructuredResultOutcome(JSON.stringify(result), "prepare", index))
      .toEqual({ kind: "invalid", category: "evidence_binding_invalid" })
  })

  it("accepts only the Prepare result that exactly matches its successful registered tool receipt", () => {
    const receipt = scheduledPrepareResult()
    const index = createObservedEvidenceIndex()
    recordReadToolOutput(index, "scheduled.application.prepare", receipt, {}, {
      toolCallId: "prepare-call-1", taskId: "prepare-task-1", attemptCount: 2,
    })

    expect(parseAndBindStructuredResultOutcome(JSON.stringify(receipt), "prepare", index))
      .toEqual({ kind: "valid", result: receipt })
    expect(parseAndBindStructuredResultOutcome(JSON.stringify(scheduledPrepareResult(`sha256:${"e".repeat(64)}`)), "prepare", index))
      .toEqual({ kind: "invalid", category: "evidence_binding_invalid" })
    expect(index.scheduledPrepareResults.get("prepare-task-1\u00002")?.toolCallId).toBe("prepare-call-1")
    expect(index.artifactResults.has(scheduledPrepareToolReceiptKey(receipt))).toBe(false)
  })

  it("rebinds only the exact lifecycle-redacted projection of its registered Prepare receipt", () => {
    const taskId = "12345678-1234-1234-1234-123456789012"
    const receipt = scheduledPrepareResult(undefined, `sha256:${"12345678"}${"a".repeat(56)}`, taskId)
    const index = createObservedEvidenceIndex()
    recordReadToolOutput(index, "scheduled.application.prepare", receipt, {}, {
      toolCallId: "prepare-call-1", taskId, attemptCount: 2,
    })
    const modelVisible = redactSensitiveValue(receipt)
    expect(modelVisible).toEqual({
      ...receipt, taskId: "[REDACTED_PHONE]",
      materials: [{ ...receipt.materials[0], artifactRef: { ...receipt.materials[0]!.artifactRef, contentHash: "[REDACTED]" } }],
    })

    expect(parseAndBindStructuredResultOutcome(JSON.stringify(modelVisible), "prepare", index))
      .toEqual({ kind: "valid", result: receipt })

    const reorderedModelVisible = reverseObjectKeys(modelVisible)
    expect(JSON.stringify(reorderedModelVisible)).not.toBe(JSON.stringify(modelVisible))
    expect(parseAndBindStructuredResultOutcome(JSON.stringify(reorderedModelVisible), "prepare", index))
      .toEqual({ kind: "valid", result: receipt })

    const tampered = JSON.parse(JSON.stringify(modelVisible)) as { snapshotDigest: string }
    tampered.snapshotDigest = `sha256:${"f".repeat(64)}`
    expect(parseAndBindStructuredResultOutcome(JSON.stringify(tampered), "prepare", index))
      .toEqual({ kind: "invalid", category: "result_shape_invalid" })
    expect(index.scheduledPrepareResults.get(`${taskId}\u00002`)?.toolCallId).toBe("prepare-call-1")

    const otherTaskId = "87654321-4321-4321-4321-210987654321"
    const otherReceipt = scheduledPrepareResult(undefined, receipt.materials[0]!.artifactRef.contentHash, otherTaskId)
    const ambiguousIndex = createObservedEvidenceIndex()
    recordReadToolOutput(ambiguousIndex, "scheduled.application.prepare", receipt, {}, { toolCallId: "first-call", taskId, attemptCount: 2 })
    recordReadToolOutput(ambiguousIndex, "scheduled.application.prepare", otherReceipt, {}, { toolCallId: "second-call", taskId: otherTaskId, attemptCount: 2 })
    expect(redactSensitiveValue(otherReceipt)).toEqual(modelVisible)
    expect(parseAndBindStructuredResultOutcome(JSON.stringify(modelVisible), "prepare", ambiguousIndex).kind).toBe("invalid")
  })

  it("fails closed when the registered call identity does not match its tool output", () => {
    const receipt = scheduledPrepareResult(), index = createObservedEvidenceIndex()
    recordReadToolOutput(index, "scheduled.application.prepare", receipt, {}, {
      toolCallId: "prepare-call-1", taskId: "prepare-task-1", attemptCount: 1,
    })
    expect(parseAndBindStructuredResultOutcome(JSON.stringify(receipt), "prepare", index))
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
