import { describe, expect, it } from "vitest"

import { snapshotEvidence, verifyCandidateFinal } from "./verifier.js"

function observation(toolName: string, output: unknown, callId = toolName): { id: string; content: Record<string, unknown> } {
  return { id: `tool-result:${callId}`, content: { toolCallId: callId, toolName, input: {}, status: "completed", output, errorCode: null } }
}

function snapshot(observations: readonly { id: string; content: Record<string, unknown> }[]) {
  return { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: observations }
}

describe("candidate final verifier", () => {
  it("projects successful domain reads into canonical evidence and keeps state reads contextual", () => {
    const evidence = snapshotEvidence(snapshot([
      observation("jobs.search", { jobs: [{ id: "job-1" }] }),
      observation("jobs.get", { job: { id: "job-2" } }),
      observation("persona.retrieve", { facts: [{ id: "fact-1" }] }),
      observation("resume.get_base", { resume: { id: "resume-1" } }),
      observation("application.get_state", { job: { id: "job-3" } }),
      observation("tool_results.read", { jobs: [{ id: "job-4" }] }),
    ]))
    expect(evidence).toEqual(expect.arrayContaining([
      { id: "read:job:job-1", status: "verified" },
      { id: "read:job:job-2", status: "verified" },
      { id: "read:persona:fact-1", status: "verified" },
      { id: "read:resume:resume-1", status: "verified" },
    ]))
    expect(evidence.some(entry => entry.id === "read:job:job-3" || entry.id === "read:job:job-4")).toBe(false)
    expect(verifyCandidateFinal({ goal: "Find a role", candidate: { text: "Done", finishReason: "stop", evidenceRefs: ["read:job:job-1"] }, evidence })).toMatchObject({ ok: true })
  })

  it("fails closed for malformed, cyclic, oversized, and foreign shaped read output while retaining call evidence", () => {
    const cyclic: Record<string, unknown> = { jobs: [{ id: "cyclic-job" }] }
    cyclic.self = cyclic
    const cases: readonly [string, unknown][] = [
      ["malformed", { jobs: [{ source: "greenhouse" }] }],
      ["cyclic", cyclic],
      ["oversized", { jobs: [{ id: "large-job", description: "x".repeat(9_000) }] }],
      ["foreign", { jobs: [{ id: "foreign-job", userId: "other-user" }] }],
    ]
    for (const [name, output] of cases) {
      const evidence = snapshotEvidence(snapshot([observation("jobs.search", output, `call-${name}`)]))
      expect(evidence).toContainEqual({ id: `call-${name}`, status: "verified" })
      expect(evidence.some(entry => entry.id.startsWith("read:"))).toBe(false)
    }
  })

  it("rejects a plausible final with no evidence", () => {
    expect(verifyCandidateFinal({ goal: "Find a role", candidate: { text: "Done", finishReason: "stop" } })).toMatchObject({ ok: false, code: "evidence_missing" })
  })

  it("returns typed conflicting and business failures", () => {
    expect(verifyCandidateFinal({ goal: "Find a role", candidate: { text: "Done", finishReason: "stop", evidenceRefs: ["job-1"] }, evidence: [{ id: "job-1", status: "conflicting" }] })).toMatchObject({ ok: false, code: "evidence_conflict" })
    expect(verifyCandidateFinal({ goal: "Find a role", candidate: { text: "Done", finishReason: "stop", evidenceRefs: ["job-1"] }, evidence: [{ id: "job-1" }], businessChecks: [{ name: "approval", ok: false, message: "Approval is required" }] })).toMatchObject({ ok: false, code: "business_precondition_failed" })
  })

  it("rejects an evidence reference that is not present in the verified evidence set", () => {
    expect(verifyCandidateFinal({ goal: "Find a role", candidate: { text: "Done", finishReason: "stop", evidenceRefs: ["unknown"] } })).toMatchObject({ ok: false, code: "evidence_missing" })
  })

  it("accepts only a stopped response with verified evidence", () => {
    expect(verifyCandidateFinal({ goal: "Find a role", candidate: { text: "Done", finishReason: "stop", evidenceRefs: ["job-1"] }, evidence: [{ id: "job-1" }] })).toMatchObject({ ok: true, evidenceRefs: ["job-1"] })
  })
})
