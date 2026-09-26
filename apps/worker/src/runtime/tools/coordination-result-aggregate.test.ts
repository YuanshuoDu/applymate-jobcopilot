import { describe, expect, it } from "vitest"

import type { CoordinationTaskView } from "./coordination-types.js"
import { buildScoutAnalystAggregate, validatedStructuredResult } from "./coordination-result-aggregate.js"

const base: CoordinationTaskView = {
  id: "task", userId: "user", sessionId: "session", turnId: "turn", rootTaskId: "root", parentTaskId: "root", path: "/root/task", depth: 1,
  role: "scout", taskType: "read", status: "completed", goal: "goal", attemptCount: 1, maxAttempts: 1, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null,
}
const scoutResult = { schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "completed", candidates: [{ jobId: "job-1", source: "source", url: null, evidenceIds: ["e-1"] }], evidence: [{ id: "e-1", kind: "job", ref: "job-1", source: "source" }], summary: "found" }
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
