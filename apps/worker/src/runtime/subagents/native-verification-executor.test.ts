import { describe, expect, it, vi } from "vitest"
import type { HarnessModelRequest, ModelAdapter, ModelStreamEvent } from "@jobcopilot/agent-model"

import { executionOwnerFence } from "../execution-owner.js"
import type { TurnExecutionStore } from "../turns/turn-execution-types.js"
import type { SubagentLease } from "./types.js"
import type { TreeBudgetReservationStore } from "./tree-budget-types.js"
import { NATIVE_VERIFICATION_CONTROL_SCHEMA, NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA,
  NATIVE_VERIFICATION_PACKET_SCHEMA, NATIVE_VERIFICATION_PACKET_SCHEMA_V2, NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND,
  canonicalNativeVerificationJson, digestNativeVerificationValue,
  type NativeVerificationControl, type NativeVerificationPacket } from "./native-verification-contract.js"
import { createNativeVerificationContext } from "./native-verification-packet.js"
import { dispatchNativeVerificationTask, hasNativeVerificationControlIntent } from "./native-verification-executor.js"
import { NATIVE_VERIFICATION_USER_STEERING_SCHEMA, NATIVE_VERIFICATION_USER_STEERING_STAGE } from "./native-verification-steering-contract.js"

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

async function capturedRequest(base: ReturnType<typeof fixture>, packet: NativeVerificationPacket, control: NativeVerificationControl) {
  const requests: HarnessModelRequest[] = [], now = new Date("2026-10-06T12:00:00.000Z")
  const adapter: ModelAdapter = {
    id: "fixture-model", profile,
    async *stream(request) {
      requests.push(request)
      yield { type: "text_delta", text: JSON.stringify({ schemaVersion: NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA,
        criteria: packet.criteria.map(item => ({ criterionId: item.criterionId, disposition: "uncertain", reasonCode: "ambiguous", evidenceReferenceIds: [] })) }) }
      yield { type: "usage", inputTokens: 2, outputTokens: 1, estimatedCostUsd: 0.001 }
      yield { type: "completed", finishReason: "stop" }
    },
  }
  const store: TurnExecutionStore = {
    startStep: async ({ stepId, ordinal }) => ({ id: stepId, ordinal }), updateStep: async () => undefined,
    createItem: async input => ({ id: input.itemId, revision: 0 }),
    updateItem: async input => ({ id: input.itemId, revision: input.expectedRevision + 1 }),
    appendEvent: async input => ({ id: input.id }), recordFinalResponse: async () => undefined,
  }
  const treeBudget: TreeBudgetReservationStore = {
    reserve: async input => ({ ...input, id: "reservation-1", units: 1, status: "reserved", createdAt: now, updatedAt: now, settledAt: null }),
    settle: async input => ({ ...input, units: 1, createdAt: now, updatedAt: now, settledAt: now }), readRootLimits: async () => undefined,
  }
  const lease = { ...base.lease, context: createNativeVerificationContext(packet), expectedOutputSchema: control }
  const result = await dispatchNativeVerificationTask({ ...base.input, lease, store, treeBudget,
    authorizeUsage: async () => ({ settle: async () => undefined }), resolveModel: () => adapter })
  return { result, request: requests[0] }
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

  it("limits v2 self-attestation guidance to the actual accounted tool-less request", async () => {
    const base = fixture()
    const answer = "I prefer Dublin roles."
    const candidateText = "The response addresses the user's stated preference."
    const target = { kind: "root_goal" as const, candidateDigest: digestNativeVerificationValue(candidateText), referenceId: "candidate", candidateText }
    const answerReference = `user-self-attestation:${"8a".repeat(32)}`
    const packet: NativeVerificationPacket = {
      schemaVersion: NATIVE_VERIFICATION_PACKET_SCHEMA_V2, controlOperationId: "verify-op", controlTaskId: base.lease.id,
      goal: "Respond to the user's stated job-location preference.",
      criteria: [{ criterionId: "criterion-1", requirement: "The answer reflects what the user stated." }],
      target, evidence: [{ referenceId: answerReference, kind: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND,
        summary: JSON.stringify({ kind: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND, stage: "user_input",
          question: "Which location do you prefer?", options: [], answer }) }],
    }
    const control: NativeVerificationControl = {
      schemaVersion: NATIVE_VERIFICATION_CONTROL_SCHEMA, controlOperationId: packet.controlOperationId, controlTaskId: packet.controlTaskId,
      owner: { userId: base.lease.userId, sessionId: base.lease.sessionId, turnId: base.lease.turnId!, rootTaskId: base.lease.rootTaskId, parentTaskId: base.lease.parentTaskId },
      target: { kind: "root_goal", candidateDigest: target.candidateDigest, childBindingSetDigest: "e".repeat(64) },
      goalDigest: digestNativeVerificationValue(packet.goal), criteriaDigest: digestNativeVerificationValue(packet.criteria),
      evidencePacketDigest: digestNativeVerificationValue(packet),
    }
    const modelReport = JSON.stringify({ schemaVersion: NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA, criteria: [
      { criterionId: "criterion-1", disposition: "uncertain", reasonCode: "ambiguous", evidenceReferenceIds: [answerReference] },
    ] })
    const requests: HarnessModelRequest[] = []
    const adapter: ModelAdapter = {
      id: "fixture-model", profile,
      async *stream(request: HarnessModelRequest): AsyncGenerator<ModelStreamEvent> {
        requests.push(request)
        yield { type: "text_delta", text: modelReport }
        yield { type: "usage", inputTokens: 12, outputTokens: 7, estimatedCostUsd: 0.001 }
        yield { type: "completed", finishReason: "stop" }
      },
    }
    const now = new Date("2026-10-06T12:00:00.000Z")
    let reservationCount = 0
    let settlementCount = 0
    const treeBudget: TreeBudgetReservationStore = {
      reserve: async input => {
        reservationCount += 1
        return { ...input, id: "reservation-1", units: 1, status: "reserved", createdAt: now, updatedAt: now, settledAt: null }
      },
      settle: async input => {
        settlementCount += 1
        return { ...input, units: 1, createdAt: now, updatedAt: now, settledAt: now }
      },
      readRootLimits: async () => undefined,
    }
    const persistedItems: unknown[] = [], persistedEvents: unknown[] = [], persistedResponses: string[] = []
    const store: TurnExecutionStore = {
      startStep: async ({ stepId, ordinal }) => ({ id: stepId, ordinal }),
      updateStep: async () => undefined,
      createItem: async input => { persistedItems.push(input); return { id: input.itemId, revision: 0 } },
      updateItem: async input => { persistedItems.push(input); return { id: input.itemId, revision: input.expectedRevision + 1 } },
      appendEvent: async input => { persistedEvents.push(input); return { id: input.id } },
      recordFinalResponse: async input => { persistedResponses.push(input.response) },
    }
    const authorizeUsage = vi.fn(async () => ({ settle: async () => undefined }))
    const result = await dispatchNativeVerificationTask({
      ...base.input,
      lease: { ...base.lease, context: createNativeVerificationContext(packet), expectedOutputSchema: control },
      store, treeBudget, authorizeUsage, resolveModel: () => adapter,
    })

    expect(result?.status).toBe("completed")
    expect(requests).toHaveLength(1)
    const requestText = JSON.stringify(requests[0]?.messages)
    expect(requests[0]?.tools).toEqual([])
    expect(requestText).toContain(answer)
    expect(requestText).toContain("self-attestation")
    expect(requestText).toContain("not independent proof of external facts")
    expect(requestText).toContain("consent")
    expect(requestText).toContain("action, approval, consent, credential, or submission authority")
    expect(requestText).not.toContain("Consumed user steering")
    expect(reservationCount).toBe(1)
    expect(settlementCount).toBe(1)
    expect(authorizeUsage).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toContain(answer)
    expect(JSON.stringify(result)).not.toContain(NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND)
    const persisted = JSON.stringify({ items: persistedItems, events: persistedEvents, responses: persistedResponses })
    expect(persistedItems.length).toBeGreaterThan(0)
    expect(persistedEvents.length).toBeGreaterThan(0)
    expect(persisted).toContain("private_output_captured")
    expect(persisted).not.toContain(answer)
    expect(persisted).not.toContain(NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND)
    expect(JSON.stringify(packet)).toContain(answer)
    expect(canonicalNativeVerificationJson(packet)).toContain(answer)
  })

  it("adds constraint-only guidance for a recognized root steering packet without exposing it in system instructions", async () => {
    const base = fixture(), candidateText = "The answer honors the current request."
    const target = { kind: "root_goal" as const, candidateDigest: digestNativeVerificationValue(candidateText), referenceId: "candidate", candidateText }
    const privateRef = `user-self-attestation:${"9a".repeat(32)}`
    const steeringText = "Prefer roles in Dublin."
    const packet: NativeVerificationPacket = {
      schemaVersion: NATIVE_VERIFICATION_PACKET_SCHEMA_V2, controlOperationId: "verify-op", controlTaskId: base.lease.id,
      goal: "Answer the user's job-search request.", criteria: [{ criterionId: "criterion-1", requirement: "Respect current stated constraints." }],
      target, evidence: [{ referenceId: privateRef, kind: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND,
        summary: canonicalNativeVerificationJson({ schemaVersion: NATIVE_VERIFICATION_USER_STEERING_SCHEMA,
          stage: NATIVE_VERIFICATION_USER_STEERING_STAGE, content: [{ type: "text", text: steeringText }] }) }],
    }
    const control: NativeVerificationControl = {
      schemaVersion: NATIVE_VERIFICATION_CONTROL_SCHEMA, controlOperationId: packet.controlOperationId, controlTaskId: packet.controlTaskId,
      owner: { userId: base.lease.userId, sessionId: base.lease.sessionId, turnId: base.lease.turnId!, rootTaskId: base.lease.rootTaskId, parentTaskId: base.lease.parentTaskId },
      target: { kind: "root_goal", candidateDigest: target.candidateDigest, childBindingSetDigest: "e".repeat(64) },
      goalDigest: digestNativeVerificationValue(packet.goal), criteriaDigest: digestNativeVerificationValue(packet.criteria),
      evidencePacketDigest: digestNativeVerificationValue(packet),
    }

    const { result, request } = await capturedRequest(base, packet, control)
    expect(result?.status).toBe("completed")
    const system = JSON.stringify(request?.messages.filter(message => message.role === "system"))
    expect(system).toContain("Consumed user steering is ordered by acceptance")
    expect(system).toContain("applicable user-stated constraints and any explicit later updates")
    expect(system).toContain("Evaluate the candidate")
    expect(system).toContain("immutable root goal and criteria unchanged")
    expect(system).toContain("Do not infer external facts, actions, approval, consent, credentials, or authority to act")
    expect(system).not.toContain(steeringText)
    expect(system).not.toContain(privateRef)
    expect(system).not.toContain(control.controlOperationId)
  })

  it("does not infer steering policy from unrelated evidence or change no-steer v1 instructions", async () => {
    const base = fixture(), candidateText = "A root response."
    const target = { kind: "root_goal" as const, candidateDigest: digestNativeVerificationValue(candidateText), referenceId: "candidate", candidateText }
    const packet: NativeVerificationPacket = {
      schemaVersion: NATIVE_VERIFICATION_PACKET_SCHEMA, controlOperationId: "verify-op", controlTaskId: base.lease.id,
      goal: "Answer the user's request.", criteria: [{ criterionId: "criterion-1", requirement: "Use owned evidence." }], target,
      evidence: [{ referenceId: "tool-result-1", kind: "tool_result", summary: canonicalNativeVerificationJson({
        schemaVersion: NATIVE_VERIFICATION_USER_STEERING_SCHEMA, stage: NATIVE_VERIFICATION_USER_STEERING_STAGE,
        content: [{ type: "text", text: "Prefer Dublin." }],
      }) }],
    }
    const control: NativeVerificationControl = {
      schemaVersion: NATIVE_VERIFICATION_CONTROL_SCHEMA, controlOperationId: packet.controlOperationId, controlTaskId: packet.controlTaskId,
      owner: { userId: base.lease.userId, sessionId: base.lease.sessionId, turnId: base.lease.turnId!, rootTaskId: base.lease.rootTaskId, parentTaskId: base.lease.parentTaskId },
      target: { kind: "root_goal", candidateDigest: target.candidateDigest, childBindingSetDigest: "e".repeat(64) },
      goalDigest: digestNativeVerificationValue(packet.goal), criteriaDigest: digestNativeVerificationValue(packet.criteria),
      evidencePacketDigest: digestNativeVerificationValue(packet),
    }

    const { result, request } = await capturedRequest(base, packet, control)
    expect(result?.status).toBe("completed")
    const system = JSON.stringify(request?.messages.filter(message => message.role === "system"))
    expect(system).not.toContain("Consumed user steering")
    expect(system).not.toContain("not independent proof of external facts")
  })
})
