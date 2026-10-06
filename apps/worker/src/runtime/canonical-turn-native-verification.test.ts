import { describe, expect, it, vi } from "vitest"
import { digestNativeVerificationValue } from "./subagents/native-verification-contract.js"
import type { NativeVerificationFeedback } from "./subagents/native-verification-port.js"
import type { NativeVerificationPort } from "./subagents/native-verification-port.js"
import type { TaskGraphExecutionScope } from "./subagents/task-graph-command-port.js"
import type { DurableWaitResult } from "./tools/coordination-types.js"
import { NATIVE_SEMANTIC_NO_PROGRESS } from "./turns/turn-execution-types.js"
import { nativeVerificationCompletionGate, nativeVerificationFeedbackText, verifyNativeRootCandidate } from "./canonical-turn-native-verification.js"

const scope: TaskGraphExecutionScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "step-1", turnLeaseOwner: "worker-1", turnLeaseVersion: 1, parentLeaseOwner: "worker-1", parentAttemptCount: 1,
}
const candidateText = "Reviewed delivery with evidence."
const passed = { status: "passed" as const, controlTaskIds: ["child-review-1"], pendingControlTaskIds: [], pendingTaskIds: [], feedback: [] }
function rootPassed(text = candidateText) {
  const sha = digestNativeVerificationValue("binding")
  return { ...passed, controlTaskIds: ["goal-review-1"], rootGoalWitness: {
    controlTaskId: "goal-review-1", controlOperationId: "goal-op-1", currentControlAttempt: 1,
    candidateDigest: digestNativeVerificationValue(text), childBindingSetDigest: sha, goalDigest: sha,
    criteriaDigest: sha, evidencePacketDigest: sha, reportDigest: sha,
  } }
}
function rootFailed(input: Readonly<{ controlTaskId?: string; targetTaskId?: string; disposition?: "failed" | "uncertain" }> = {}) {
  const controlTaskId = input.controlTaskId ?? "owned-root-control"
  const disposition = input.disposition ?? "failed"
  return {
    status: disposition, controlTaskIds: [controlTaskId], pendingControlTaskIds: [], pendingTaskIds: [],
    feedback: [{ controlTaskId, targetTaskId: input.targetTaskId ?? "root-1", disposition,
      criteria: [{ criterionId: "owned-evidence", disposition, reasonCode: disposition === "failed" ? "does_not_meet_criterion" as const : "evidence_missing" as const, evidenceReferenceIds: [] }] }],
  }
}
const waitResult: DurableWaitResult = { waitId: "wait-1", status: "waiting", deadlineAt: "2099-01-01T00:00:00.000Z", matchedTaskIds: [] }

function criterionFeedback(input: Readonly<{
  reasonCode: NativeVerificationFeedback["criteria"][number]["reasonCode"]
  disposition: NativeVerificationFeedback["criteria"][number]["disposition"]
  targetTaskId?: string
  criterionId?: string
}>): NativeVerificationFeedback {
  return { controlTaskId: "review-1", targetTaskId: input.targetTaskId ?? "root-1", disposition: input.disposition,
    criteria: [{ criterionId: input.criterionId ?? "criterion-1", disposition: input.disposition,
      reasonCode: input.reasonCode, evidenceReferenceIds: [] }] }
}

describe("nativeVerificationFeedbackText", () => {
  it.each([
    { reasonCode: "evidence_missing", disposition: "uncertain" },
    { reasonCode: "evidence_conflict", disposition: "failed" },
    { reasonCode: "evidence_conflict", disposition: "uncertain" },
    { reasonCode: "does_not_meet_criterion", disposition: "failed" },
    { reasonCode: "unsupported_claim", disposition: "failed" },
    { reasonCode: "unsupported_claim", disposition: "uncertain" },
    { reasonCode: "ambiguous", disposition: "uncertain" },
  ] as const)("guides valid $disposition reason $reasonCode", ({ reasonCode, disposition }) => {
    const output = nativeVerificationFeedbackText(disposition, [criterionFeedback({ reasonCode, disposition })])
    expect(output).toContain(`${reasonCode}:`)
  })

  it("maps every validated non-passed reason to deterministic unique repair guidance", () => {
    const feedback = [
      criterionFeedback({ reasonCode: "ambiguous", disposition: "uncertain" }),
      criterionFeedback({ reasonCode: "unsupported_claim", disposition: "failed" }),
      criterionFeedback({ reasonCode: "evidence_missing", disposition: "uncertain" }),
      criterionFeedback({ reasonCode: "evidence_conflict", disposition: "failed" }),
      criterionFeedback({ reasonCode: "does_not_meet_criterion", disposition: "failed" }),
      criterionFeedback({ reasonCode: "evidence_missing", disposition: "uncertain", targetTaskId: "child-1" }),
    ]
    const output = nativeVerificationFeedbackText("failed", feedback)
    const actions = ["evidence_missing: gather current owned evidence.",
      "evidence_conflict: reconcile current owned sources and resolve contradictions.",
      "does_not_meet_criterion: revise the answer against the criterion.",
      "unsupported_claim: remove the claim or support it with current owned evidence.",
      "ambiguous: resolve ambiguity from evidence; identify missing user facts and seek clarification when available, otherwise state uncertainty."]
    let prior = -1
    for (const action of actions) {
      const position = output.indexOf(action)
      expect(position).toBeGreaterThan(prior)
      prior = position
    }
    expect(output.match(/evidence_missing: gather current owned evidence\./g)).toHaveLength(1)
    expect(output).not.toContain("evidenceReferenceIds")
    expect(output.length).toBeLessThanOrEqual(512)
  })

  it("omits passed and malformed reasons while retaining only the existing bounded generic fallback", () => {
    const passedFeedback = [{ controlTaskId: "review-1", targetTaskId: "root-1", disposition: "passed",
      criteria: [{ criterionId: "criterion-1", disposition: "passed", reasonCode: "meets_criterion", evidenceReferenceIds: [] }] }]
    expect(nativeVerificationFeedbackText("passed", passedFeedback)).not.toContain("Actions:")
    expect(nativeVerificationFeedbackText("passed", passedFeedback)).not.toContain("criterion=")
    const malformed = [{ controlTaskId: "review-1", targetTaskId: "root-1", disposition: "failed",
      criteria: [{ criterionId: "criterion-1", disposition: "failed", reasonCode: "invented", evidenceReferenceIds: [] }] }]
    expect(nativeVerificationFeedbackText("failed", malformed, true)).toBe("Independent native verification is failed.")
    expect(nativeVerificationFeedbackText("failed", [criterionFeedback({ reasonCode: "evidence_missing", disposition: "failed" })], true))
      .toBe("Independent native verification is failed.")
    expect(nativeVerificationFeedbackText("uncertain", [criterionFeedback({ reasonCode: "does_not_meet_criterion", disposition: "uncertain" })], true))
      .toBe("Independent native verification is uncertain.")
    const fallback = nativeVerificationFeedbackText("failed", [], true)
    expect(fallback).toContain("Replan against verified criteria using current owned evidence.")
    expect(fallback.length).toBeLessThanOrEqual(512)
  })

  it("preserves maximal complete criterion rows and skips rows that cannot fit without blocking later short rows", () => {
    const longTarget = "t".repeat(128), longCriterion = "c".repeat(128)
    const maximal = criterionFeedback({ reasonCode: "evidence_missing", disposition: "uncertain", targetTaskId: longTarget, criterionId: longCriterion })
    const maximalOutput = nativeVerificationFeedbackText("uncertain", [maximal])
    const maximalRow = `target=${longTarget} criterion=${longCriterion} status=uncertain reason=evidence_missing`
    expect(maximalOutput).toContain(maximalRow)
    expect(maximalOutput.length).toBeLessThanOrEqual(512)

    const crowded = [maximal,
      criterionFeedback({ reasonCode: "evidence_conflict", disposition: "failed", criterionId: "later-criterion" }),
      criterionFeedback({ reasonCode: "does_not_meet_criterion", disposition: "failed", criterionId: "last-criterion" })]
    const crowdedOutput = nativeVerificationFeedbackText("failed", crowded)
    expect(crowdedOutput).not.toContain(longCriterion)
    expect(crowdedOutput).toContain("criterion=later-criterion status=failed reason=evidence_conflict")
    expect(crowdedOutput.length).toBeLessThanOrEqual(512)
  })
})

describe("verifyNativeRootCandidate", () => {
  it("waits on producer-owned pending targets before creating a root candidate review", async () => {
    const port: NativeVerificationPort = {
      ensureChildren: vi.fn(async () => ({ status: "pending" as const, controlTaskIds: ["review-1"], pendingControlTaskIds: ["review-1"], pendingTaskIds: ["child-1", "review-1"], feedback: [] })),
      ensureRootGoal: vi.fn(async () => rootPassed()), readRecoverableGoal: vi.fn(async () => null),
    }
    const wait = vi.fn(async () => waitResult)
    const result = await verifyNativeRootCandidate({ port, scope, candidateText, wait })
    expect(result).toEqual({ kind: "pending", waitId: "wait-1" })
    expect(wait).toHaveBeenCalledWith(scope, ["child-1", "review-1"])
    expect(port.ensureRootGoal).not.toHaveBeenCalled()
  })

  it("accepts only a server witness bound to the exact candidate after children pass", async () => {
    const port: NativeVerificationPort = {
      ensureChildren: vi.fn(async () => passed),
      ensureRootGoal: vi.fn(async input => { expect(input.candidateText).toBe(candidateText); return rootPassed() }),
      readRecoverableGoal: vi.fn(async () => null),
    }
    const result = await verifyNativeRootCandidate({ port, scope, candidateText, wait: vi.fn() })
    expect(result.kind).toBe("passed")
  })

  it("rejects a witness for a different candidate and forwards bounded failure criteria", async () => {
    const port: NativeVerificationPort = {
      ensureChildren: vi.fn(async () => passed),
      ensureRootGoal: vi.fn(async () => rootPassed("different final")), readRecoverableGoal: vi.fn(async () => null),
    }
    expect(await verifyNativeRootCandidate({ port, scope, candidateText, wait: vi.fn() })).toEqual({
      kind: "blocked", feedback: "Independent root-goal verification is unavailable or malformed.",
    })
    const failed: NativeVerificationPort = {
      ...port,
      ensureChildren: vi.fn(async () => ({ status: "failed" as const, controlTaskIds: ["child-review-1"], pendingControlTaskIds: [], pendingTaskIds: [], feedback: [{
        controlTaskId: "child-review-1", targetTaskId: "child-1", disposition: "failed" as const,
        criteria: [{ criterionId: "evidence", disposition: "failed" as const, reasonCode: "does_not_meet_criterion" as const, evidenceReferenceIds: ["ref-1"] }],
      }] })),
      ensureRootGoal: vi.fn(async () => rootPassed()),
    }
    const result = await verifyNativeRootCandidate({ port: failed, scope, candidateText, wait: vi.fn() })
    expect(result).toMatchObject({ kind: "blocked", feedback: expect.stringContaining("criterion=evidence status=failed reason=does_not_meet_criterion") })
    if (result.kind !== "blocked") throw new Error("expected a blocked verification decision")
    expect(result.feedback.length).toBeLessThanOrEqual(512)
    expect(failed.ensureRootGoal).not.toHaveBeenCalled()
  })

  it("rechecks after an immediate ready wake without changing the candidate", async () => {
    let calls = 0
    const port: NativeVerificationPort = {
      ensureChildren: vi.fn(async () => ++calls === 1
        ? { status: "pending" as const, controlTaskIds: ["review-1"], pendingControlTaskIds: ["review-1"], pendingTaskIds: ["review-1"], feedback: [] }
        : passed),
      ensureRootGoal: vi.fn(async input => { expect(input.candidateText).toBe(candidateText); return rootPassed() }),
      readRecoverableGoal: vi.fn(async () => null),
    }
    const wait = vi.fn(async () => ({ ...waitResult, status: "ready" as const }))
    expect(await verifyNativeRootCandidate({ port, scope, candidateText, wait })).toMatchObject({ kind: "passed" })
    expect(port.ensureChildren).toHaveBeenCalledTimes(2)
    expect(port.ensureRootGoal).toHaveBeenCalledTimes(1)
  })
})

describe("nativeVerificationCompletionGate", () => {
  it("checks durable receipt and native graph before child/root verification and accepts only its witness", async () => {
    const order: string[] = []
    const witness = rootPassed().rootGoalWitness
    const port: NativeVerificationPort = {
      ensureChildren: vi.fn(async () => { order.push("children"); return passed }),
      ensureRootGoal: vi.fn(async () => { order.push("root-goal"); return rootPassed() }),
      readRecoverableGoal: vi.fn(async () => null),
    }
    let accepted: unknown
    const result = await nativeVerificationCompletionGate({
      candidateText, scope, port, hasNativeTasks: async () => { order.push("native-graph"); return true },
      checkReceipt: async () => { order.push("receipt"); return null }, wait: vi.fn(),
      accept: (value, text) => { accepted = { value, text } },
    })
    expect(result).toBeNull()
    expect(order).toEqual(["receipt", "native-graph", "children", "root-goal"])
    expect(accepted).toEqual({ value: witness, text: candidateText })
  })

  it("keeps a durable wait and missing graph receipt ahead of any verifier call", async () => {
    const port: NativeVerificationPort = {
      ensureChildren: vi.fn(async () => passed), ensureRootGoal: vi.fn(async () => rootPassed()), readRecoverableGoal: vi.fn(async () => null),
    }
    const receipt = { ok: false as const, blocker: "task_graph_verification_unverified", feedback: "receipt missing" }
    await expect(nativeVerificationCompletionGate({
      candidateText, scope, port, hasNativeTasks: vi.fn(async () => true), checkReceipt: async () => receipt,
      wait: vi.fn(), accept: vi.fn(),
    })).resolves.toEqual(receipt)
    expect(port.ensureChildren).not.toHaveBeenCalled()
  })

  it("signals only one strictly parsed failed root criterion tied to an owned root control", async () => {
    const port: NativeVerificationPort = {
      ensureChildren: vi.fn(async () => passed), ensureRootGoal: vi.fn(async () => rootFailed()), readRecoverableGoal: vi.fn(async () => null),
    }
    const observe = vi.fn(() => true)
    const result = await nativeVerificationCompletionGate({ candidateText, scope, port, hasNativeTasks: async () => true,
      checkReceipt: async () => null, wait: vi.fn(), accept: vi.fn(), observeRootSemanticRejection: observe })
    if (!result || result.ok) throw new Error("expected a rejected native verification decision")
    expect(result[NATIVE_SEMANTIC_NO_PROGRESS]).toBe(true)
    expect(result.feedback).toContain("criterion=owned-evidence status=failed reason=does_not_meet_criterion")
    expect(result.feedback).toContain("does_not_meet_criterion: revise the answer against the criterion.")
    expect(JSON.stringify(result)).not.toContain("owned-root-control")
    expect(observe).toHaveBeenCalledWith("owned-root-control")
  })

  it("does not count foreign, duplicate, uncertain, or control-unowned root feedback", async () => {
    const valid = rootFailed().feedback[0]!
    const cases = [
      { ...rootFailed({ targetTaskId: "child-1" }), controlTaskIds: ["owned-root-control"] },
      { ...rootFailed(), feedback: [valid, valid] },
      rootFailed({ disposition: "uncertain" }),
      { ...rootFailed(), controlTaskIds: ["different-owned-control"] },
    ]
    for (const result of cases) {
      const port: NativeVerificationPort = {
        ensureChildren: vi.fn(async () => passed), ensureRootGoal: vi.fn(async () => result), readRecoverableGoal: vi.fn(async () => null),
      }
      const observe = vi.fn(() => true)
      const decision = await nativeVerificationCompletionGate({ candidateText, scope, port, hasNativeTasks: async () => true,
        checkReceipt: async () => null, wait: vi.fn(), accept: vi.fn(), observeRootSemanticRejection: observe })
      expect(decision && !decision.ok ? decision[NATIVE_SEMANTIC_NO_PROGRESS] : undefined).toBeUndefined()
      expect(observe).not.toHaveBeenCalled()
    }
  })
})
