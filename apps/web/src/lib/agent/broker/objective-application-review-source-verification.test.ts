import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { parseObjectiveApplicationTypedSourceResult, parseObjectiveVerifiedSourceResultForRead } from "./objective-application-review-source-verification"

const digest = "a".repeat(64)

describe("persisted typed Objective source result", () => {
  it("accepts a Worker Scout report, discovery sidecar, and JSON-string-aware result digest", () => {
    const value = sourceResult("scout", { summary: '{"z":1,"a":2}' })
    value.discoveryAttempt = {
      attemptCount: 1,
      health: { schemaVersion: "agent-harness.v2.task-graph.discovery-attempt-health.v1", attemptedCalls: 1,
        completedCalls: 1, failedCalls: 0, unresolvedCalls: 0, candidateCount: 1, providerFailures: 0,
        materializationFailures: 0, hasMore: false },
      queryFootprint: { schemaVersion: "agent-harness.v2.task-graph.discovery-query-footprint.v1", availability: "available",
        calls: [{ criteria: { targetRoles: ["Engineer"], targetLocations: ["Dublin"], hasCursor: false }, outcome: "completed",
          requestCount: 1, observedCandidateCount: 1, providerFailures: 0, materializationFailures: 0, hasMore: false }] },
    }
    expect(parseObjectiveApplicationTypedSourceResult(value, "scout", "scout-task")).toEqual(value.structuredResult)
  })

  it("accepts bounded passed Analyst dependency bindings and a valid repair receipt", () => {
    const analyst = sourceResult("analyst")
    analyst.taskGraphVerificationReport.dependencyBindings = [{ nodeKey: "scout-node", taskId: "scout-task", attemptCount: 1,
      nodeDigest: digest, resultDigest: digest, evidenceDigest: digest, reportDigest: digest }]
    expect(parseObjectiveApplicationTypedSourceResult(analyst, "analyst", "analyst-task")).toEqual(analyst.structuredResult)
    const repaired = sourceResult("scout")
    repaired.taskGraphRepairReceipt = { schemaVersion: "agent-harness.v2.task-graph-repair-receipt.v1", graphRootTaskId: "root-task",
      targetNodeKey: "scout-original", targetTaskId: "scout-original-task", criterionIds: ["candidate-count"],
      repairNodeKey: "scout-repair", repairTaskId: "scout-repair-task", verifierVersion: "agent-harness.v2.task-graph-verifier.v1",
      evidenceDigest: digest }
    expect(parseObjectiveApplicationTypedSourceResult(repaired, "scout", "scout-repair-task")).toEqual(repaired.structuredResult)
  })

  it("rejects missing, failed, tampered, or extra persisted proof fields", () => {
    const baseline = sourceResult("scout")
    expect(parseObjectiveApplicationTypedSourceResult({ ...baseline, taskGraphVerificationReport: undefined }, "scout", "scout-task")).toBeUndefined()
    expect(parseObjectiveApplicationTypedSourceResult({ ...baseline, taskGraphVerificationReport: {
      ...baseline.taskGraphVerificationReport, status: "failed",
    } }, "scout", "scout-task")).toBeUndefined()
    expect(parseObjectiveApplicationTypedSourceResult({ ...baseline, structuredResult: { ...baseline.structuredResult, status: "partial" } }, "scout", "scout-task")).toBeUndefined()
    expect(parseObjectiveApplicationTypedSourceResult({ ...baseline, extra: true }, "scout", "scout-task")).toBeUndefined()
    expect(parseObjectiveApplicationTypedSourceResult(baseline, "analyst", "scout-task")).toBeUndefined()
    expect(parseObjectiveApplicationTypedSourceResult({ ...baseline, taskGraphVerificationReport: {
      ...baseline.taskGraphVerificationReport, criteria: [{ criterionId: "candidate-count", status: "passed", reasonCode: "criteria_met" },
        { criterionId: "candidate-count", status: "passed", reasonCode: "criteria_met" }],
    } }, "scout", "scout-task")).toBeUndefined()
    expect(parseObjectiveApplicationTypedSourceResult({ ...baseline, taskGraphVerificationReport: {
      ...baseline.taskGraphVerificationReport, resultDigest: "b".repeat(64),
    } }, "scout", "scout-task")).toBeUndefined()
    expect(parseObjectiveApplicationTypedSourceResult({ ...baseline, discoveryAttempt: { attemptCount: 1, health: {} } }, "scout", "scout-task")).toBeUndefined()
  })

  it("keeps partial results read-only while the application reader remains completed-only", () => {
    const partial = sourceResult("scout")
    partial.structuredResult = { ...partial.structuredResult, status: "partial" }
    partial.taskGraphVerificationReport.resultDigest = workerDigest(partial.structuredResult)
    expect(parseObjectiveApplicationTypedSourceResult(partial, "scout", "scout-task")).toBeUndefined()
    expect(parseObjectiveVerifiedSourceResultForRead(partial, "scout", "scout-task")).toEqual(partial.structuredResult)
    partial.taskGraphVerificationReport.resultDigest = digest
    expect(parseObjectiveVerifiedSourceResultForRead(partial, "scout", "scout-task")).toBeUndefined()
  })
})

function sourceResult(role: "scout" | "analyst", extra: Record<string, unknown> = {}) {
  const structuredResult = { schemaVersion: "agent-harness.v2.subagent.result", role, status: "completed", ...extra }
  const report: Record<string, unknown> = { verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status: "passed",
    reasonCode: "criteria_met", criteria: [{ criterionId: role === "scout" ? "candidate-count" : "finding-count",
      status: "passed", reasonCode: "criteria_met" }], evidenceDigest: digest, resultDigest: workerDigest(structuredResult) }
  return { finalItemId: null, finalText: "completed", status: "completed", stepCount: 1, toolCallCount: 1,
    structuredResult, taskGraphVerificationReport: report } as {
      finalItemId: null; finalText: string; status: string; stepCount: number; toolCallCount: number;
      structuredResult: Record<string, unknown>; taskGraphVerificationReport: Record<string, unknown>;
      discoveryAttempt?: unknown; taskGraphRepairReceipt?: unknown;
    }
}

function workerDigest(value: unknown): string { return createHash("sha256").update(workerCanonicalJson(value)).digest("hex") }
function workerCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(workerCanonicalJson).join(",")}]`
  const row = jsonObject(value)
  if (row) return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${workerCanonicalJson(row[key])}`).join(",")}}`
  return JSON.stringify(value) ?? ""
}
function jsonObject(value: unknown): Record<string, unknown> | undefined {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return undefined } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
}
