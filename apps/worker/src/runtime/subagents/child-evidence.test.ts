import { describe, expect, it } from "vitest"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"

import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { createObservedEvidenceIndex, hydrateObservedEvidence, parseAndBindStructuredResult, recordReadToolOutput } from "./child-evidence.js"
import { redactJobReadOutput } from "../tools/job-read-output-redaction.js"

function scoutResult(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
    candidates: [{ jobId: "job-1", source: "greenhouse", url: null, evidenceIds: ["model-job"] }],
    evidence: [{ id: "model-job", kind: "job", ref: "job-1", source: "model" }], summary: "one job", ...overrides,
  }
}

function emptyScoutResult() {
  return { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed", candidates: [], evidence: [], summary: "no jobs" }
}

function writerResult(version: number, contentDigest: string, sourceDigest = "b") {
  return {
    schemaVersion: ROLE_RESULT_SCHEMA,
    role: "writer",
    status: "completed",
    artifactRef: {
      artifactId: "cover-letter-1",
      version,
      contentHash: `sha256:${contentDigest.repeat(64)}`,
      sourceDigest: `sha256:${sourceDigest.repeat(64)}`,
    },
  }
}

function reviewerResult(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: ROLE_RESULT_SCHEMA,
    role: "reviewer",
    status: "completed",
    artifactRef: {
      artifactId: "cover-letter-1",
      version: 2,
      contentHash: `sha256:${"a".repeat(64)}`,
      sourceDigest: `sha256:${"b".repeat(64)}`,
    },
    reviewStatus: "passed",
    reviewHash: `sha256:${"c".repeat(64)}`,
    ...overrides,
  }
}

function recordWriterResult(index: ReturnType<typeof createObservedEvidenceIndex>, result: ReturnType<typeof writerResult>) {
  recordReadToolOutput(index, "cover_letter.draft", { artifactRef: result.artifactRef })
}

function entry(index: ReturnType<typeof createObservedEvidenceIndex>, kind: string, ref: string) {
  return index.entries.get(`${kind}\u0000${ref}`)
}

function restored(id: string, toolName: string, output: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id,
    content: { toolCallId: `call-${id}`, toolName, input: {}, status: "completed", output, errorCode: null, ...overrides },
  }
}

const DURABLE_DISCOVERY_REF = "tool-result-12345678-1234-4234-9234-123456789abc"
const DISCOVERED_JOB_ID = "c123456789012345678901234"

function durableDiscoveryObservations(providedOutput?: unknown, reference = DURABLE_DISCOVERY_REF) {
  const output = providedOutput ?? {
    jobs: [{
      id: DISCOVERED_JOB_ID, title: "Engineer", company: "Example", location: "Dublin", url: "https://jobs.example/1",
      description: "x".repeat(30_000), fullDescription: "x", salary: null, logo: null, source: "greenhouse", evidenceRefs: ["source-evidence"],
    }],
    evidence: [{ evidenceId: "source-evidence", jobId: DISCOVERED_JOB_ID, kind: "source", source: "greenhouse", url: "https://jobs.example/1", summary: "Source listing" }],
    nextCursor: null,
    usage: {
      ledgerKey: "ledger-1", toolName: "jobs.discover", toolVersion: "1", toolCallId: "call-discover", sessionId: "session-1",
      turnId: "turn-1", stepId: "step-1", requests: 1, jobsProcessed: 1, jobsSucceeded: 1, jobsFailed: 0,
      providerFailures: 0, aiCalls: 0, providers: ["greenhouse"], estimatedCostUsd: 0, durationMs: 10,
    },
  }
  const serialized = JSON.stringify(output)
  if (serialized === undefined) throw new Error("test_discovery_output_not_serializable")
  const bytes = Buffer.from(serialized, "utf8")
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const observations = [restored("discover", "jobs.discover", { $ref: reference, sizeBytes: bytes.length, sha256 })]
  for (let offset = 0; offset < bytes.length;) {
    let end = Math.min(offset + 4096, bytes.length)
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1
    const chunk = bytes.subarray(offset, end).toString("utf8")
    observations.push(restored(`read-${offset}`, "tool_results.read", {
      ref: reference, sha256, byteCount: bytes.length, chunk, nextCursor: end === bytes.length ? null : String(end),
    }, { input: { referenceId: reference, ...(offset === 0 ? {} : { cursor: String(offset) }) } }))
    offset = end
  }
  return { bytes, observations, output }
}

function recordLiveDiscovery(index: ReturnType<typeof createObservedEvidenceIndex>, observations: ReturnType<typeof durableDiscoveryObservations>["observations"], readCount = observations.length - 1) {
  const discovery = observations[0]!.content as Record<string, unknown>
  recordReadToolOutput(index, "jobs.discover", discovery.output)
  for (const observation of observations.slice(1, readCount + 1)) {
    const content = observation.content as Record<string, unknown>
    recordReadToolOutput(index, "tool_results.read", content.output)
  }
}

function providerDiscoveryOutput(count: number, offset = 0) {
  const jobs = Array.from({ length: count }, (_, index) => {
    const number = offset + index + 1
    const evidenceId = `source-${number}`
    return {
      id: `c${number.toString(36).padStart(24, "0")}`, title: "Engineer", company: "Example", location: "Dublin",
      url: `https://jobs.example/${number}`, description: "Job listing", fullDescription: "Full job description",
      salary: null, logo: null, source: "greenhouse", evidenceRefs: [evidenceId],
    }
  })
  return {
    jobs,
    evidence: jobs.map(job => ({
      evidenceId: job.evidenceRefs[0], jobId: job.id, kind: "source", source: "greenhouse", url: job.url, summary: "Source listing",
    })),
    nextCursor: null,
    usage: {
      ledgerKey: "ledger-discover", toolName: "jobs.discover", toolVersion: "1", toolCallId: "call-discover",
      sessionId: "session-1", turnId: "turn-1", stepId: "step-1", requests: 1, jobsProcessed: count,
      jobsSucceeded: count, jobsFailed: 0, providerFailures: 0, aiCalls: 0, providers: ["greenhouse"], estimatedCostUsd: 0, durationMs: 1,
    },
  }
}

function ordinaryJobSearchOutput() {
  return { jobs: Array.from({ length: 50 }, (_, number) => ({ id: `ordinary-job-${number}`, source: "jobs.search" })) }
}

describe("child evidence binding", () => {
  it("records canonical job, persona, and resume evidence with source fallbacks", () => {
    const index = createObservedEvidenceIndex()
    recordReadToolOutput(index, "jobs.search", { jobs: [{ id: "job-1", source: null }, {}, null, { id: "job-2", source: "lever" }] })
    recordReadToolOutput(index, "persona.retrieve", { facts: [{ id: "fact-1", source: "persona-db" }, { id: "fact-2", source: "" }, null] })
    recordReadToolOutput(index, "resume.get_base", { resume: { id: "resume-1" } })

    expect(entry(index, "job", "job-1")).toEqual({ id: "read:job:job-1", kind: "job", ref: "job-1", source: "jobs.read" })
    expect(entry(index, "job", "job-2")).toEqual({ id: "read:job:job-2", kind: "job", ref: "job-2", source: "lever" })
    expect(entry(index, "persona", "fact-1")).toEqual({ id: "read:persona:fact-1", kind: "persona", ref: "fact-1", source: "persona-db" })
    expect(entry(index, "persona", "fact-2")).toEqual({ id: "read:persona:fact-2", kind: "persona", ref: "fact-2", source: "persona.retrieve" })
    expect(entry(index, "resume", "resume-1")).toEqual({ id: "read:resume:resume-1", kind: "resume", ref: "resume-1", source: "resume.get_base" })
    expect(index.entries.size).toBe(5)
  })

  it("binds provider discovery jobs to canonical evidence and restores that evidence", () => {
    const jobId = "c123456789012345678901234"
    const output = {
      jobs: [{
        id: jobId, title: "Engineer", company: "Example", location: "Dublin", url: "https://jobs.example/1",
        description: "Job listing", fullDescription: "Full job description", salary: null, logo: null,
        source: "greenhouse", evidenceRefs: ["evidence-source-1"],
      }],
      evidence: [{
        evidenceId: "evidence-source-1", jobId, kind: "source", source: "greenhouse",
        url: "https://jobs.example/1", summary: "Source listing",
      }],
      nextCursor: null,
      usage: {
        ledgerKey: "ledger-discover", toolName: "jobs.discover", toolVersion: "1", toolCallId: "call-discover",
        sessionId: "session-1", turnId: "turn-1", stepId: "step-1", requests: 1,
        jobsProcessed: 1, jobsSucceeded: 1, jobsFailed: 0, providerFailures: 0, aiCalls: 0,
        providers: ["greenhouse"], estimatedCostUsd: 0, durationMs: 1,
      },
    }
    const index = createObservedEvidenceIndex()
    const safeOutput = redactJobReadOutput("jobs.discover", output)
    expect(safeOutput).not.toBe("[REDACTED]")
    recordReadToolOutput(index, "jobs.discover", safeOutput)
    expect(entry(index, "job", jobId)).toEqual({ id: `read:job:${jobId}`, kind: "job", ref: jobId, source: "greenhouse" })
    expect(parseAndBindStructuredResult(JSON.stringify(scoutResult({
      candidates: [{ jobId, source: "greenhouse", url: null, evidenceIds: ["model-job"] }],
      evidence: [{ id: "model-job", kind: "job", ref: jobId, source: "model" }],
    })), "scout", index)).toMatchObject({
      candidates: [{ jobId, evidenceIds: [`read:job:${jobId}`] }],
      evidence: [{ id: `read:job:${jobId}`, ref: jobId, source: "greenhouse" }],
    })

    const restoredIndex = createObservedEvidenceIndex()
    hydrateObservedEvidence(restoredIndex, [restored("discover", "jobs.discover", safeOutput)])
    expect(entry(restoredIndex, "job", jobId)).toEqual({ id: `read:job:${jobId}`, kind: "job", ref: jobId, source: "greenhouse" })
  })

  it("restores oversized jobs.discover output from verified durable chunks and binds its evidence", () => {
    const { bytes, observations } = durableDiscoveryObservations()
    expect(bytes.byteLength).toBeGreaterThan(16 * 1024)
    const index = createObservedEvidenceIndex()
    hydrateObservedEvidence(index, observations)

    expect(entry(index, "job", DISCOVERED_JOB_ID)).toEqual({
      id: `read:job:${DISCOVERED_JOB_ID}`, kind: "job", ref: DISCOVERED_JOB_ID, source: "greenhouse",
    })
    expect(parseAndBindStructuredResult(JSON.stringify(scoutResult({
      candidates: [{ jobId: DISCOVERED_JOB_ID, source: "greenhouse", url: "https://jobs.example/1", evidenceIds: ["model-job"] }],
      evidence: [{ id: "model-job", kind: "job", ref: DISCOVERED_JOB_ID, source: "model" }],
    })), "scout", index)).toMatchObject({
      candidates: [{ jobId: DISCOVERED_JOB_ID, evidenceIds: [`read:job:${DISCOVERED_JOB_ID}`] }],
      evidence: [{ id: `read:job:${DISCOVERED_JOB_ID}`, ref: DISCOVERED_JOB_ID, source: "greenhouse" }],
    })
  })

  it("rehydrates a safe projection from durable chunks after restart and rejects a source conflict", () => {
    const rawOutput = durableDiscoveryObservations().output
    const safeOutput = redactJobReadOutput("jobs.discover", rawOutput)
    expect(safeOutput).not.toBe("[REDACTED]")
    const { observations } = durableDiscoveryObservations(safeOutput)

    const index = createObservedEvidenceIndex()
    hydrateObservedEvidence(index, observations)
    expect(entry(index, "job", DISCOVERED_JOB_ID)).toEqual({
      id: `read:job:${DISCOVERED_JOB_ID}`, kind: "job", ref: DISCOVERED_JOB_ID, source: "greenhouse",
    })

    const conflictingIndex = createObservedEvidenceIndex()
    recordReadToolOutput(conflictingIndex, "jobs.search", { jobs: [{ id: DISCOVERED_JOB_ID, source: "lever" }] })
    expect(() => hydrateObservedEvidence(conflictingIndex, observations)).toThrow("child_resume_evidence_conflict")
    expect(entry(conflictingIndex, "job", DISCOVERED_JOB_ID)).toBeUndefined()
    expect(conflictingIndex.conflicts.has(`job\u0000${DISCOVERED_JOB_ID}`)).toBe(true)
  })

  it("restores a 64 KiB jobs.discover result after 50 ordinary observations within resume limits", () => {
    const output = providerDiscoveryOutput(1)
    const target = output.jobs[0]!
    const originalBytes = Buffer.byteLength(JSON.stringify(output), "utf8")
    target.description = "x".repeat(target.description.length + 64 * 1024 - originalBytes)
    const { bytes, observations } = durableDiscoveryObservations(output)
    const ordinaryObservations = Array.from({ length: 50 }, (_, number) => restored(`ordinary-${number}`, "jobs.search", {
      jobs: [{ id: `ordinary-job-${number}`, source: "jobs.search" }],
    }))
    const restoredObservations = [...ordinaryObservations, ...observations]

    expect(bytes.byteLength).toBe(64 * 1024)
    expect(observations).toHaveLength(17)
    expect(observations.slice(1).every(observation => {
      const content = observation.content as Record<string, unknown>
      const chunk = (content.output as Record<string, unknown>).chunk
      return Buffer.byteLength(chunk as string, "utf8") === 4096
    })).toBe(true)
    expect(restoredObservations.length).toBeLessThanOrEqual(256)
    expect(Buffer.byteLength(JSON.stringify(restoredObservations), "utf8")).toBeLessThanOrEqual(256 * 1024)
    expect(restoredObservations.every(observation => Buffer.byteLength(JSON.stringify(observation.content), "utf8") <= 8 * 1024)).toBe(true)

    const index = createObservedEvidenceIndex()
    hydrateObservedEvidence(index, restoredObservations)

    expect(index.entries.size).toBe(51)
    expect(entry(index, "job", "ordinary-job-49")).toEqual({
      id: "read:job:ordinary-job-49", kind: "job", ref: "ordinary-job-49", source: "jobs.search",
    })
    expect(entry(index, "job", target.id)).toEqual({
      id: `read:job:${target.id}`, kind: "job", ref: target.id, source: "greenhouse",
    })
    expect(index.discoveryEntries.has(`job\u0000${target.id}`)).toBe(true)
  })

  it("keeps a full jobs.discover page classifiable after ordinary evidence fills the index", () => {
    const output = providerDiscoveryOutput(50)
    const index = createObservedEvidenceIndex()
    recordReadToolOutput(index, "jobs.search", ordinaryJobSearchOutput())
    recordReadToolOutput(index, "jobs.discover", output)
    const target = output.jobs[49]!

    expect(index.entries.size).toBe(100)
    expect(entry(index, "job", target.id)).toEqual({ id: `read:job:${target.id}`, kind: "job", ref: target.id, source: "greenhouse" })
    expect(parseAndBindStructuredResult(JSON.stringify(scoutResult({
      candidates: [{ jobId: target.id, source: "greenhouse", url: target.url, evidenceIds: ["model-job"] }],
      evidence: [{ id: "model-job", kind: "job", ref: target.id, source: "model" }],
    })), "scout", index)).toMatchObject({ candidates: [{ jobId: target.id, evidenceIds: [`read:job:${target.id}`] }] })
  })

  it("restores a full jobs.discover page after ordinary evidence fills the index", () => {
    const output = providerDiscoveryOutput(50)
    const { observations } = durableDiscoveryObservations(output)
    const index = createObservedEvidenceIndex()
    hydrateObservedEvidence(index, [restored("search", "jobs.search", ordinaryJobSearchOutput()), ...observations])
    const target = output.jobs[49]!

    expect(index.entries.size).toBe(100)
    expect(entry(index, "job", target.id)).toEqual({ id: `read:job:${target.id}`, kind: "job", ref: target.id, source: "greenhouse" })
    expect(parseAndBindStructuredResult(JSON.stringify(scoutResult({
      candidates: [{ jobId: target.id, source: "greenhouse", url: target.url, evidenceIds: ["model-job"] }],
      evidence: [{ id: "model-job", kind: "job", ref: target.id, source: "model" }],
    })), "scout", index)).toMatchObject({ candidates: [{ jobId: target.id, evidenceIds: [`read:job:${target.id}`] }] })
  })

  it("keeps discovery evidence unchanged when a multi-job page exceeds its bounded allowance", () => {
    const index = createObservedEvidenceIndex()
    recordReadToolOutput(index, "jobs.discover", providerDiscoveryOutput(48))
    recordReadToolOutput(index, "jobs.search", { jobs: [{ id: "conflicted-job", source: "greenhouse" }] })
    recordReadToolOutput(index, "jobs.get", { job: { id: "conflicted-job", source: "lever" } })
    const beforeEntries = new Map(index.entries)
    const beforeDiscoveryEntries = new Set(index.discoveryEntries)
    const beforeConflicts = new Set(index.conflicts)
    const overflow = providerDiscoveryOutput(5, 48)

    expect(() => recordReadToolOutput(index, "jobs.discover", overflow)).toThrow("child_discovery_evidence_limit")
    expect(index.entries).toEqual(beforeEntries)
    expect(index.discoveryEntries).toEqual(beforeDiscoveryEntries)
    expect(index.conflicts).toEqual(beforeConflicts)
    for (const job of overflow.jobs) expect(entry(index, "job", job.id)).toBeUndefined()
  })

  it("does not index incomplete jobs.discover output as evidence", () => {
    const output = providerDiscoveryOutput(1)
    output.evidence = []
    const index = createObservedEvidenceIndex()

    recordReadToolOutput(index, "jobs.discover", output)

    expect(index.entries.size).toBe(0)
    expect(parseAndBindStructuredResult(JSON.stringify(scoutResult({
      candidates: [{ jobId: output.jobs[0]!.id, source: "greenhouse", url: output.jobs[0]!.url, evidenceIds: ["model-job"] }],
      evidence: [{ id: "model-job", kind: "job", ref: output.jobs[0]!.id, source: "model" }],
    })), "scout", index)).toBeUndefined()
  })

  it.each(["incomplete", "mismatched checksum", "whole checksum mismatch", "byte count mismatch", "unrelated reference"])("rejects %s durable discovery chunks", kind => {
    const { observations } = durableDiscoveryObservations()
    if (kind === "incomplete") observations.splice(observations.length - 2, 1)
    if (kind === "mismatched checksum") {
      const chunk = observations[1]!
      const content = chunk.content as Record<string, unknown>
      content.output = { ...(content.output as Record<string, unknown>), sha256: "f".repeat(64) }
    }
    if (kind === "whole checksum mismatch") {
      const chunk = observations[1]!
      const content = chunk.content as Record<string, unknown>
      const output = content.output as Record<string, unknown>
      output.chunk = `y${(output.chunk as string).slice(1)}`
    }
    if (kind === "byte count mismatch") {
      const chunk = observations[1]!
      const content = chunk.content as Record<string, unknown>
      content.output = { ...(content.output as Record<string, unknown>), byteCount: 1 }
    }
    if (kind === "unrelated reference") {
      const chunk = observations[1]!
      const content = chunk.content as Record<string, unknown>
      content.input = { referenceId: "tool-result-87654321-4321-4321-8321-cba987654321" }
    }
    expect(() => hydrateObservedEvidence(createObservedEvidenceIndex(), observations)).toThrow()
  })

  it("treats replay of the same durable discovery bundle as idempotent", () => {
    const { observations } = durableDiscoveryObservations()
    const index = createObservedEvidenceIndex()
    hydrateObservedEvidence(index, [...observations, ...observations])

    expect(entry(index, "job", DISCOVERED_JOB_ID)).toEqual({
      id: `read:job:${DISCOVERED_JOB_ID}`, kind: "job", ref: DISCOVERED_JOB_ID, source: "greenhouse",
    })
    expect(index.conflicts.size).toBe(0)
  })

  it("ignores a failed durable read when a later successful retry completes hydration", () => {
    const { observations } = durableDiscoveryObservations()
    const failedRead = restored("read-failed", "tool_results.read", null, {
      input: { referenceId: DURABLE_DISCOVERY_REF }, status: "failed", errorCode: "tool_result_unavailable",
    })
    const index = createObservedEvidenceIndex()

    hydrateObservedEvidence(index, [observations[0]!, failedRead, ...observations.slice(1)])

    expect(entry(index, "job", DISCOVERED_JOB_ID)).toEqual({
      id: `read:job:${DISCOVERED_JOB_ID}`, kind: "job", ref: DISCOVERED_JOB_ID, source: "greenhouse",
    })
  })

  it("binds live durable discovery evidence only after the complete chunk chain is verified", () => {
    const { observations } = durableDiscoveryObservations()
    const index = createObservedEvidenceIndex()
    recordLiveDiscovery(index, observations, 0)
    expect(entry(index, "job", DISCOVERED_JOB_ID)).toBeUndefined()

    recordLiveDiscovery(index, observations, observations.length - 2)
    expect(entry(index, "job", DISCOVERED_JOB_ID)).toBeUndefined()
    expect(index.durableDiscoveryBytes).toBeLessThanOrEqual(256 * 1024)

    recordLiveDiscovery(index, observations)
    expect(entry(index, "job", DISCOVERED_JOB_ID)).toEqual({
      id: `read:job:${DISCOVERED_JOB_ID}`, kind: "job", ref: DISCOVERED_JOB_ID, source: "greenhouse",
    })
    expect(index.durableDiscoveryBytes).toBe(0)
    expect(index.durableDiscoveries.get(DURABLE_DISCOVERY_REF)?.bytesStored).toBe(0)
    expect(index.durableDiscoveries.get(DURABLE_DISCOVERY_REF)?.chunks.size).toBe(0)
  })

  it("keeps verified live discovery evidence after a valid empty EOF read", () => {
    const { observations, bytes } = durableDiscoveryObservations()
    const index = createObservedEvidenceIndex()
    recordLiveDiscovery(index, observations)
    const beforeEntries = new Map(index.entries)
    const eof = { ref: DURABLE_DISCOVERY_REF, sha256: createHash("sha256").update(bytes).digest("hex"), byteCount: bytes.length, chunk: "", nextCursor: null }

    recordReadToolOutput(index, "tool_results.read", eof)

    expect(index.entries).toEqual(beforeEntries)
    expect(index.conflicts.size).toBe(0)
    expect(entry(index, "job", DISCOVERED_JOB_ID)).toBeDefined()
  })

  it.each([
    ["premature EOF", null],
    ["empty nonterminal chunk", "1"],
  ] as const)("rejects invalid empty chunks before the discovery reference is verified (%s)", (_name, nextCursor) => {
    const { observations, bytes } = durableDiscoveryObservations()
    const index = createObservedEvidenceIndex()
    const discovery = observations[0]!.content as Record<string, unknown>
    recordReadToolOutput(index, "jobs.discover", discovery.output)

    recordReadToolOutput(index, "tool_results.read", {
      ref: DURABLE_DISCOVERY_REF, sha256: createHash("sha256").update(bytes).digest("hex"), byteCount: bytes.length, chunk: "", nextCursor,
    })

    expect(entry(index, "job", DISCOVERED_JOB_ID)).toBeUndefined()
    expect(index.durableDiscoveryBytes).toBe(0)
  })

  it("derives live chunk offsets from UTF-8 byte lengths", () => {
    const output = providerDiscoveryOutput(1)
    output.jobs[0]!.description = `Dublin 🚀 ${"x".repeat(30_000)}`
    const { observations } = durableDiscoveryObservations(output)
    const index = createObservedEvidenceIndex()
    recordLiveDiscovery(index, observations)

    expect(entry(index, "job", output.jobs[0]!.id)).toEqual({
      id: `read:job:${output.jobs[0]!.id}`, kind: "job", ref: output.jobs[0]!.id, source: "greenhouse",
    })
    expect(index.durableDiscoveryBytes).toBe(0)
  })

  it("accepts one valid durable discovery result above 256 KiB and up to 1 MiB", () => {
    const output = providerDiscoveryOutput(12)
    for (const job of output.jobs) job.description = "x".repeat(80_000)
    const { observations, bytes } = durableDiscoveryObservations(output)
    const index = createObservedEvidenceIndex()

    expect(bytes.byteLength).toBeGreaterThan(256 * 1024)
    expect(bytes.byteLength).toBeLessThanOrEqual(1024 * 1024)
    recordLiveDiscovery(index, observations)

    for (const job of output.jobs) expect(entry(index, "job", job.id)).toBeDefined()
    expect(index.durableDiscoveryBytes).toBe(0)
  })

  it("releases completed chunks across several sequential full discovery pages", () => {
    const index = createObservedEvidenceIndex()
    const references: string[] = []
    let totalPageBytes = 0

    for (let page = 0; page < 18; page += 1) {
      const output = providerDiscoveryOutput(1, page)
      output.jobs[0]!.description = "x".repeat(60_000)
      output.jobs[0]!.fullDescription = "y".repeat(1_000)
      const reference = `tool-result-12345678-1234-4234-9234-${(page + 1).toString(16).padStart(12, "0")}`
      const { observations, bytes } = durableDiscoveryObservations(output, reference)
      references.push(reference)
      totalPageBytes += bytes.byteLength

      expect(bytes.byteLength).toBeGreaterThan(60_000)
      recordLiveDiscovery(index, observations)

      expect(entry(index, "job", output.jobs[0]!.id)).toBeDefined()
      expect(index.durableDiscoveryBytes).toBe(0)
      expect(index.durableDiscoveries.get(reference)?.bytesStored).toBe(0)
      expect(index.durableDiscoveries.get(reference)?.chunks.size).toBe(0)
    }

    expect(totalPageBytes).toBeGreaterThan(1024 * 1024)
    expect(references).toHaveLength(18)
    expect(index.durableDiscoveries.size).toBe(18)
    expect(index.entries.size).toBe(18)
  })

  it("accepts identical live chunk replay and revokes evidence after a conflicting duplicate", () => {
    const { observations } = durableDiscoveryObservations()
    const index = createObservedEvidenceIndex()
    recordLiveDiscovery(index, observations)
    const beforeReplay = new Map(index.entries)
    recordLiveDiscovery(index, observations)
    expect(index.entries).toEqual(beforeReplay)
    expect(index.conflicts.size).toBe(0)

    const firstRead = observations[1]!.content as Record<string, unknown>
    const firstOutput = firstRead.output as Record<string, unknown>
    recordReadToolOutput(index, "tool_results.read", { ...firstOutput, chunk: `!${(firstOutput.chunk as string).slice(1)}` })
    expect(entry(index, "job", DISCOVERED_JOB_ID)).toBeUndefined()
    expect(index.conflicts.has(`job\u0000${DISCOVERED_JOB_ID}`)).toBe(true)
    expect(index.durableDiscoveryBytes).toBe(0)
  })

  it.each(["nonzero first offset", "chunk gap", "mismatched checksum", "mismatched byte count", "mismatched reference"])("does not bind live discovery evidence after a %s", kind => {
    const { observations } = durableDiscoveryObservations()
    const index = createObservedEvidenceIndex()
    recordLiveDiscovery(index, observations, 0)
    const first = observations[1]!.content as Record<string, unknown>
    const second = observations[2]!.content as Record<string, unknown>
    const third = observations[3]!.content as Record<string, unknown>
    if (kind === "nonzero first offset") recordReadToolOutput(index, "tool_results.read", second.output)
    if (kind === "chunk gap") {
      recordReadToolOutput(index, "tool_results.read", first.output)
      recordReadToolOutput(index, "tool_results.read", third.output)
    }
    if (kind === "mismatched checksum") {
      const output = first.output as Record<string, unknown>
      recordReadToolOutput(index, "tool_results.read", { ...output, sha256: "f".repeat(64) })
    }
    if (kind === "mismatched byte count") {
      const output = first.output as Record<string, unknown>
      recordReadToolOutput(index, "tool_results.read", { ...output, byteCount: 1 })
    }
    if (kind === "mismatched reference") {
      const output = first.output as Record<string, unknown>
      recordReadToolOutput(index, "tool_results.read", { ...output, ref: "tool-result-87654321-4321-4321-8321-cba987654321" })
    }
    expect(entry(index, "job", DISCOVERED_JOB_ID)).toBeUndefined()
    expect(index.durableDiscoveryBytes).toBe(0)
  })

  it("does not bind live discovery evidence when a valid chunk chain contains malformed JSON", () => {
    const reference = DURABLE_DISCOVERY_REF
    const bytes = Buffer.from("{not-json", "utf8")
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const index = createObservedEvidenceIndex()
    recordReadToolOutput(index, "jobs.discover", { $ref: reference, sizeBytes: bytes.length, sha256 })
    recordReadToolOutput(index, "tool_results.read", {
      ref: reference, sha256, byteCount: bytes.length, chunk: bytes.toString("utf8"), nextCursor: null,
    })

    expect(index.entries.size).toBe(0)
    expect(index.durableDiscoveryBytes).toBe(0)
  })

  it("bounds cumulative live chunk memory across pending discovery references", () => {
    const firstOutput = providerDiscoveryOutput(7)
    for (const job of firstOutput.jobs) job.description = "x".repeat(90_000)
    const secondOutput = providerDiscoveryOutput(7, 7)
    for (const job of secondOutput.jobs) job.description = "x".repeat(90_000)
    const first = durableDiscoveryObservations(firstOutput)
    const second = durableDiscoveryObservations(secondOutput, "tool-result-87654321-4321-4321-8321-cba987654321")
    const index = createObservedEvidenceIndex()
    recordLiveDiscovery(index, first.observations, first.observations.length - 2)
    const firstLastRead = first.observations[first.observations.length - 1]!.content as Record<string, unknown>
    const firstLastOutput = firstLastRead.output as Record<string, unknown>
    const firstPendingBytes = first.bytes.byteLength - Buffer.byteLength(firstLastOutput.chunk as string, "utf8")
    expect(index.durableDiscoveryBytes).toBe(firstPendingBytes)
    expect(entry(index, "job", firstOutput.jobs[0]!.id)).toBeUndefined()

    recordLiveDiscovery(index, second.observations)
    expect(index.durableDiscoveryBytes).toBe(firstPendingBytes)
    expect(index.durableDiscoveryBytes).toBeLessThanOrEqual(1024 * 1024)
    expect(entry(index, "job", secondOutput.jobs[0]!.id)).toBeUndefined()
  })

  it("rejects malformed and gapped durable chunk chains", () => {
    const malformed = durableDiscoveryObservations().observations
    const chunk = malformed[1]!
    const content = chunk.content as Record<string, unknown>
    content.output = { ...(content.output as Record<string, unknown>), nextCursor: "1" }
    expect(() => hydrateObservedEvidence(createObservedEvidenceIndex(), malformed)).toThrow("child_resume_evidence_invalid")

    const gapped = durableDiscoveryObservations().observations
    const second = gapped[2]!
    const secondContent = second.content as Record<string, unknown>
    secondContent.input = { referenceId: DURABLE_DISCOVERY_REF, cursor: "8192" }
    expect(() => hydrateObservedEvidence(createObservedEvidenceIndex(), gapped)).toThrow("child_resume_evidence_invalid")
  })

  it("fails closed when one observed reference has conflicting source records", () => {
    const index = createObservedEvidenceIndex()
    recordReadToolOutput(index, "jobs.search", { jobs: [{ id: "job-1", source: "greenhouse" }] })
    recordReadToolOutput(index, "jobs.get", { job: { id: "job-1", source: "lever" } })

    expect(entry(index, "job", "job-1")).toBeUndefined()
    expect(parseAndBindStructuredResult(JSON.stringify(scoutResult()), "scout", index)).toBeUndefined()
  })

  it("replaces model evidence IDs and sources with observed canonical records", () => {
    const index = createObservedEvidenceIndex()
    recordReadToolOutput(index, "jobs.search", { jobs: [{ id: "job-1", source: "greenhouse" }] })
    const result = parseAndBindStructuredResult(JSON.stringify(scoutResult()), "scout", index)

    expect(result).toMatchObject({
      evidence: [{ id: "read:job:job-1", kind: "job", ref: "job-1", source: "greenhouse" }],
      candidates: [{ jobId: "job-1", evidenceIds: ["read:job:job-1"] }],
    })
    expect(JSON.stringify(result)).toBe(JSON.stringify({
      schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
      candidates: [{ jobId: "job-1", source: "greenhouse", url: null, evidenceIds: ["read:job:job-1"] }],
      evidence: [{ id: "read:job:job-1", kind: "job", ref: "job-1", source: "greenhouse" }],
      summary: "one job",
    }))
  })

  it("rejects unknown and duplicate canonical evidence claims", () => {
    const index = createObservedEvidenceIndex()
    recordReadToolOutput(index, "jobs.search", { jobs: [{ id: "job-1", source: "greenhouse" }] })
    const unknown = scoutResult({ evidence: [{ id: "unknown", kind: "persona", ref: "fact-404", source: "model" }] })
    const duplicate = scoutResult({
      candidates: [{ jobId: "job-1", source: "greenhouse", url: null, evidenceIds: ["first", "second"] }],
      evidence: [
        { id: "first", kind: "job", ref: "job-1", source: "model" },
        { id: "second", kind: "job", ref: "job-1", source: "model" },
      ],
    })

    expect(parseAndBindStructuredResult(JSON.stringify(unknown), "scout", index)).toBeUndefined()
    expect(parseAndBindStructuredResult(JSON.stringify(duplicate), "scout", index)).toBeUndefined()
  })

  it("accepts an empty result without any observed evidence", () => {
    expect(parseAndBindStructuredResult(JSON.stringify(emptyScoutResult()), "scout", createObservedEvidenceIndex())).toEqual(emptyScoutResult())
  })

  it("accepts only the highest writer artifact version observed by the task", () => {
    const index = createObservedEvidenceIndex()
    const v1 = writerResult(1, "1")
    const v2 = writerResult(2, "2")
    recordWriterResult(index, v1)
    recordWriterResult(index, v2)

    expect(parseAndBindStructuredResult(JSON.stringify(v1), "writer", index)).toBeUndefined()
    expect(parseAndBindStructuredResult(JSON.stringify(v2), "writer", index)).toEqual(v2)
  })

  it("selects the highest writer version when restored receipts arrive out of order", () => {
    const index = createObservedEvidenceIndex()
    const v1 = writerResult(1, "1")
    const v2 = writerResult(2, "2")
    hydrateObservedEvidence(index, [
      restored("v2", "cover_letter.draft", { artifactRef: v2.artifactRef }),
      restored("v1", "cover_letter.draft", { artifactRef: v1.artifactRef }),
    ])

    expect(parseAndBindStructuredResult(JSON.stringify(v1), "writer", index)).toBeUndefined()
    expect(parseAndBindStructuredResult(JSON.stringify(v2), "writer", index)).toEqual(v2)
  })

  it("treats replay of the same restored writer receipt as idempotent", () => {
    const index = createObservedEvidenceIndex()
    const result = writerResult(1, "1")
    const receipt = restored("v1", "cover_letter.draft", { artifactRef: result.artifactRef })
    hydrateObservedEvidence(index, [receipt, receipt])

    expect(parseAndBindStructuredResult(JSON.stringify(result), "writer", index)).toEqual(result)
  })

  it("fails closed when one writer artifact version has conflicting references", () => {
    const index = createObservedEvidenceIndex()
    const first = writerResult(1, "1")
    const conflicting = writerResult(1, "2")
    recordWriterResult(index, first)
    recordWriterResult(index, conflicting)

    expect(parseAndBindStructuredResult(JSON.stringify(first), "writer", index)).toBeUndefined()
    expect(parseAndBindStructuredResult(JSON.stringify(conflicting), "writer", index)).toBeUndefined()
  })

  it.each([
    ["missing", undefined],
    ["malformed", { artifactRef: reviewerResult().artifactRef }],
    ["for a different artifact version", { artifactRef: { ...(reviewerResult().artifactRef as Record<string, unknown>), contentHash: `sha256:${"d".repeat(64)}` }, content: "draft" }],
    ["with a different numeric version", { artifactRef: { ...(reviewerResult().artifactRef as Record<string, unknown>), version: 1 }, content: "draft" }],
  ] as const)("rejects a Reviewer result without the exact observed artifact version read (%s)", (_name, readOutput) => {
    const index = createObservedEvidenceIndex()
    if (readOutput) recordReadToolOutput(index, "artifact.version.read", readOutput)
    recordReadToolOutput(index, "artifact.review", {
      artifactRef: reviewerResult().artifactRef, status: "passed", reviewHash: reviewerResult().reviewHash,
    })

    expect(parseAndBindStructuredResult(JSON.stringify(reviewerResult()), "reviewer", index)).toBeUndefined()
  })

  it.each([
    ["missing", undefined],
    ["malformed", { artifactRef: reviewerResult().artifactRef, status: "passed", reviewHash: "not-a-digest" }],
    ["with a mismatched hash", { artifactRef: reviewerResult().artifactRef, status: "passed", reviewHash: `sha256:${"d".repeat(64)}` }],
    ["with a mismatched artifact reference", { artifactRef: { ...(reviewerResult().artifactRef as Record<string, unknown>), version: 1 }, status: "passed", reviewHash: reviewerResult().reviewHash }],
  ] as const)("rejects a Reviewer result without the exact observed artifact.review receipt (%s)", (_name, reviewOutput) => {
    const index = createObservedEvidenceIndex()
    recordReadToolOutput(index, "artifact.version.read", { artifactRef: reviewerResult().artifactRef, content: "draft" })
    if (reviewOutput) recordReadToolOutput(index, "artifact.review", reviewOutput)

    expect(parseAndBindStructuredResult(JSON.stringify(reviewerResult()), "reviewer", index)).toBeUndefined()
  })

  it("binds a Reviewer result to the exact successful artifact read and review receipt", () => {
    const result = reviewerResult()
    const index = createObservedEvidenceIndex()
    recordReadToolOutput(index, "artifact.version.read", { artifactRef: result.artifactRef, content: "draft" })
    recordReadToolOutput(index, "artifact.review", {
      artifactRef: result.artifactRef, status: result.reviewStatus, reviewHash: result.reviewHash,
    })

    expect(parseAndBindStructuredResult(JSON.stringify(result), "reviewer", index)).toEqual(result)
  })

  it("keeps observed evidence bounded by entries and serialized bytes", () => {
    const index = createObservedEvidenceIndex()
    recordReadToolOutput(index, "jobs.search", {
      jobs: Array.from({ length: 60 }, (_, number) => ({ id: `job-${number}-${"x".repeat(240)}`, source: "source" })),
    })
    const serialized = JSON.stringify([...index.entries.values()])

    expect(index.entries.size).toBeLessThanOrEqual(50)
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(8 * 1024)
  })

  it("rejects structured JSON over the 8 KiB boundary", () => {
    const oversized = { ...emptyScoutResult(), summary: "x".repeat(9_000) }
    expect(Buffer.byteLength(JSON.stringify(oversized), "utf8")).toBeGreaterThan(8 * 1024)
    expect(parseAndBindStructuredResult(JSON.stringify(oversized), "scout", createObservedEvidenceIndex())).toBeUndefined()
  })

  it("hydrates restored jobs, persona, and resume reads into canonical evidence", () => {
    const index = createObservedEvidenceIndex()
    hydrateObservedEvidence(index, [
      restored("job", "jobs.search", { jobs: [{ id: "job-1", source: "greenhouse" }] }),
      restored("fact", "persona.retrieve", { facts: [{ id: "fact-1", source: "persona.database" }] }),
      restored("resume", "resume.get_base", { resume: { id: "resume-1" } }),
    ])

    const result = parseAndBindStructuredResult(JSON.stringify({
      schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed",
      findings: [{ jobId: "job-1", score: 8, evidenceIds: ["job", "fact", "resume"] }],
      evidence: [
        { id: "job", kind: "job", ref: "job-1", source: "model" },
        { id: "fact", kind: "persona", ref: "fact-1", source: "model" },
        { id: "resume", kind: "resume", ref: "resume-1", source: "model" },
      ], summary: "restored",
    }), "analyst", index)

    expect(result?.evidence).toEqual([
      { id: "read:job:job-1", kind: "job", ref: "job-1", source: "greenhouse" },
      { id: "read:persona:fact-1", kind: "persona", ref: "fact-1", source: "persona.database" },
      { id: "read:resume:resume-1", kind: "resume", ref: "resume-1", source: "resume.get_base" },
    ])
  })

  it("skips a valid historical failed read without inventing evidence", () => {
    const index = createObservedEvidenceIndex()
    hydrateObservedEvidence(index, [
      restored("failed", "jobs.search", { jobs: [{ id: "job-failed", source: "greenhouse" }] }, { status: "failed", errorCode: "tool_execution_failed" }),
      restored("job", "jobs.search", { jobs: [{ id: "job-1", source: "greenhouse" }] }),
    ])

    expect(entry(index, "job", "job-failed")).toBeUndefined()
    expect(entry(index, "job", "job-1")).toBeDefined()
  })

  it("accepts restored non-evidence read observations without projecting evidence", () => {
    const index = createObservedEvidenceIndex()
    hydrateObservedEvidence(index, [
      restored("state", "application.get_state", { jobs: [{ id: "job-1", source: "greenhouse" }] }),
      restored("tool-result", "tool_results.read", { facts: [{ id: "fact-1", source: "persona.database" }] }),
    ])

    expect(index.entries.size).toBe(0)
    expect(index.conflicts.size).toBe(0)
  })

  it.each([
    ["malformed shape", restored("bad", "jobs.search", { jobs: [] }, { errorCode: undefined })],
    ["foreign tool", restored("foreign", "admin.lookup", { jobs: [] })],
    ["oversized content", restored("large", "jobs.search", { jobs: [{ id: "job-1", source: "x".repeat(9_000) }] })],
  ] as const)("rejects %s restored evidence", (_name, observation) => {
    expect(() => hydrateObservedEvidence(createObservedEvidenceIndex(), [observation])).toThrow()
  })

  it("fails closed on conflicting restored sources", () => {
    expect(() => hydrateObservedEvidence(createObservedEvidenceIndex(), [
      restored("first", "jobs.search", { jobs: [{ id: "job-1", source: "greenhouse" }] }),
      restored("second", "jobs.get", { job: { id: "job-1", source: "lever" } }),
    ])).toThrow("child_resume_evidence_conflict")
  })
})
