import { describe, expect, it, vi } from "vitest"
import { digestNativeVerificationValue } from "./subagents/native-verification-contract.js"
import type { NativeVerificationEnsureResult, NativeVerificationFeedback, NativeVerificationPort } from "./subagents/native-verification-port.js"
import type { TaskGraphExecutionScope, TaskGraphReadScope } from "./subagents/task-graph-command-port.js"
import { readNativeVerificationRecovery } from "./canonical-turn-native-verification-recovery.js"
import { nativeVerificationFeedbackText, verifyNativeRootCandidate } from "./canonical-turn-native-verification.js"

const scope: TaskGraphReadScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  turnLeaseOwner: "worker-1", turnLeaseVersion: 1, parentLeaseOwner: "worker-1", parentAttemptCount: 1,
}
const executionScope: TaskGraphExecutionScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", stepId: "step-1",
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

function freshPort(rootResult: NativeVerificationEnsureResult): NativeVerificationPort {
  const childrenPassed: NativeVerificationEnsureResult = { status: "passed", controlTaskIds: ["child-review-1"],
    pendingControlTaskIds: [], pendingTaskIds: [], feedback: [] }
  return { ensureChildren: vi.fn(async () => childrenPassed), ensureRootGoal: vi.fn(async () => rootResult),
    readRecoverableGoal: vi.fn(async () => null) }
}

const validReasonPairings = [
  { reasonCode: "evidence_missing", disposition: "uncertain" },
  { reasonCode: "evidence_conflict", disposition: "failed" },
  { reasonCode: "evidence_conflict", disposition: "uncertain" },
  { reasonCode: "does_not_meet_criterion", disposition: "failed" },
  { reasonCode: "unsupported_claim", disposition: "failed" },
  { reasonCode: "unsupported_claim", disposition: "uncertain" },
  { reasonCode: "ambiguous", disposition: "uncertain" },
] as const

describe("readNativeVerificationRecovery", () => {
  it("recovers only the exact validated candidate and never sends it as feedback", async () => {
    const result = await readNativeVerificationRecovery({ port: port({ controlTaskId: "goal-review-1", candidateText, status: "pending", feedback: null }), scope })
    expect(result).toEqual({ candidateText })
    expect(result.feedback).toBeUndefined()
  })

  it("turns failed report criteria into bounded planner feedback without exposing evidence text", async () => {
    const feedback = {
      controlTaskId: "goal-review-1", targetTaskId: "root-1", disposition: "failed", criteria: [{
        criterionId: "criterion-1", disposition: "failed", reasonCode: "does_not_meet_criterion", evidenceReferenceIds: ["ref-safe"],
      }],
    }
    const result = await readNativeVerificationRecovery({ port: port({ controlTaskId: "goal-review-1", candidateText: null, status: "failed", feedback }), scope })
    expect(result.feedback).toContain("criterion=criterion-1")
    expect(result.feedback).toContain("does_not_meet_criterion: revise the answer against the criterion.")
    expect(result.feedback).toBe(nativeVerificationFeedbackText("failed", [feedback]))
    expect(result.feedback).not.toContain("ref-safe")
    expect(result.feedback?.length).toBeLessThanOrEqual(512)
  })

  for (const { reasonCode, disposition } of validReasonPairings) {
    it(`matches fresh and recovered ${disposition}/${reasonCode} feedback exactly`, async () => {
      const feedback: NativeVerificationFeedback = { controlTaskId: "goal-review-1", targetTaskId: "root-1", disposition, criteria: [{
        criterionId: "criterion-1", disposition, reasonCode, evidenceReferenceIds: ["private-ref-marker", digest],
      }] }
      const rootResult: NativeVerificationEnsureResult = { status: disposition, controlTaskIds: ["goal-review-1"],
        pendingControlTaskIds: [], pendingTaskIds: [], feedback: [feedback] }
      const fresh = await verifyNativeRootCandidate({ port: freshPort(rootResult), scope: executionScope, candidateText, wait: vi.fn() })
      if (fresh.kind !== "blocked") throw new Error("expected fresh verification to return feedback")

      const recovered = await readNativeVerificationRecovery({ port: port({
        controlTaskId: "goal-review-1", candidateText: null, status: disposition, feedback,
      }), scope })
      expect(recovered.feedback).toBe(nativeVerificationFeedbackText(disposition, [feedback]))
      expect(recovered.feedback).toBe(fresh.feedback)
      expect(fresh.feedback).toContain(`${reasonCode}:`)
      expect(fresh.feedback.indexOf("Actions:")).toBeLessThan(fresh.feedback.indexOf("target=root-1 criterion=criterion-1"))
      expect(fresh.feedback).not.toContain("Replan against verified criteria using current owned evidence.")
      expect(fresh.feedback).not.toContain("private-ref-marker")
      expect(fresh.feedback).not.toContain(digest)
      expect(fresh.feedback).not.toContain(candidateText)
      expect(fresh.feedback).not.toContain("goal-review-1")
      expect(fresh.feedback).not.toContain("controlTaskId")
      expect(fresh.feedback.length).toBeLessThanOrEqual(512)
    })
  }

  it("keeps empty failed rows and invalid reason pairings fail-closed in fresh and recovered feedback", async () => {
    const cases: ReadonlyArray<Readonly<{ report: NativeVerificationFeedback; expected: string }>> = [
      { report: { controlTaskId: "goal-review-1", targetTaskId: "root-1", disposition: "failed", criteria: [] },
        expected: "Independent native verification is failed." },
      { report: { controlTaskId: "goal-review-1", targetTaskId: "root-1", disposition: "failed", criteria: [{
        criterionId: "criterion-1", disposition: "failed", reasonCode: "meets_criterion", evidenceReferenceIds: [],
      }] }, expected: "Independent native verification is failed." },
    ]
    for (const { report, expected } of cases) {
      const rootResult: NativeVerificationEnsureResult = { status: "failed", controlTaskIds: ["goal-review-1"],
        pendingControlTaskIds: [], pendingTaskIds: [], feedback: [report] }
      const fresh = await verifyNativeRootCandidate({ port: freshPort(rootResult), scope: executionScope, candidateText, wait: vi.fn() })
      if (fresh.kind !== "blocked") throw new Error("expected failed verification to return feedback")
      const recovered = await readNativeVerificationRecovery({ port: port({
        controlTaskId: "goal-review-1", candidateText: null, status: "failed", feedback: report,
      }), scope })
      expect(fresh.feedback).toBe(expected)
      expect(recovered.feedback).toBe(fresh.feedback)
      expect(fresh.feedback).not.toContain("Actions:")
      expect(fresh.feedback).not.toContain("Replan against verified criteria using current owned evidence.")
      expect(fresh.feedback.length).toBeLessThanOrEqual(512)
    }
  })

  it("rejects stale or malformed recovery authority", async () => {
    await expect(readNativeVerificationRecovery({ port: port({ controlTaskId: "goal-review-1", candidateText, status: "passed", feedback: null, witness: { ...witness, candidateDigest: digest } }), scope }))
      .rejects.toThrow("native_verification_recovery_invalid")
    await expect(readNativeVerificationRecovery({ port: port({ controlTaskId: "goal-review-1", candidateText, status: "pending", feedback: null, extraAuthority: true }), scope }))
      .rejects.toThrow("native_verification_recovery_invalid")
    await expect(readNativeVerificationRecovery({ port: port({ controlTaskId: "goal-review-1", candidateText: null, status: "failed", feedback: {
      controlTaskId: "goal-review-1", targetTaskId: "root-1", disposition: "failed", criteria: [{
        criterionId: "criterion-1", disposition: "failed", reasonCode: "invented", evidenceReferenceIds: [],
      }],
    } }), scope })).rejects.toThrow("native_verification_recovery_invalid")
  })
})
