import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"

import { createTaskGraphObservedReadEvidenceIndex, hydrateTaskGraphObservedReadEvidence,
  parseTaskGraphRestoredToolObservations, recordTaskGraphObservedReadObservation,
  recordTaskGraphObservedReadOutput } from "./task-graph-observed-read-evidence.js"
import { observedJobLocationProjection } from "./task-graph-observed-job-facts.js"

function restored(id: string, toolName: string, output: unknown, overrides: Record<string, unknown> = {}) {
  return { id, content: { toolCallId: `call-${id}`, toolName, input: {}, status: "completed", output, errorCode: null, ...overrides } }
}

const ref = "tool-result-12345678-1234-4234-9234-123456789abc"

function discoveryOutput() {
  return { jobs: [{ id: "c123456789012345678901234", title: "Engineer", company: "Example", location: "Dublin",
    url: "https://jobs.example/1", description: "Role", fullDescription: "Role details", salary: null, logo: null,
    source: "greenhouse", evidenceRefs: ["source-1"] }],
  evidence: [{ evidenceId: "source-1", jobId: "c123456789012345678901234", kind: "source", source: "greenhouse",
    url: "https://jobs.example/1", summary: "Listing" }], nextCursor: null,
  usage: { ledgerKey: "ledger-1", toolName: "jobs.discover", toolVersion: "1", toolCallId: "call-discover",
    sessionId: "session-1", turnId: "turn-1", stepId: "step-1", requests: 1, jobsProcessed: 1,
    jobsSucceeded: 1, jobsFailed: 0, aiCalls: 0, providers: ["greenhouse"], estimatedCostUsd: 0, durationMs: 1 } }
}

describe("TaskGraph observed read evidence index", () => {
  it("indexes all successful canonical reads, including uncited observations, and ignores failures", () => {
    const index = createTaskGraphObservedReadEvidenceIndex()
    const observations = [restored("search", "jobs.search", { jobs: [{ id: "job-a", source: "greenhouse", location: "Dublin" }] }),
      restored("get", "jobs.get", { job: { id: "job-b" } }),
      restored("failed", "persona.retrieve", { facts: [{ id: "fact-a" }] }, { status: "failed", errorCode: "unavailable" })]
    hydrateTaskGraphObservedReadEvidence(index, observations)
    expect([...index.entries.values()].map(entry => entry.id)).toEqual(["read:job:job-a", "read:job:job-b"])
    expect(index.jobFacts.facts.has("job-a")).toBe(true)
  })

  it("rebuilds an observed discovery from durable chunks", () => {
    const output = discoveryOutput(), bytes = Buffer.from(JSON.stringify(output), "utf8")
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const observations = [restored("discover", "jobs.discover", { $ref: ref, sizeBytes: bytes.length, sha256 }),
      restored("chunk", "tool_results.read", { ref, sha256, byteCount: bytes.length, chunk: bytes.toString("utf8"), nextCursor: null },
        { input: { referenceId: ref } })]
    const index = createTaskGraphObservedReadEvidenceIndex()
    hydrateTaskGraphObservedReadEvidence(index, observations)
    expect([...index.entries.values()].map(entry => entry.id)).toContain("read:job:c123456789012345678901234")
    expect(index.discoveryEntries.size).toBe(1)
  })

  it("rejects conflicting duplicate facts and malformed restored tool names", () => {
    const index = createTaskGraphObservedReadEvidenceIndex()
    expect(() => hydrateTaskGraphObservedReadEvidence(index, [
      restored("one", "jobs.search", { jobs: [{ id: "job-a", source: "greenhouse" }] }),
      restored("two", "jobs.get", { job: { id: "job-a", source: "lever" } }),
    ])).toThrow("child_resume_evidence_conflict")
    expect(() => parseTaskGraphRestoredToolObservations([restored("bad", "jobs.query", {})]))
      .toThrow("child_resume_evidence_invalid")
  })

  it("deduplicates repeated equal evidence IDs without losing the original entry", () => {
    const index = createTaskGraphObservedReadEvidenceIndex()
    recordTaskGraphObservedReadOutput(index, "jobs.search", { jobs: [
      { id: "job-repeat", source: "greenhouse" }, { id: "job-repeat", source: "greenhouse" },
    ] })
    expect([...index.entries.values()]).toEqual([{ id: "read:job:job-repeat", kind: "job", ref: "job-repeat", source: "greenhouse" }])
    expect(index.conflicts.size).toBe(0)
  })

  it("invalidates the Job location fact when completed discovery evidence conflicts", () => {
    const index = createTaskGraphObservedReadEvidenceIndex(), output = discoveryOutput()
    const bytes = Buffer.from(JSON.stringify(output), "utf8"), sha256 = createHash("sha256").update(bytes).digest("hex")
    recordTaskGraphObservedReadOutput(index, "jobs.get", { job: { id: "c123456789012345678901234", source: "greenhouse", location: "Dublin" } })
    recordTaskGraphObservedReadOutput(index, "jobs.discover", { $ref: ref, sizeBytes: bytes.length, sha256 })
    recordTaskGraphObservedReadOutput(index, "tool_results.read", { ref, sha256, byteCount: bytes.length,
      chunk: bytes.toString("utf8"), nextCursor: null }, { referenceId: ref })
    recordTaskGraphObservedReadOutput(index, "jobs.discover", { $ref: ref, sizeBytes: bytes.length + 1, sha256 })

    expect(index.entries.has("job\u0000c123456789012345678901234")).toBe(false)
    expect(observedJobLocationProjection(index.jobFacts, "c123456789012345678901234")).toEqual({
      observedLocation: null, locationEvidenceStatus: "conflicting",
    })
  })

  it("uses the shared single-record path for successful live reads", () => {
    const index = createTaskGraphObservedReadEvidenceIndex()
    const observations = parseTaskGraphRestoredToolObservations([restored("live", "jobs.get", { job: { id: "job-live" } })])
    expect(recordTaskGraphObservedReadObservation(index, observations[0]!, observations, 0)).toBe(true)
    expect(recordTaskGraphObservedReadOutput(index, "cover_letter.draft", {})).toBe(false)
    expect([...index.entries.values()].map(entry => entry.id)).toEqual(["read:job:job-live"])
  })
})
