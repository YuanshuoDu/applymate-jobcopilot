import { describe, expect, it } from "vitest"

import { adaptLegacyRoleResult } from "./legacy-adapter.js"
import { reduceScoutAnalystOutcomes } from "./partial-failure-reducer.js"

const scout = adaptLegacyRoleResult("scout", { jobs: [{ id: "job-1", source: "lever", url: "https://example.test/job-1" }] })
const analyst = adaptLegacyRoleResult("analyst", { analyses: [{ jobId: "job-1", score: 7 }] })

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

  it("adapts legacy payloads using real ids and generated provenance references", () => {
    if (scout.role !== "scout" || analyst.role !== "analyst") throw new Error("legacy adapter returned the wrong role")
    expect(scout.candidates[0]).toMatchObject({ jobId: "job-1", source: "lever" })
    expect(scout.evidence[0]).toMatchObject({ kind: "job", ref: "job-1" })
    expect(analyst.findings[0]).toMatchObject({ jobId: "job-1", score: 7 })
    expect(() => adaptLegacyRoleResult("scout", { jobs: [{ title: "missing id" }] })).toThrow(/real id/)
  })
})
