import { describe, expect, it } from "vitest"
import { parseRootTaskHistoryReportedOutput, parseRootTaskHistoryReportedOutputsFromGraph } from "./root-task-history-result-counts.js"

const schemaVersion = "agent-harness.v2.task-graph.result-projection"
const candidate = { jobId: "job-1", source: "other", evidenceKinds: ["job"] }
const finding = { jobId: "job-1", score: 8, evidenceKinds: ["job"] }
function scout(overrides: Record<string, unknown> = {}) {
  return { schemaVersion, trust: "untrusted", availability: "available", role: "scout", status: "completed",
    candidateCount: 5, evidenceCount: 2, candidates: [candidate, candidate, candidate], ...overrides }
}
function analyst(overrides: Record<string, unknown> = {}) {
  return { schemaVersion, trust: "untrusted", availability: "available", role: "analyst", status: "partial",
    findingCount: 4, evidenceCount: 2, findings: [finding, finding, finding], ...overrides }
}

describe("root task history reported output counts", () => {
  it("uses the complete Scout count beyond its three-item sample and keeps duplicate reports counted", () => {
    expect(parseRootTaskHistoryReportedOutput(scout(), "scout")).toEqual({
      role: "scout", candidateCount: 5, resultStatus: "completed",
    })
  })

  it("uses the complete Analyst count and preserves partial role-result status", () => {
    expect(parseRootTaskHistoryReportedOutput(analyst(), "analyst")).toEqual({
      role: "analyst", findingCount: 4, resultStatus: "partial",
    })
  })

  it("preserves a reported zero instead of treating it as unavailable", () => {
    expect(parseRootTaskHistoryReportedOutput(scout({ candidateCount: 0, candidates: [] }), "scout")).toEqual({
      role: "scout", candidateCount: 0, resultStatus: "completed",
    })
    expect(parseRootTaskHistoryReportedOutput(undefined, "scout")).toBeUndefined()
  })

  it.each([
    ["missing", undefined],
    ["unavailable", { schemaVersion, trust: "untrusted", availability: "unavailable" }],
    ["wrong schema", scout({ schemaVersion: "other" })],
    ["extra projection field", scout({ candidateIds: ["private-id"] })],
    ["wrong role", scout({ role: "analyst" })],
    ["invalid result status", scout({ status: "running" })],
    ["negative count", scout({ candidateCount: -1, candidates: [] })],
    ["unsafe count", scout({ candidateCount: Number.MAX_SAFE_INTEGER + 1 })],
    ["sample count mismatch", scout({ candidateCount: 2 })],
    ["malformed sample", scout({ candidates: [{ ...candidate, rawId: "private" }, candidate, candidate] })],
  ])("omits %s Scout projections", (_label, projection) => {
    expect(parseRootTaskHistoryReportedOutput(projection, "scout")).toBeUndefined()
  })

  it("omits unavailable, malformed, and role-mismatched Analyst projections", () => {
    expect(parseRootTaskHistoryReportedOutput(undefined, "analyst")).toBeUndefined()
    expect(parseRootTaskHistoryReportedOutput(analyst({ availability: "unavailable" }), "analyst")).toBeUndefined()
    expect(parseRootTaskHistoryReportedOutput(analyst({ role: "scout" }), "analyst")).toBeUndefined()
    expect(parseRootTaskHistoryReportedOutput(analyst({ findings: [{ ...finding, score: 11 }, finding, finding] }), "analyst")).toBeUndefined()
  })

  it("returns only closed count facts and no sample, ID, score, evidence, or text", () => {
    const output = parseRootTaskHistoryReportedOutput(analyst(), "analyst")
    expect(output).toEqual({ role: "analyst", findingCount: 4, resultStatus: "partial" })
    for (const forbidden of ["job-1", "score", "evidence", "findings", "summary", "sample"]) {
      expect(JSON.stringify(output)).not.toContain(forbidden)
    }
  })

  it("derives ordered count facts from completed role nodes in the same graph", () => {
    const graph = { revision: 9, nodes: [
      { templateId: "scout", status: "completed", resultProjection: scout() },
      { templateId: "analyst", status: "completed", resultProjection: analyst() },
      { templateId: "scout", status: "completed", resultProjection: scout({ candidateCount: 0, evidenceCount: 0, candidates: [] }) },
    ] }
    const outputs = parseRootTaskHistoryReportedOutputsFromGraph(graph)
    expect(outputs).toEqual([
      { role: "scout", candidateCount: 5, resultStatus: "completed" },
      { role: "analyst", findingCount: 4, resultStatus: "partial" },
      { role: "scout", candidateCount: 0, resultStatus: "completed" },
    ])
    for (const forbidden of ["job-1", "source", "score", "evidence", "candidates", "findings"]) {
      expect(JSON.stringify(outputs)).not.toContain(forbidden)
    }
  })

  it("omits noncompleted, unavailable, malformed, and role-mismatched graph projections", () => {
    expect(parseRootTaskHistoryReportedOutputsFromGraph({ revision: 1, nodes: [
      { templateId: "scout", status: "failed", resultProjection: scout() },
      { templateId: "scout", status: "completed", resultProjection: analyst() },
      { templateId: "analyst", status: "completed", resultProjection: analyst({ availability: "unavailable" }) },
      { templateId: "analyst", status: "completed", resultProjection: analyst({ extra: true }) },
    ] })).toEqual([undefined, undefined, undefined, undefined])
    expect(parseRootTaskHistoryReportedOutputsFromGraph({ revision: 1, nodes: [], extra: true })).toBeUndefined()
  })

  it("does not invoke accessors while inspecting a historical graph", () => {
    let reads = 0
    const node = Object.defineProperty({ templateId: "scout", status: "completed" }, "resultProjection", {
      enumerable: true, get: () => { reads += 1; return scout() },
    })
    expect(parseRootTaskHistoryReportedOutputsFromGraph({ revision: 1, nodes: [node] })).toEqual([undefined])
    expect(reads).toBe(0)
  })
})
