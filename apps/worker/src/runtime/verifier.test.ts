import { describe, expect, it } from "vitest"

import { snapshotEvidence, verifyCandidateFinal } from "./verifier.js"

function observation(toolName: string, output: unknown, callId = toolName): { id: string; content: Record<string, unknown> } {
  return { id: `tool-result:${callId}`, content: { toolCallId: callId, toolName, input: {}, status: "completed", output, errorCode: null } }
}

function failedObservation(toolName: string, output: unknown, callId: string): { id: string; content: Record<string, unknown> } {
  return { id: `tool-result:${callId}`, content: { toolCallId: callId, toolName, input: {}, status: "failed", output, errorCode: "tool_execution_failed" } }
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
    expect(evidence).toContainEqual({ id: "jobs.search", status: "verified" })
    expect(evidence).toContainEqual({ id: "jobs.get", status: "verified" })
    expect(verifyCandidateFinal({ goal: "Find a role", candidate: { text: "Done", finishReason: "stop", evidenceRefs: ["read:job:job-1"] }, evidence })).toMatchObject({ ok: true })
  })

  it("retains successful invocation evidence when read output is malformed", () => {
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
      expect(evidence).toEqual([{ id: `call-${name}`, status: "verified" }])
      expect(evidence.some(entry => entry.id.startsWith("read:"))).toBe(false)
    }
  })

  it("leaves failed invocation IDs unresolved and rejects a lone failed tool call", () => {
    const failed = failedObservation("jobs.search", { jobs: [{ id: "job-from-failed-call" }] }, "failed-call")
    const evidence = snapshotEvidence(snapshot([failed]))

    expect(evidence).toEqual([])
    expect(failed.content.output).toEqual({ jobs: [{ id: "job-from-failed-call" }] })
    expect(verifyCandidateFinal({
      goal: "Find a role",
      candidate: { text: "Done", finishReason: "stop", evidenceRefs: ["failed-call"] },
      evidence,
    })).toMatchObject({ ok: false, code: "evidence_missing" })
    expect(verifyCandidateFinal({
      goal: "Find a role",
      candidate: { text: "Done", finishReason: "stop" },
      evidence,
    })).toMatchObject({ ok: false, code: "evidence_missing" })
  })

  it("counts a successful retry only through its validated read result", () => {
    const failed = failedObservation("jobs.search", { jobs: [{ id: "stale-job" }] }, "failed-call")
    const retry = observation("jobs.search", { jobs: [{ id: "retried-job" }] }, "retry-call")
    const evidence = snapshotEvidence(snapshot([failed, retry]))

    expect(evidence).toEqual([
      { id: "retry-call", status: "verified" },
      { id: "read:job:retried-job", status: "verified" },
    ])
    expect(verifyCandidateFinal({
      goal: "Find a role",
      candidate: { text: "Done", finishReason: "stop", evidenceRefs: ["failed-call"] },
      evidence,
    })).toMatchObject({ ok: false, code: "evidence_missing" })
    expect(verifyCandidateFinal({
      goal: "Find a role",
      candidate: { text: "Found a role", finishReason: "stop", evidenceRefs: ["read:job:retried-job"] },
      evidence,
    })).toMatchObject({ ok: true })
  })

  it("omits non-completed IDs but retains completed IDs when read projection is ineligible", () => {
    const failed = failedObservation("jobs.search", { jobs: [{ id: "failed-job" }] }, "failed-call")
    const completedWithError = observation("jobs.search", { jobs: [{ id: "errored-job" }] }, "completed-error-call")
    completedWithError.content.errorCode = "provider_error"
    const unsupported = observation("application.get_state", { job: { id: "state-job" } }, "unsupported-call")
    const evidence = snapshotEvidence(snapshot([failed, completedWithError, unsupported]))

    expect(evidence).toEqual([
      { id: "completed-error-call", status: "verified" },
      { id: "unsupported-call", status: "verified" },
    ])
    expect(evidence.some(entry => entry.id.startsWith("read:"))).toBe(false)
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
