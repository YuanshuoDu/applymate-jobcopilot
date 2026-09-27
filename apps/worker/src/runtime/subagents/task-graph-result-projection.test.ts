import { describe, expect, it } from "vitest"
import {
  projectTaskGraphResult,
  taskGraphResultProjectionBytes,
  TASK_GRAPH_RESULT_PROJECTION_NODE_BYTE_LIMIT,
} from "./task-graph-result-projection.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"

function scoutResult(options: { count?: number; summary?: string; source?: string; jobIdLength?: number } = {}): Record<string, unknown> {
  const count = options.count ?? 1
  const jobIds = Array.from({ length: count }, (_, index) => "job-" + String(index + 1).padStart(2, "0") + "x".repeat(Math.max(0, (options.jobIdLength ?? 8) - 6)))
  const evidence = jobIds.map((jobId, index) => ({
    id: "private-evidence-id-" + index,
    kind: "job",
    ref: jobId,
    source: "private evidence owner name",
  }))
  return {
    schemaVersion: ROLE_RESULT_SCHEMA,
    role: "scout",
    status: "completed",
    candidates: jobIds.map((jobId, index) => ({
      jobId,
      source: index === 0 ? (options.source ?? "greenhouse") : "https://untrusted.example/" + index,
      url: "https://candidate.example/private",
      evidenceIds: ["private-evidence-id-" + index],
    })),
    evidence,
    summary: options.summary ?? "Private Candidate Name found roles at https://private.example",
  }
}

function analystResult(): Record<string, unknown> {
  return {
    schemaVersion: ROLE_RESULT_SCHEMA,
    role: "analyst",
    status: "partial",
    findings: [{ jobId: "job-42", score: 8.75, evidenceIds: ["private-job-evidence", "private-resume-evidence"] }],
    evidence: [
      { id: "private-job-evidence", kind: "job", ref: "job-42", source: "private job evidence source" },
      { id: "private-resume-evidence", kind: "resume", ref: "https://private.example/resume", source: "Private Candidate Name" },
    ],
    summary: "Private Candidate Name scored highly at https://private.example",
  }
}

function completedEnvelope(structuredResult: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    finalItemId: "internal-final-item-id",
    finalText: "Private Candidate Name https://private.example/final",
    status: "completed",
    stepCount: 12,
    structuredResult,
    toolCallCount: 6,
    ...extra,
  }
}

describe("task graph result projection", () => {
  it("projects only validated nested result facts and omits all freeform text and private references", () => {
    const projection = projectTaskGraphResult("scout", "completed", completedEnvelope(scoutResult()))

    expect(projection).toMatchObject({
      availability: "available",
      trust: "untrusted",
      role: "scout",
      status: "completed",
      candidateCount: 1,
      evidenceCount: 1,
      candidates: [{ jobId: "job-01xx", source: "greenhouse", evidenceKinds: ["job"] }],
    })
    const serialized = JSON.stringify(projection)
    for (const secret of [
      "Private Candidate Name", "private.example", "internal-final-item-id",
      "private-evidence-id", "private evidence owner name", "candidate.example",
    ]) expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain("summary")
    expect(serialized).not.toContain("url")
    expect(serialized).not.toContain("ref")
  })

  it("uses a fixed source allowlist and deterministic counts while bounding candidate items", () => {
    const projection = projectTaskGraphResult("scout", "completed", completedEnvelope(scoutResult({ count: 5, source: "Greenhouse" })))

    expect(projection).toMatchObject({
      availability: "available",
      role: "scout",
      candidateCount: 5,
      candidates: [
        { source: "greenhouse" },
        { source: "other" },
        { source: "other" },
      ],
    })
    if (projection.availability === "available" && projection.role === "scout") {
      expect(projection.candidates).toHaveLength(3)
    } else {
      throw new Error("Expected available Scout projection")
    }
  })

  it("projects validated Analyst scores and evidence kinds without evidence identifiers", () => {
    const projection = projectTaskGraphResult("analyst", "completed", completedEnvelope(analystResult()))

    expect(projection).toMatchObject({
      availability: "available",
      trust: "untrusted",
      role: "analyst",
      status: "partial",
      findingCount: 1,
      evidenceCount: 2,
      findings: [{ jobId: "job-42", score: 8.75, evidenceKinds: ["job", "resume"] }],
    })
    expect(JSON.stringify(projection)).not.toContain("private-evidence-id")
    expect(JSON.stringify(projection)).not.toContain("private.example")
  })

  it.each([
    ["wrong task status", "scout", "running", completedEnvelope(scoutResult())],
    ["role mismatch", "analyst", "completed", completedEnvelope(scoutResult())],
    ["extra envelope key", "scout", "completed", completedEnvelope(scoutResult(), { unsafe: "value" })],
    ["extra role result key", "scout", "completed", completedEnvelope({ ...scoutResult(), unexpected: true })],
    ["oversized persisted envelope", "scout", "completed", completedEnvelope(scoutResult(), { finalText: "x".repeat(17 * 1024) })],
  ])("fails closed to unavailable for %s", (_label, role, status, value) => {
    expect(projectTaskGraphResult(role, status, value)).toEqual({
      schemaVersion: "agent-harness.v2.task-graph.result-projection",
      trust: "untrusted",
      availability: "unavailable",
    })
  })

  it("keeps a maximum-size typed projection under the per-node byte limit", () => {
    const projection = projectTaskGraphResult("scout", "completed", completedEnvelope(scoutResult({
      count: 3,
      jobIdLength: 80,
      summary: "model authored prose ".repeat(200),
    })))

    expect(projection.availability).toBe("available")
    expect(taskGraphResultProjectionBytes(projection)).toBeLessThanOrEqual(TASK_GRAPH_RESULT_PROJECTION_NODE_BYTE_LIMIT)
  })
})
