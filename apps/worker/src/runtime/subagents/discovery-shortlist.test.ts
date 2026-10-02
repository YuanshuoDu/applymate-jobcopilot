import { describe, expect, it } from "vitest"

import { createObservedEvidenceIndex, recordReadToolOutput } from "./child-evidence.js"
import { buildDiscoveryShortlist, type DiscoveryShortlistFailureCode } from "./discovery-shortlist.js"
import { ROLE_RESULT_SCHEMA, type AnalystResult, type RoleEvidence, type ScoutResult } from "./role-results.js"

const ownerUserId = "user-1"

function evidence(jobId: string): RoleEvidence {
  return { id: `read:job:${jobId}`, kind: "job", ref: jobId, source: "greenhouse" }
}

function scout(jobIds: readonly string[], status: "completed" | "partial" = "completed"): ScoutResult {
  return {
    schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status,
    candidates: jobIds.map(jobId => ({ jobId, source: "model-source", url: `https://model.test/${jobId}`, evidenceIds: [evidence(jobId).id] })),
    evidence: [...new Set(jobIds)].map(evidence), summary: "Scout result",
  }
}

function analyst(scores: Readonly<Record<string, number>>, status: "completed" | "partial" = "completed"): AnalystResult {
  return {
    schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status,
    findings: Object.entries(scores).map(([jobId, score]) => ({ jobId, score, evidenceIds: [evidence(jobId).id] })),
    evidence: Object.keys(scores).map(evidence), summary: "Analyst result",
  }
}

function observed(jobIds: readonly string[]) {
  const index = createObservedEvidenceIndex()
  recordReadToolOutput(index, "jobs.search", { jobs: [...new Set(jobIds)].map(id => ({ id, source: "greenhouse" })) })
  return index
}

function run(scoutResult: unknown, analystResult: unknown, jobIds: readonly string[] = [] , userId = ownerUserId) {
  return buildDiscoveryShortlist({ ownerUserId: userId, scoutResult, analystResult, observedEvidence: observed(jobIds) })
}

describe("buildDiscoveryShortlist", () => {
  it("includes bounded runtime failure codes for terminal Worker outcomes", () => {
    const codes: DiscoveryShortlistFailureCode[] = ["discovery_runtime_unavailable", "discovery_runtime_failed"]
    expect(codes).toEqual(["discovery_runtime_unavailable", "discovery_runtime_failed"])
  })

  it("intersects owner-scoped IDs, sorts score descending then ID, caps at three, and omits model URLs and sources", () => {
    const result = run(scout(["job-d", "job-c", "job-b", "job-a"]), analyst({ "job-e": 10, "job-d": 10, "job-c": 10, "job-b": 10, "job-a": 9 }), ["job-a", "job-b", "job-c", "job-d", "job-e"])

    expect(result).toEqual({
      schemaVersion: 1, status: "completed", failures: [],
      items: [
        { jobId: "job-b", score: 10, evidenceIds: ["read:job:job-b"] },
        { jobId: "job-c", score: 10, evidenceIds: ["read:job:job-c"] },
        { jobId: "job-d", score: 10, evidenceIds: ["read:job:job-d"] },
      ],
    })
    expect(JSON.stringify(result)).not.toContain("model.test")
    expect(JSON.stringify(result)).not.toContain("model-source")
  })

  it("deduplicates repeated IDs and rejects conflicting Analyst scores", () => {
    const scoutResult = { ...scout(["job-1", "job-2"]), candidates: [...scout(["job-1", "job-2"]).candidates, scout(["job-1"]).candidates[0]!] }
    const analystResult = { ...analyst({ "job-1": 8, "job-2": 7 }), findings: [...analyst({ "job-1": 8, "job-2": 7 }).findings, { jobId: "job-1", score: 9, evidenceIds: [evidence("job-1").id] }] }
    const result = run(scoutResult, analystResult, ["job-1", "job-2"])

    expect(result.status).toBe("partial")
    expect(result.items).toEqual([{ jobId: "job-2", score: 7, evidenceIds: ["read:job:job-2"] }])
    expect(result.failures).toEqual(["duplicate_scout_job", "duplicate_analyst_finding", "conflicting_analyst_score"])
  })

  it("fails closed for malformed RoleResults and for evidence that is unbound or disagrees with the owner-scoped read", () => {
    expect(run({}, analyst({ "job-1": 8 }), ["job-1"])).toMatchObject({ status: "failed", items: [], failures: ["invalid_scout_result"] })

    const wrongSource = scout(["job-1"])
    const mismatched: ScoutResult = { ...wrongSource, evidence: [{ ...evidence("job-1"), source: "untrusted-source" }] }
    expect(run(mismatched, analyst({ "job-1": 8 }), ["job-1"])).toMatchObject({ status: "failed", items: [], failures: ["evidence_unverified"] })

    const unbound = scout(["job-404"])
    expect(run(unbound, analyst({ "job-404": 8 }), ["job-1"])).toMatchObject({ status: "failed", items: [], failures: ["evidence_unverified"] })
  })

  it("rejects an observed job ID whose source records conflict", () => {
    const index = observed(["job-1"])
    recordReadToolOutput(index, "jobs.search", { jobs: [{ id: "job-1", source: "lever" }] })
    const result = buildDiscoveryShortlist({ ownerUserId, scoutResult: scout(["job-1"]), analystResult: analyst({ "job-1": 8 }), observedEvidence: index })

    expect(result).toMatchObject({ status: "failed", items: [], failures: ["evidence_conflict"] })
  })

  it("reports partial role results without upgrading them to completed", () => {
    const result = run(scout(["job-1"], "partial"), analyst({ "job-1": 8 }, "partial"), ["job-1"])
    expect(result).toMatchObject({ status: "partial", items: [{ jobId: "job-1", score: 8 }], failures: ["scout_result_partial", "analyst_result_partial"] })
  })

  it("reports failed inputs, absent scope, and empty intersections explicitly", () => {
    expect(run(undefined, undefined)).toMatchObject({ status: "failed", items: [], failures: ["invalid_scout_result", "invalid_analyst_result"] })
    expect(run(scout(["job-1"]), analyst({ "job-1": 8 }), ["job-1"], " ")).toMatchObject({ status: "failed", items: [], failures: ["owner_scope_missing"] })
    expect(run(scout(["job-1"]), analyst({ "job-2": 8 }), ["job-1", "job-2"])).toMatchObject({ status: "failed", items: [], failures: ["no_common_candidates"] })
  })

  it("returns byte-for-byte equivalent data for repeated invocations", () => {
    const input = { scoutResult: scout(["job-z", "job-a"]), analystResult: analyst({ "job-z": 9, "job-a": 9 }), jobIds: ["job-z", "job-a"] }
    expect(JSON.stringify(run(input.scoutResult, input.analystResult, input.jobIds))).toBe(JSON.stringify(run(input.scoutResult, input.analystResult, input.jobIds)))
  })
})
