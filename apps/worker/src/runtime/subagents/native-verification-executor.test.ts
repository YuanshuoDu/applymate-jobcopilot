import { describe, expect, it, vi } from "vitest"
import type { ModelAdapter } from "@jobcopilot/agent-model"

import { executionOwnerFence } from "../execution-owner.js"
import type { TurnExecutionStore } from "../turns/turn-execution-types.js"
import type { SubagentLease } from "./types.js"
import type { TreeBudgetReservationStore } from "./tree-budget-types.js"
import { NATIVE_VERIFICATION_CONTROL_SCHEMA, type NativeVerificationControl } from "./native-verification-contract.js"
import { dispatchNativeVerificationTask, hasNativeVerificationControlIntent } from "./native-verification-executor.js"

const profile = {
  provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false,
  supportsParallelTools: false, supportsStreamingToolArgs: true, supportsReasoningSummary: true, supportsResponseContinuation: false,
  supportsProviderConversation: false, supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low" as const,
}

function fixture() {
  const lease: SubagentLease = {
    id: "verify-task", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/verify-task", depth: 1,
    role: "auditor", taskType: "native_verification", status: "running", goal: "private goal", constraints: [], successCriteria: [], allowedActions: [], context: {}, expectedOutputSchema: {},
    modelProfileSnapshot: { provider: "fixture", model: "fixture-model" }, result: null, failureReason: null, attemptCount: 1, maxAttempts: 2, leaseOwner: "worker-1",
    leaseExpiresAt: new Date("2026-09-09T12:00:00.000Z"), interruptRequestedAt: null, budgetSnapshot: { subagentPolicy: { maxAttempts: 2 } }, toolPolicySnapshot: {}, ownerId: "worker-1", signal: new AbortController().signal,
  }
  const control: NativeVerificationControl = {
    schemaVersion: NATIVE_VERIFICATION_CONTROL_SCHEMA, controlOperationId: "verify-op", controlTaskId: lease.id,
    owner: { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId!, rootTaskId: lease.rootTaskId, parentTaskId: lease.parentTaskId },
    target: { kind: "child", nodeId: "node-1", nativeOperationId: "native-op-1", fingerprint: "a".repeat(64), taskId: "target-task", attempt: 1, resultDigest: "b".repeat(64) },
    goalDigest: "c".repeat(64), criteriaDigest: "d".repeat(64), evidencePacketDigest: "e".repeat(64),
  }
  const readRootLimits = vi.fn(async () => undefined)
  const model: ModelAdapter = { id: "fixture-model", profile, async *stream() { yield { type: "completed", finishReason: "stop" } } }
  const resolveModel = vi.fn(() => model)
  const input = {
    lease: { ...lease, expectedOutputSchema: control }, owner: executionOwnerFence({ kind: "task", lease }),
    store: {} as TurnExecutionStore, treeBudget: { readRootLimits } as unknown as TreeBudgetReservationStore,
    authorizeUsage: async () => ({ settle: async () => undefined }), resolveModel,
  }
  return { lease, control, input, readRootLimits, resolveModel }
}

describe("native verification dispatch classification", () => {
  it("leaves ordinary Auditor schema markers on the existing executor path", async () => {
    const { input, readRootLimits, resolveModel } = fixture()
    const result = await dispatchNativeVerificationTask({ ...input, lease: { ...input.lease, expectedOutputSchema: { schemaVersion: "ordinary-auditor.v1" } } })
    expect(result).toBeNull()
    expect(readRootLimits).not.toHaveBeenCalled()
    expect(resolveModel).not.toHaveBeenCalled()
  })

  it("fails closed on malformed declared controls without resolving a model", async () => {
    const { input, control, readRootLimits, resolveModel } = fixture()
    const marker = { ...control, unexpected: true }
    expect(hasNativeVerificationControlIntent(marker)).toBe(true)
    const result = await dispatchNativeVerificationTask({ ...input, lease: { ...input.lease, expectedOutputSchema: marker } })
    expect(result).toMatchObject({ status: "failed", failureReason: "native_verification_control_invalid", retryDisposition: "terminal" })
    expect(readRootLimits).not.toHaveBeenCalled()
    expect(resolveModel).not.toHaveBeenCalled()
  })

  it("fails closed when a declared control marker uses an accessor", async () => {
    const { input, control, readRootLimits, resolveModel } = fixture()
    const marker = { ...control }
    Object.defineProperty(marker, "schemaVersion", { enumerable: true, get: () => NATIVE_VERIFICATION_CONTROL_SCHEMA })
    expect(hasNativeVerificationControlIntent(marker)).toBe(true)
    const result = await dispatchNativeVerificationTask({ ...input, lease: { ...input.lease, expectedOutputSchema: marker } })
    expect(result).toMatchObject({ status: "failed", failureReason: "native_verification_control_invalid", retryDisposition: "terminal" })
    expect(readRootLimits).not.toHaveBeenCalled()
    expect(resolveModel).not.toHaveBeenCalled()
  })

  it("fails closed when a valid marker is bound to a different real task ID", async () => {
    const { input, control, readRootLimits, resolveModel } = fixture()
    const result = await dispatchNativeVerificationTask({ ...input, lease: { ...input.lease, id: "foreign-task" } })
    expect(result).toMatchObject({ status: "failed", failureReason: "native_verification_control_invalid", retryDisposition: "terminal" })
    expect(readRootLimits).not.toHaveBeenCalled()
    expect(resolveModel).not.toHaveBeenCalled()
    expect(control.controlTaskId).not.toBe("foreign-task")
  })
})
