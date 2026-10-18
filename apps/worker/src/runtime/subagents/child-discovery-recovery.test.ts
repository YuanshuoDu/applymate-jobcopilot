import { describe, expect, it, vi } from "vitest"
import type { DiscoveryAttemptLifecycleEvent, LifecycleCall } from "../tools/lifecycle.js"
import { createChildDiscoveryRecoveryCollector } from "./child-discovery-recovery.js"
import { DISCOVERY_RECOVERY_SCHEMA_VERSION, MAX_DISCOVERY_RECOVERY_JOB_IDS } from "./task-graph-discovery-recovery-contract.js"

const fence = { taskId: "task-1", rootTaskId: "root-1", sessionId: "session-1", turnId: "turn-1", attemptCount: 2 }
const jobId = (number: number) => `c${number.toString(36).padStart(24, "0")}`
const call = (id: string, overrides: Partial<LifecycleCall> = {}): LifecycleCall => ({
  id, toolName: "jobs.discover", toolVersion: "1", sessionId: fence.sessionId, turnId: fence.turnId,
  stepId: "step-1", taskId: fence.taskId, rootTaskId: fence.rootTaskId, ...overrides,
})
function receipt(ids: readonly string[], currentCall: LifecycleCall = call("discover-1")) {
  return {
    jobs: ids.map(id => ({
      id, title: "Engineer", company: "Example", location: "Dublin", url: "https://example.test/job",
      description: "Role", fullDescription: "Role", salary: null, logo: null, source: "greenhouse", evidenceRefs: ["source-1"],
    })),
    evidence: [], nextCursor: null,
    usage: {
      ledgerKey: "ledger-1", toolName: currentCall.toolName, toolVersion: currentCall.toolVersion,
      toolCallId: currentCall.id, sessionId: currentCall.sessionId, turnId: currentCall.turnId, stepId: currentCall.stepId,
      requests: 1, jobsProcessed: ids.length, jobsSucceeded: ids.length, jobsFailed: 0, providerFailures: 0,
      aiCalls: 0, providers: ["greenhouse"], estimatedCostUsd: 0, durationMs: 1,
    },
  }
}
function event(phase: DiscoveryAttemptLifecycleEvent["phase"], currentCall: LifecycleCall, output?: unknown): DiscoveryAttemptLifecycleEvent {
  return phase === "started" ? { phase, call: currentCall } : { phase, call: currentCall, output }
}
function pair(collector: ReturnType<typeof createChildDiscoveryRecoveryCollector>, currentCall: LifecycleCall, output: unknown): void {
  collector.observeLifecycleEvent(event("started", currentCall))
  collector.observeLifecycleEvent(event("completed", currentCall, output))
}

describe("failed Scout discovery recovery collector", () => {
  it("keeps only IDs from a started, completed, identity-matched persisted receipt", () => {
    const collector = createChildDiscoveryRecoveryCollector(fence), currentCall = call("discover-1")
    const output = receipt([jobId(1), jobId(2)], currentCall)
    pair(collector, currentCall, output)
    collector.observeLifecycleEvent(event("started", currentCall))
    collector.observeLifecycleEvent(event("completed", currentCall, output))
    collector.observeLifecycleEvent(event("started", call("discover-failed")))
    collector.observeLifecycleEvent(event("failed", call("discover-failed"), { message: "provider failed" }))

    expect(collector.recovery()).toEqual({
      schemaVersion: DISCOVERY_RECOVERY_SCHEMA_VERSION, attemptCount: fence.attemptCount,
      jobIds: [jobId(1), jobId(2)], truncated: false,
    })
  })

  it("records an accepted empty receipt and keeps exactly 24 unique IDs untruncated", () => {
    const empty = createChildDiscoveryRecoveryCollector(fence)
    pair(empty, call("empty"), receipt([] , call("empty")))
    expect(empty.recovery()).toMatchObject({ jobIds: [], truncated: false })

    const exact = createChildDiscoveryRecoveryCollector(fence)
    const ids = Array.from({ length: MAX_DISCOVERY_RECOVERY_JOB_IDS }, (_, index) => jobId(index + 1))
    pair(exact, call("exact"), receipt(ids, call("exact")))
    expect(exact.recovery()).toMatchObject({ jobIds: ids, truncated: false })
  })

  it("deduplicates receipt order before the cap and marks a 25th unique ID truncated", () => {
    const collector = createChildDiscoveryRecoveryCollector(fence)
    const ids = Array.from({ length: 26 }, (_, index) => jobId(index + 1))
    pair(collector, call("first"), receipt([ids[0]!, ids[1]!, ids[1]!, ...ids.slice(2)], call("first")))
    pair(collector, call("second"), receipt([ids[0]!, ids[24]!, ids[25]!], call("second")))
    expect(collector.recovery()).toEqual({
      schemaVersion: DISCOVERY_RECOVERY_SCHEMA_VERSION, attemptCount: fence.attemptCount,
      jobIds: ids.slice(0, MAX_DISCOVERY_RECOVERY_JOB_IDS), truncated: true,
    })
  })

  it("rejects oversized strings before serializing the receipt", () => {
    const collector = createChildDiscoveryRecoveryCollector(fence), currentCall = call("oversized")
    const output = receipt([jobId(1)], currentCall)
    const oversized = "x".repeat(1_048_576)
    output.jobs[0]!.description = oversized
    const stringify = vi.spyOn(JSON, "stringify")
    try {
      pair(collector, currentCall, output)
      expect(collector.recovery()).toBeUndefined()
      expect(stringify).not.toHaveBeenCalledWith(oversized)
    } finally { stringify.mockRestore() }
  })

  it("rejects primitive-heavy nested output at the traversal node cap", () => {
    const collector = createChildDiscoveryRecoveryCollector(fence), currentCall = call("primitive-heavy")
    const output = receipt([jobId(1)], currentCall)
    ;(output.jobs[0] as unknown as Record<string, unknown>).company = Array.from({ length: 20_001 }, (_, index) => index)
    pair(collector, currentCall, output)
    expect(collector.recovery()).toBeUndefined()
  })

  it("omits recovery when no successful completed discovery receipt was observed", () => {
    const failed = createChildDiscoveryRecoveryCollector(fence), failedCall = call("failed")
    failed.observeLifecycleEvent(event("started", failedCall))
    failed.observeLifecycleEvent(event("failed", failedCall, { usage: { requests: 1 } }))
    expect(failed.recovery()).toBeUndefined()

    const unmatched = createChildDiscoveryRecoveryCollector(fence), unmatchedCall = call("unmatched")
    unmatched.observeLifecycleEvent(event("completed", unmatchedCall, receipt([jobId(1)], unmatchedCall)))
    expect(unmatched.recovery()).toBeUndefined()
  })

  it("fails closed for malformed IDs, usage identity mismatch, conflicting callbacks, or foreign fence", () => {
    const invalidId = createChildDiscoveryRecoveryCollector(fence), invalidCall = call("bad-id")
    pair(invalidId, invalidCall, receipt(["provider-job-id"], invalidCall))
    expect(invalidId.recovery()).toBeUndefined()

    const invalidUsage = createChildDiscoveryRecoveryCollector(fence), usageCall = call("bad-usage")
    const wrongUsage = receipt([jobId(1)], usageCall)
    wrongUsage.usage.toolCallId = "other-call"
    pair(invalidUsage, usageCall, wrongUsage)
    expect(invalidUsage.recovery()).toBeUndefined()

    const conflict = createChildDiscoveryRecoveryCollector(fence), conflictCall = call("conflict")
    pair(conflict, conflictCall, receipt([jobId(1)], conflictCall))
    conflict.observeLifecycleEvent(event("completed", conflictCall, receipt([jobId(2)], conflictCall)))
    expect(conflict.recovery()).toBeUndefined()

    const foreign = createChildDiscoveryRecoveryCollector(fence), foreignCall = call("foreign", { taskId: "other-task" })
    pair(foreign, foreignCall, receipt([jobId(1)], foreignCall))
    expect(foreign.recovery()).toBeUndefined()
  })

  it("fails closed when more than 32 distinct calls are observed", () => {
    const collector = createChildDiscoveryRecoveryCollector(fence)
    for (let index = 0; index < 33; index += 1) {
      const currentCall = call(`call-${index}`)
      pair(collector, currentCall, receipt([], currentCall))
    }
    expect(collector.recovery()).toBeUndefined()
  })

  it("omits recovery for an invalid attempt fence", () => {
    const collector = createChildDiscoveryRecoveryCollector({ ...fence, attemptCount: 0 })
    const currentCall = call("attempt-invalid")
    pair(collector, currentCall, receipt([jobId(1)], currentCall))
    expect(collector.recovery()).toBeUndefined()
  })
})
