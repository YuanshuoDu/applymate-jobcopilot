import { describe, expect, it, vi } from "vitest"
import { digestNativeVerificationValue } from "./subagents/native-verification-contract.js"
import type { NativeVerificationPort } from "./subagents/native-verification-port.js"
import type { TaskGraphReadScope } from "./subagents/task-graph-command-port.js"
import { readNativeVerificationRecovery } from "./canonical-turn-native-verification-recovery.js"

const scope: TaskGraphReadScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  turnLeaseOwner: "worker-1", turnLeaseVersion: 1, parentLeaseOwner: "worker-1", parentAttemptCount: 1,
}
const candidateText = "Recover this exact reviewed candidate."
const digest = digestNativeVerificationValue("owned")
const witness = { controlTaskId: "goal-review-1", controlOperationId: "goal-op-1", currentControlAttempt: 2,
  candidateDigest: digestNativeVerificationValue(candidateText), childBindingSetDigest: digest, goalDigest: digest,
  criteriaDigest: digest, evidencePacketDigest: digest, reportDigest: digest }

function port(value: unknown): NativeVerificationPort {
  return { ensureChildren: vi.fn(), ensureRootGoal: vi.fn(), readRecoverableGoal: vi.fn(async () => value as never) }
}

describe("readNativeVerificationRecovery", () => {
  it("recovers only the exact validated candidate and never sends it as feedback", async () => {
    const result = await readNativeVerificationRecovery({ port: port({ controlTaskId: "goal-review-1", candidateText, status: "pending", feedback: null }), scope })
    expect(result).toEqual({ candidateText })
    expect(result.feedback).toBeUndefined()
  })

  it("turns failed report criteria into bounded planner feedback without exposing evidence text", async () => {
    const result = await readNativeVerificationRecovery({ port: port({ controlTaskId: "goal-review-1", candidateText: null, status: "failed", feedback: {
      controlTaskId: "goal-review-1", targetTaskId: "root-1", disposition: "failed", criteria: [{
        criterionId: "criterion-1", disposition: "failed", reasonCode: "does_not_meet_criterion", evidenceReferenceIds: ["ref-safe"],
      }],
    } }), scope })
    expect(result.feedback).toContain("criterion=criterion-1")
    expect(result.feedback).not.toContain("ref-safe")
    expect(result.feedback?.length).toBeLessThanOrEqual(512)
  })

  it("rejects stale or malformed recovery authority", async () => {
    await expect(readNativeVerificationRecovery({ port: port({ controlTaskId: "goal-review-1", candidateText, status: "passed", feedback: null, witness: { ...witness, candidateDigest: digest } }), scope }))
      .rejects.toThrow("native_verification_recovery_invalid")
    await expect(readNativeVerificationRecovery({ port: port({ controlTaskId: "goal-review-1", candidateText, status: "pending", feedback: null, extraAuthority: true }), scope }))
      .rejects.toThrow("native_verification_recovery_invalid")
  })
})
