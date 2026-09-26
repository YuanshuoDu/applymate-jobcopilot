import { describe, expect, it } from "vitest"

import { adaptLegacyRoleResult } from "./legacy-adapter.js"
import { reduceScoutAnalystOutcomes } from "./partial-failure-reducer.js"
import { ROLE_RESULT_SCHEMA, type AnalystResult, type RoleEvidence, type ScoutResult } from "./role-results.js"

const scout = adaptLegacyRoleResult("scout", { jobs: [{ id: "job-1", source: "lever", url: "https://example.test/job-1" }] })
const analyst = adaptLegacyRoleResult("analyst", { analyses: [{ jobId: "job-1", score: 7 }] })

const evidence = (id: string, ref: string): RoleEvidence => ({ id, kind: "job", ref, source: "test" })
const scoutResult = (jobIds: readonly string[], evidenceItems: readonly RoleEvidence[]): ScoutResult => ({
  schemaVersion: ROLE_RESULT_SCHEMA,
  role: "scout",
  status: "completed",
  candidates: jobIds.map((jobId, index) => ({ jobId, source: "test", url: `https://example.test/${jobId}`, evidenceIds: [evidenceItems[index % evidenceItems.length]!.id] })),
  evidence: [...evidenceItems],
  summary: "scout result",
})
const analystResult = (jobIds: readonly string[], evidenceItems: readonly RoleEvidence[]): AnalystResult => ({
  schemaVersion: ROLE_RESULT_SCHEMA,
  role: "analyst",
  status: "completed",
  findings: jobIds.map((jobId, index) => ({ jobId, score: index + 1, evidenceIds: [evidenceItems[index]!.id] })),
  evidence: [...evidenceItems],
  summary: "analyst result",
})

describe("Scout/Analyst partial failure reducer", () => {
  it("retains one successful result when the other role fails", () => {
    const reduced = reduceScoutAnalystOutcomes([
      { role: "scout", taskId: "task-scout", status: "completed", result: scout },
      { role: "analyst", taskId: "task-analyst", status: "failed", failureReason: "model timeout" },
    ])
    expect(reduced.status).toBe("partial")
    expect(reduced.successfulRoles).toEqual(["scout"])
    expect(reduced.failedRoles).toEqual(["analyst"])
    expect(reduced.results.scout).toEqual(scout)
    expect(reduced.jobIds).toEqual(["job-1"])
    expect(reduced.failures[0]).toMatchObject({ taskId: "task-analyst", reason: "model timeout" })
  })

  it("reports a total failure without fabricating a result", () => {
    const reduced = reduceScoutAnalystOutcomes([
      { role: "scout", taskId: "task-scout", status: "failed", failureReason: "source unavailable" },
      { role: "analyst", taskId: "task-analyst", status: "interrupted" },
    ])
    expect(reduced.status).toBe("failed")
    expect(reduced.results).toEqual({})
    expect(reduced.failures).toHaveLength(2)
  })

  it.each([
    ["malformed", {}],
    ["foreign role", analyst],
    ["throwing", Object.defineProperty({}, "schemaVersion", { get: () => { throw new Error("child getter failed") } })],
  ] as const)("turns a %s completed result into one failed outcome", (_label, result) => {
    const reduced = reduceScoutAnalystOutcomes([
      { role: "scout", taskId: "task-bad", status: "completed", result },
      { role: "analyst", taskId: "task-analyst", status: "completed", result: analyst },
    ])

    expect(reduced.status).toBe("partial")
    expect(reduced.successfulRoles).toEqual(["analyst"])
    expect(reduced.failedRoles).toEqual(["scout"])
    expect(reduced.results).toEqual({ analyst })
    expect(reduced.failures).toEqual([{ role: "scout", taskId: "task-bad", reason: "Invalid role result" }])
  })

  it("uses the last input outcome for a duplicate role and drops the superseded result", () => {
    const oldScout = scoutResult(["job-old"], [evidence("e-old", "job-old")])
    const latestScout = scoutResult(["job-new"], [evidence("e-new", "job-new")])
    const reduced = reduceScoutAnalystOutcomes([
      { role: "scout", taskId: "task-old", status: "completed", result: oldScout },
      { role: "analyst", taskId: "task-analyst", status: "completed", result: analyst },
      { role: "scout", taskId: "task-latest", status: "completed", result: latestScout },
    ])

    expect(reduced.status).toBe("completed")
    expect(reduced.successfulRoles).toEqual(["scout", "analyst"])
    expect(reduced.failedRoles).toEqual([])
    expect(Object.keys(reduced.results)).toEqual(["scout", "analyst"])
    expect(reduced.results.scout).toEqual(latestScout)
    expect(reduced.jobIds).toEqual(["job-1", "job-new"])
    expect(reduced.evidence).toEqual([evidence("e-new", "job-new"), analyst.evidence[0]])
  })

  it("sorts and deduplicates aggregate evidence and job ids", () => {
    const first = evidence("e-1", "job-1")
    const second = evidence("e-2", "job-2")
    const reduced = reduceScoutAnalystOutcomes([
      { role: "analyst", taskId: "task-analyst", status: "completed", result: analystResult(["job-2", "job-1"], [second, first]) },
      { role: "scout", taskId: "task-scout", status: "completed", result: scoutResult(["job-2", "job-1", "job-2"], [second, first]) },
    ])

    expect(reduced.status).toBe("completed")
    expect(reduced.successfulRoles).toEqual(["scout", "analyst"])
    expect(reduced.failedRoles).toEqual([])
    expect(reduced.jobIds).toEqual(["job-1", "job-2"])
    expect(reduced.evidence).toEqual([first, second])
    expect(reduced.failures).toEqual([])
  })

  it("fails closed when roles reuse an evidence id with different provenance", () => {
    const scoutEvidence = evidence("shared", "job-1")
    const analystEvidence = evidence("analyst-job", "job-2")
    const foreignEvidence: RoleEvidence = { id: "shared", kind: "source", ref: "source-1", source: "analyst-source" }
    const analystWithConflict: AnalystResult = {
      schemaVersion: ROLE_RESULT_SCHEMA,
      role: "analyst",
      status: "completed",
      findings: [{ jobId: "job-2", score: 8, evidenceIds: [analystEvidence.id] }],
      evidence: [analystEvidence, foreignEvidence],
      summary: "analyst result",
    }
    const reduced = reduceScoutAnalystOutcomes([
      { role: "analyst", taskId: "task-analyst", status: "completed", result: analystWithConflict },
      { role: "scout", taskId: "task-scout", status: "completed", result: scoutResult(["job-1"], [scoutEvidence]) },
    ])

    expect(reduced.status).toBe("failed")
    expect(reduced.successfulRoles).toEqual([])
    expect(reduced.failedRoles).toEqual(["scout", "analyst"])
    expect(reduced.results).toEqual({})
    expect(reduced.evidence).toEqual([])
    expect(reduced.jobIds).toEqual([])
    expect(reduced.failures).toEqual([
      { role: "scout", taskId: "task-scout", reason: "Conflicting evidence id" },
      { role: "analyst", taskId: "task-analyst", reason: "Conflicting evidence id" },
    ])
  })

  it("keeps only the latest failure per role and orders failures canonically", () => {
    const reduced = reduceScoutAnalystOutcomes([
      { role: "analyst", taskId: "task-z", status: "failed", failureReason: "analyst unavailable" },
      { role: "scout", taskId: "task-z", status: "failed", failureReason: "scout unavailable" },
      { role: "analyst", taskId: "task-old", status: "failed", failureReason: "superseded" },
    ])

    expect(reduced.status).toBe("failed")
    expect(reduced.successfulRoles).toEqual([])
    expect(reduced.failedRoles).toEqual(["scout", "analyst"])
    expect(reduced.results).toEqual({})
    expect(reduced.failures).toEqual([
      { role: "scout", taskId: "task-z", reason: "scout unavailable" },
      { role: "analyst", taskId: "task-old", reason: "superseded" },
    ])
  })

  it("adapts legacy payloads using real ids and generated provenance references", () => {
    if (scout.role !== "scout" || analyst.role !== "analyst") throw new Error("legacy adapter returned the wrong role")
    expect(scout.candidates[0]).toMatchObject({ jobId: "job-1", source: "lever" })
    expect(scout.evidence[0]).toMatchObject({ kind: "job", ref: "job-1" })
    expect(analyst.findings[0]).toMatchObject({ jobId: "job-1", score: 7 })
    expect(() => adaptLegacyRoleResult("scout", { jobs: [{ title: "missing id" }] })).toThrow(/real id/)
  })
})
