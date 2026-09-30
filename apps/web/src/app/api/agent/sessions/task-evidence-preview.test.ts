import { describe, expect, it } from "vitest"

import { projectTaskEvidencePreview } from "./task-evidence-preview"

const evidence = [
  { id: "job-evidence", kind: "job", ref: "job-42", source: "greenhouse" },
  { id: "persona-evidence", kind: "persona", ref: "private-profile-id", source: "persona.retrieve" },
  { id: "source-evidence", kind: "source", ref: "jobs.search:run-1", source: "jobs.search" },
  { id: "unreferenced", kind: "job", ref: "secret-job-99", source: "private-provider" },
]

function row(overrides: Record<string, unknown> = {}) {
  return {
    role: "scout", status: "completed",
    result: {
      status: "completed", stepCount: 2, toolCallCount: 1, finalItemId: "final-item", finalText: "RAW_FINAL_TEXT",
      structuredResult: {
        schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "completed",
        summary: "A model-authored name must not be copied into the workbench.",
        candidates: [{ jobId: "job-42", source: "greenhouse", url: "https://private.example/apply", evidenceIds: ["job-evidence", "persona-evidence", "source-evidence"] }],
        evidence,
      },
    },
    ...overrides,
  }
}

describe("TaskGraph task evidence preview", () => {
  it("projects deterministic counts and only referenced, safe evidence metadata", () => {
    expect(projectTaskEvidencePreview(row())).toEqual({
      role: "scout", summary: "Scout completed: 1 candidate; 3 linked evidence items.", itemCount: 1,
      evidence: [
        { kind: "job", source: "greenhouse", reference: null },
        { kind: "persona", source: "persona.retrieve", reference: null },
        { kind: "source", source: "jobs.search", reference: null },
      ],
    })
  })

  it("replaces unknown source labels and suppresses producer-authored job identifiers", () => {
    const valid = row()
    const envelope = valid.result as Record<string, unknown>
    const structuredResult = envelope.structuredResult as Record<string, unknown>
    const candidate = (structuredResult.candidates as Array<Record<string, unknown>>)[0]!
    const rawEvidence = structuredResult.evidence as Array<Record<string, unknown>>
    const privateJobId = "other-session-job-42"
    const maliciousCandidateSource = "private-provider-steven-du"
    const result = {
      ...envelope,
      structuredResult: {
        ...structuredResult,
        candidates: [{ ...candidate, jobId: privateJobId, source: maliciousCandidateSource }],
        evidence: rawEvidence.map(item => item.id === "job-evidence"
          ? { ...item, ref: privateJobId, source: "steven-du" }
          : item),
      },
    }

    const preview = projectTaskEvidencePreview({ ...valid, result })

    expect(preview).toMatchObject({
      role: "scout", itemCount: 1,
      evidence: [
        { kind: "job", source: "other", reference: null },
        { kind: "persona", source: "persona.retrieve", reference: null },
        { kind: "source", source: "jobs.search", reference: null },
      ],
    })
    const serialized = JSON.stringify(preview)
    expect(serialized).not.toContain("steven-du")
    expect(serialized).not.toContain(privateJobId)
    expect(serialized).not.toContain(maliciousCandidateSource)
    expect(serialized).not.toContain("private.example")
  })

  it("fails closed for an incomplete envelope, role/schema mismatch, and oversized data", () => {
    const valid = row()
    const result = valid.result as Record<string, unknown>
    const structuredResult = result.structuredResult as Record<string, unknown>
    expect(projectTaskEvidencePreview({ ...valid, status: "running" })).toBeNull()
    expect(projectTaskEvidencePreview({ ...valid, role: "analyst" })).toBeNull()
    expect(projectTaskEvidencePreview({ ...valid, result: { ...result, extra: "execution metadata" } })).toBeNull()
    expect(projectTaskEvidencePreview({ ...valid, result: { ...result, structuredResult: { ...structuredResult, schemaVersion: "future" } } })).toBeNull()
    expect(projectTaskEvidencePreview({ ...valid, result: { ...result, structuredResult: { ...structuredResult, summary: "x".repeat(8_193) } } })).toBeNull()
  })
})
