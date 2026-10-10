import { describe, expect, it } from "vitest"

import type { CoordinationTaskView } from "./coordination-types.js"
import { validateRoleResult } from "../subagents/role-results.js"
import { buildScoutAnalystAggregate, validatedStructuredResult } from "./coordination-result-aggregate.js"

const base: CoordinationTaskView = {
  id: "task", userId: "user", sessionId: "session", turnId: "turn", rootTaskId: "root", parentTaskId: "root", path: "/root/task", depth: 1,
  role: "scout", taskType: "read", status: "completed", goal: "goal", attemptCount: 1, maxAttempts: 1, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null,
}
const scoutResult = { schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "completed", candidates: [{ jobId: "job-1", source: "source", url: null, evidenceIds: ["e-1"] }], evidence: [{ id: "e-1", kind: "job", ref: "job-1", source: "source" }], summary: "found" }
const analystResult = { schemaVersion: scoutResult.schemaVersion, role: "analyst", status: "completed", findings: [{ jobId: "job-1", score: 8, evidenceIds: ["e-1"] }], evidence: scoutResult.evidence, summary: "scored" }
function oversized<T extends { readonly summary: string }>(result: T): T & { readonly summary: string } {
  return { ...result, summary: `${result.summary} oversized-payload-secret ${"x".repeat(3_000)}` }
}
function task(overrides: Partial<CoordinationTaskView>): CoordinationTaskView { return { ...base, ...overrides } }

describe("coordination result aggregate", () => {
  it("derives a bounded aggregate from valid roles", () => {
    const result = buildScoutAnalystAggregate([task({ id: "scout", result: { structuredResult: scoutResult } }), task({ id: "analyst", role: "analyst", result: { structuredResult: { schemaVersion: scoutResult.schemaVersion, role: "analyst", status: "completed", findings: [{ jobId: "job-1", score: 8, evidenceIds: ["e-1"] }], evidence: scoutResult.evidence, summary: "scored" } } })])
    expect(result).toMatchObject({ status: "completed", successfulRoles: ["scout", "analyst"], jobIds: ["job-1"] })
  })

  it("includes failed and pending role states", () => {
    const result = buildScoutAnalystAggregate([task({ id: "scout", result: { structuredResult: scoutResult } }), task({ id: "analyst", role: "analyst", status: "completed", result: { structuredResult: { role: "wrong" } } })])
    expect(result).toMatchObject({ status: "partial", successfulRoles: ["scout"], failedRoles: ["analyst"] })
    const pending = buildScoutAnalystAggregate([task({ id: "scout", result: { structuredResult: scoutResult } }), task({ id: "analyst", role: "analyst", status: "running", result: { structuredResult: { secret: "hidden" } } })])
    expect(pending).toMatchObject({ status: "pending", pendingRoles: ["analyst"] })
  })

  it("keeps readable Analyst facts when the Scout result is oversized", () => {
    const largeScout = oversized({
      ...scoutResult,
      candidates: [{ ...scoutResult.candidates[0], jobId: "oversized-scout-job", evidenceIds: ["e-oversized-scout"] }],
      evidence: [{ ...scoutResult.evidence[0], id: "e-oversized-scout", ref: "oversized-scout-job" }],
    })
    expect(validateRoleResult(largeScout, "scout")).toEqual(largeScout)
    const result = buildScoutAnalystAggregate([
      task({ id: "scout", result: { structuredResult: largeScout } }),
      task({ id: "analyst", role: "analyst", result: { structuredResult: { ...analystResult, findings: [{ ...analystResult.findings[0], jobId: "analyst-job" }], evidence: [{ ...analystResult.evidence[0], ref: "analyst-job" }] } } }),
    ])
    const encoded = JSON.stringify(result ?? null)
    expect(result).toMatchObject({ status: "partial", successfulRoles: ["analyst"], failedRoles: [], jobIds: ["analyst-job"] })
    expect(result?.successfulRoles).not.toContain("scout")
    expect(result?.failedRoles).not.toContain("scout")
    expect(encoded).not.toContain("oversized-scout-job")
    expect(encoded).not.toContain("oversized-payload-secret")
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(2048)
  })

  it("keeps readable Scout facts when the Analyst result is oversized", () => {
    const largeAnalyst = oversized({
      ...analystResult,
      findings: [{ ...analystResult.findings[0], jobId: "oversized-analyst-job", evidenceIds: ["e-oversized-analyst"] }],
      evidence: [{ ...analystResult.evidence[0], id: "e-oversized-analyst", ref: "oversized-analyst-job" }],
    })
    expect(validateRoleResult(largeAnalyst, "analyst")).toEqual(largeAnalyst)
    const result = buildScoutAnalystAggregate([
      task({ id: "scout", result: { structuredResult: { ...scoutResult, candidates: [{ ...scoutResult.candidates[0], jobId: "scout-job" }], evidence: [{ ...scoutResult.evidence[0], ref: "scout-job" }] } } }),
      task({ id: "analyst", role: "analyst", result: { structuredResult: largeAnalyst } }),
    ])
    const encoded = JSON.stringify(result ?? null)
    expect(result).toMatchObject({ status: "partial", successfulRoles: ["scout"], failedRoles: [], jobIds: ["scout-job"] })
    expect(result?.successfulRoles).not.toContain("analyst")
    expect(result?.failedRoles).not.toContain("analyst")
    expect(encoded).not.toContain("oversized-analyst-job")
    expect(encoded).not.toContain("oversized-payload-secret")
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(2048)
  })

  it("preserves failure details for an oversized failed role result", () => {
    const largeFailedScout = oversized({
      ...scoutResult,
      candidates: [{ ...scoutResult.candidates[0], jobId: "oversized-failed-scout-job", evidenceIds: ["e-oversized-failed-scout"] }],
      evidence: [{ ...scoutResult.evidence[0], id: "e-oversized-failed-scout", ref: "oversized-failed-scout-job" }],
    })
    const readableAnalyst = {
      ...analystResult,
      findings: [{ ...analystResult.findings[0], jobId: "analyst-job" }],
      evidence: [{ ...analystResult.evidence[0], ref: "analyst-job" }],
    }
    const failedScoutTask = task({ id: "scout", status: "failed", failureReason: "source_unavailable" })
    let failedResultReads = 0
    Object.defineProperty(failedScoutTask, "result", {
      get() { failedResultReads += 1; return { structuredResult: largeFailedScout } },
    })
    const result = buildScoutAnalystAggregate([
      failedScoutTask,
      task({ id: "analyst", role: "analyst", result: { structuredResult: readableAnalyst } }),
    ])
    const encoded = JSON.stringify(result ?? null)
    expect(failedResultReads).toBe(0)
    expect(result).toMatchObject({
      status: "partial", successfulRoles: ["analyst"], failedRoles: ["scout"], jobIds: ["analyst-job"],
      failures: [{ role: "scout", taskId: "scout", reason: "source_unavailable" }],
    })
    expect(encoded).not.toContain("oversized-failed-scout-job")
    expect(encoded).not.toContain("oversized-payload-secret")
  })

  it("keeps pending status when a readable role is waiting for the other role", () => {
    const pending = buildScoutAnalystAggregate([
      task({ id: "scout", result: { structuredResult: scoutResult } }),
      task({ id: "analyst", role: "analyst", status: "running", result: { structuredResult: oversized(analystResult) } }),
    ])
    expect(pending).toMatchObject({ status: "pending", successfulRoles: ["scout"], pendingRoles: ["analyst"] })
    expect(pending?.failedRoles).toEqual([])
  })

  it("omits the aggregate when oversized results leave no validated readable role", () => {
    const largeScout = oversized(scoutResult)
    expect(buildScoutAnalystAggregate([task({ id: "scout", result: { structuredResult: largeScout } })])).toBeUndefined()
    expect(buildScoutAnalystAggregate([
      task({ id: "scout", result: { structuredResult: largeScout } }),
      task({ id: "analyst", role: "analyst", result: { structuredResult: { role: "wrong" } } }),
    ])).toBeUndefined()
  })

  it("rejects invalid structured results without exposing them", () => {
    const invalid = task({ result: { structuredResult: { role: "analyst" } } })
    expect(validatedStructuredResult(invalid)).toEqual({ result: null, invalid: true })
  })

  it("keeps the aggregate within its byte bound", () => {
    const result = buildScoutAnalystAggregate([task({ result: { structuredResult: scoutResult } })])
    expect(result && Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(2048)
  })

  it("keeps legacy unstructured tasks compatible", () => {
    expect(buildScoutAnalystAggregate([task({ result: { summary: "legacy" } })])).toBeUndefined()
    expect(validatedStructuredResult(task({ result: { summary: "legacy" } }))).toEqual({ result: null, invalid: false })
  })
})
