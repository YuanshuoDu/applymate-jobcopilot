import { describe, expect, it } from "vitest"
import { Buffer } from "node:buffer"

import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { createObservedEvidenceIndex, parseAndBindStructuredResult, recordReadToolOutput } from "./child-evidence.js"

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

function entry(index: ReturnType<typeof createObservedEvidenceIndex>, kind: string, ref: string) {
  return index.entries.get(`${kind}\u0000${ref}`)
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
})
