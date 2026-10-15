import { describe, expect, it } from "vitest"

import type { CoordinationTaskView } from "./coordination-types.js"
import { buildScoutAnalystAggregate, validatedStructuredResult } from "./coordination-result-aggregate.js"

const base: CoordinationTaskView = {
  id: "task", userId: "user", sessionId: "session", turnId: "turn", rootTaskId: "root", parentTaskId: "root", path: "/root/task", depth: 1,
  role: "scout", taskType: "read", status: "completed", goal: "goal", attemptCount: 1, maxAttempts: 1, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null,
}
const scoutResult = { schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "completed", candidates: [{ jobId: "job-1", source: "source", url: null, evidenceIds: ["e-1"] }], evidence: [{ id: "e-1", kind: "job", ref: "job-1", source: "source" }], summary: "found" }
const analystResult = { schemaVersion: scoutResult.schemaVersion, role: "analyst", status: "completed", findings: [{ jobId: "job-2", score: 9, evidenceIds: ["e-2"] }], evidence: [{ id: "e-2", kind: "job", ref: "job-2", source: "source" }], summary: "scored" }
function task(overrides: Partial<CoordinationTaskView>): CoordinationTaskView { return { ...base, ...overrides } }

describe("coordination result aggregate", () => {
  it("derives a bounded aggregate from valid roles", () => {
    const result = buildScoutAnalystAggregate([task({ id: "scout", result: { structuredResult: scoutResult } }), task({ id: "analyst", role: "analyst", result: { structuredResult: { schemaVersion: scoutResult.schemaVersion, role: "analyst", status: "completed", findings: [{ jobId: "job-1", score: 8, evidenceIds: ["e-1"] }], evidence: scoutResult.evidence, summary: "scored" } } })])
    expect(result).toMatchObject({ status: "completed", successfulRoles: ["scout", "analyst"], jobIds: ["job-1"] })
  })

  it("includes failed and pending role states", () => {
    const result = buildScoutAnalystAggregate([task({ id: "scout", result: { structuredResult: scoutResult } }), task({ id: "analyst", role: "analyst", status: "completed", result: { structuredResult: { role: "wrong" } } })])
    expect(result).toMatchObject({ status: "partial", successfulRoles: ["scout"], failedRoles: ["analyst"] })
    const pendingResult = { ...analystResult, summary: "pending payload must stay unread ".repeat(200) }
    const pending = buildScoutAnalystAggregate([task({ id: "scout", result: { structuredResult: scoutResult } }), task({ id: "analyst", role: "analyst", status: "running", result: { structuredResult: pendingResult } })])
    expect(pending).toMatchObject({ status: "pending", pendingRoles: ["analyst"] })
    expect(JSON.stringify(pending)).not.toContain("pending payload must stay unread")
  })

  it.each(["scout", "analyst"] as const)("preserves readable peer facts when the oversized result belongs to %s", omittedRole => {
    const hiddenJobId = `oversized-${omittedRole}-job`
    const oversizedResult = omittedRole === "scout"
      ? { ...scoutResult, candidates: [{ jobId: hiddenJobId, source: "source", url: null, evidenceIds: [`${hiddenJobId}-evidence`] }], evidence: [{ id: `${hiddenJobId}-evidence`, kind: "job", ref: hiddenJobId, source: "source" }], summary: "oversized scout secret ".repeat(200) }
      : { ...analystResult, findings: [{ jobId: hiddenJobId, score: 10, evidenceIds: [`${hiddenJobId}-evidence`] }], evidence: [{ id: `${hiddenJobId}-evidence`, kind: "job", ref: hiddenJobId, source: "source" }], summary: "oversized analyst secret ".repeat(200) }
    const omitted = task({ id: `task-${omittedRole}`, role: omittedRole, result: { structuredResult: oversizedResult } })
    const readable = omittedRole === "scout"
      ? task({ id: "task-analyst", role: "analyst", result: { structuredResult: analystResult } })
      : task({ id: "task-scout", result: { structuredResult: scoutResult } })
    const result = buildScoutAnalystAggregate([omitted, readable])
    const retainedRole = omittedRole === "scout" ? "analyst" : "scout"
    const retainedJobId = omittedRole === "scout" ? "job-2" : "job-1"

    expect(result).toMatchObject({ status: "partial", successfulRoles: [retainedRole], failedRoles: [], jobIds: [retainedJobId], failures: [] })
    expect(result?.successfulRoles).not.toContain(omittedRole)
    expect(result?.failedRoles).not.toContain(omittedRole)
    expect(JSON.stringify(result)).not.toContain(hiddenJobId)
    expect(JSON.stringify(result)).not.toContain("oversized scout secret")
    expect(JSON.stringify(result)).not.toContain("oversized analyst secret")
    expect(result && Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(2048)
  })

  it("keeps a known terminal failure when that role result is oversized", () => {
    const failedResult = { ...analystResult, summary: "oversized failed result ".repeat(200) }
    const result = buildScoutAnalystAggregate([
      task({ id: "scout", result: { structuredResult: scoutResult } }),
      task({ id: "analyst", role: "analyst", status: "failed", failureReason: "provider_timeout", result: { structuredResult: failedResult } }),
    ])
    expect(result).toMatchObject({
      status: "partial", successfulRoles: ["scout"], failedRoles: ["analyst"],
      failures: [{ role: "analyst", taskId: "analyst", reason: "provider_timeout" }],
    })
    expect(JSON.stringify(result)).not.toContain("oversized failed result")
  })

  it("omits the aggregate when the only completed structured result is oversized", () => {
    const oversizedResult = { ...scoutResult, summary: "oversized sole result ".repeat(200) }
    expect(buildScoutAnalystAggregate([task({ id: "scout", result: { structuredResult: oversizedResult } })])).toBeUndefined()
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
