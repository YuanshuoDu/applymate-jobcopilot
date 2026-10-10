import { describe, expect, it } from "vitest"

import type { CoordinationTaskView } from "./coordination-types.js"
import { buildScoutAnalystAggregate, validatedStructuredResult } from "./coordination-result-aggregate.js"

const base: CoordinationTaskView = {
  id: "task", userId: "user", sessionId: "session", turnId: "turn", rootTaskId: "root", parentTaskId: "root", path: "/root/task", depth: 1,
  role: "scout", taskType: "read", status: "completed", goal: "goal", attemptCount: 1, maxAttempts: 1, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null,
}
const scoutResult = { schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "completed", candidates: [{ jobId: "job-1", source: "source", url: null, evidenceIds: ["e-1"] }], evidence: [{ id: "e-1", kind: "job", ref: "job-1", source: "source" }], summary: "found" }
const analystResult = { schemaVersion: scoutResult.schemaVersion, role: "analyst", status: "completed", findings: [{ jobId: "job-1", score: 8, evidenceIds: ["e-1"] }], evidence: scoutResult.evidence, summary: "scored" }
const oversizedScoutResult = {
  ...scoutResult,
  candidates: [{ jobId: "oversized-scout-job", source: "source", url: null, evidenceIds: ["oversized-scout-evidence"] }],
  evidence: [{ id: "oversized-scout-evidence", kind: "job" as const, ref: "oversized-scout-job", source: "source" }],
  summary: `oversized-scout-payload-${"x".repeat(4096)}`,
}
const oversizedAnalystResult = {
  ...analystResult,
  findings: [{ jobId: "oversized-analyst-job", score: 9, evidenceIds: ["oversized-analyst-evidence"] }],
  evidence: [{ id: "oversized-analyst-evidence", kind: "job" as const, ref: "oversized-analyst-job", source: "source" }],
  summary: `oversized-analyst-payload-${"x".repeat(4096)}`,
}
function task(overrides: Partial<CoordinationTaskView>): CoordinationTaskView { return { ...base, ...overrides } }

describe("coordination result aggregate", () => {
  it("derives a bounded aggregate from valid roles", () => {
    const result = buildScoutAnalystAggregate([task({ id: "scout", result: { structuredResult: scoutResult } }), task({ id: "analyst", role: "analyst", result: { structuredResult: analystResult } })])
    expect(result).toMatchObject({ status: "completed", successfulRoles: ["scout", "analyst"], jobIds: ["job-1"] })
  })

  it("keeps readable facts when the other completed role result is oversized", () => {
    expect(validatedStructuredResult(task({ id: "oversized-scout", result: { structuredResult: oversizedScoutResult } })))
      .toMatchObject({ invalid: false, result: { role: "scout" } })
    expect(validatedStructuredResult(task({ id: "oversized-analyst", role: "analyst", result: { structuredResult: oversizedAnalystResult } })))
      .toMatchObject({ invalid: false, result: { role: "analyst" } })

    const readableScout = buildScoutAnalystAggregate([
      task({ id: "scout", result: { structuredResult: scoutResult } }),
      task({ id: "analyst", role: "analyst", result: { structuredResult: oversizedAnalystResult } }),
    ])
    expect(readableScout).toMatchObject({ status: "partial", successfulRoles: ["scout"], failedRoles: [], jobIds: ["job-1"] })
    const scoutOutput = JSON.stringify(readableScout ?? null)
    expect(scoutOutput).not.toContain("oversized-analyst-job")
    expect(scoutOutput).not.toContain("oversized-analyst-payload")

    const readableAnalyst = buildScoutAnalystAggregate([
      task({ id: "scout", result: { structuredResult: oversizedScoutResult } }),
      task({ id: "analyst", role: "analyst", result: { structuredResult: analystResult } }),
    ])
    expect(readableAnalyst).toMatchObject({ status: "partial", successfulRoles: ["analyst"], failedRoles: [], jobIds: ["job-1"] })
    const analystOutput = JSON.stringify(readableAnalyst ?? null)
    expect(analystOutput).not.toContain("oversized-scout-job")
    expect(analystOutput).not.toContain("oversized-scout-payload")
  })

  it("includes failed and pending role states", () => {
    const result = buildScoutAnalystAggregate([task({ id: "scout", result: { structuredResult: scoutResult } }), task({ id: "analyst", role: "analyst", status: "completed", result: { structuredResult: { role: "wrong" } } })])
    expect(result).toMatchObject({ status: "partial", successfulRoles: ["scout"], failedRoles: ["analyst"] })
    const pending = buildScoutAnalystAggregate([task({ id: "scout", result: { structuredResult: scoutResult } }), task({ id: "analyst", role: "analyst", status: "running", result: { structuredResult: { secret: "hidden" } } })])
    expect(pending).toMatchObject({ status: "pending", pendingRoles: ["analyst"] })
  })

  it("does not read a non-completed terminal payload and preserves its known failure", () => {
    const failedAnalyst = task({ id: "analyst", role: "analyst", status: "failed", failureReason: "known_failure_reason" })
    let payloadReads = 0
    Object.defineProperty(failedAnalyst, "result", {
      get() { payloadReads += 1; return { structuredResult: oversizedAnalystResult } },
    })
    const result = buildScoutAnalystAggregate([
      task({ id: "scout", result: { structuredResult: scoutResult } }),
      failedAnalyst,
    ])
    expect(payloadReads).toBe(0)
    expect(result).toMatchObject({
      status: "partial", successfulRoles: ["scout"], failedRoles: ["analyst"],
      failures: [{ role: "analyst", taskId: "analyst", reason: "known_failure_reason" }],
    })
  })

  it("keeps a pending role pending when its result is oversized", () => {
    const result = buildScoutAnalystAggregate([
      task({ id: "scout", result: { structuredResult: scoutResult } }),
      task({ id: "analyst", role: "analyst", status: "running", result: { structuredResult: oversizedAnalystResult } }),
    ])
    expect(result).toMatchObject({ status: "pending", successfulRoles: ["scout"], pendingRoles: ["analyst"] })
  })

  it("omits an aggregate when oversized completed results leave no readable role", () => {
    expect(buildScoutAnalystAggregate([task({ result: { structuredResult: oversizedScoutResult } })])).toBeUndefined()
    expect(buildScoutAnalystAggregate([
      task({ id: "scout", result: { structuredResult: oversizedScoutResult } }),
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
    expect(result?.jobIds.length).toBeLessThanOrEqual(64)
  })

  it("keeps legacy unstructured tasks compatible", () => {
    expect(buildScoutAnalystAggregate([task({ result: { summary: "legacy" } })])).toBeUndefined()
    expect(validatedStructuredResult(task({ result: { summary: "legacy" } }))).toEqual({ result: null, invalid: false })
  })
})
