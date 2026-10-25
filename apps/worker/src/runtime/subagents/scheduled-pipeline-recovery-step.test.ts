import { describe, expect, it } from "vitest"
import {
  parseScheduledPipelineRecoveryStepMarker,
  readScheduledPipelineRecoveryStepProfile,
  scheduledPipelineRecoveryStepMarker,
  validateScheduledPipelineRecoverySteps,
  withScheduledPipelineRecoveryStepProfile,
  type ScheduledPipelineRecoverySource,
  type ScheduledPipelineRecoveryStepEvidence,
} from "./scheduled-pipeline-recovery-step.js"

const owner = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1" } as const
const source: ScheduledPipelineRecoverySource = {
  owner, sourceEventId: "candidate-event-1", sourceStepId: "model-step-4", sourceStepOrdinal: 4,
  rootAttemptCount: 2, inputThroughSequence: "10",
}

describe("scheduled pipeline recovery Step marker", () => {
  it("binds successive operational Steps to one immutable source and advances only the recovery cursor", () => {
    const first = scheduledPipelineRecoveryStepMarker({ owner, source, recoveryStepId: "recovery-step-1",
      recoveryCursor: 1, inputThroughSequence: "11" })
    const second = scheduledPipelineRecoveryStepMarker({ owner, source, recoveryStepId: "recovery-step-2",
      recoveryCursor: 2, inputThroughSequence: "12", previous: first })

    expect(second).toMatchObject({ sourceEventId: source.sourceEventId, sourceStepId: source.sourceStepId,
      sourceStepOrdinal: source.sourceStepOrdinal, rootAttemptCount: source.rootAttemptCount,
      recoveryStepId: "recovery-step-2", recoveryCursor: 2, predecessorStepId: "recovery-step-1",
      inputThroughSequence: "12" })
    expect(readScheduledPipelineRecoveryStepProfile(withScheduledPipelineRecoveryStepProfile(
      { provider: "fixture", model: "fixture" }, second))).toEqual(second)
    expect(parseScheduledPipelineRecoveryStepMarker({ ...second, unexpected: true })).toBeNull()
  })

  it("compares decimal cursors numerically and rejects values outside PostgreSQL bigint", () => {
    const sourceAtNine = { ...source, inputThroughSequence: "9" }
    const ten = scheduledPipelineRecoveryStepMarker({ owner, source: sourceAtNine, recoveryStepId: "recovery-step-10",
      recoveryCursor: 1, inputThroughSequence: "10" })
    const sourceAtNinetyNine = { ...source, inputThroughSequence: "99" }
    const hundred = scheduledPipelineRecoveryStepMarker({ owner, source: sourceAtNinetyNine, recoveryStepId: "recovery-step-100",
      recoveryCursor: 1, inputThroughSequence: "100" })

    expect(parseScheduledPipelineRecoveryStepMarker(ten)?.inputThroughSequence).toBe("10")
    expect(parseScheduledPipelineRecoveryStepMarker(hundred)?.inputThroughSequence).toBe("100")
    expect(parseScheduledPipelineRecoveryStepMarker({ ...hundred, inputThroughSequence: "9223372036854775808" })).toBeNull()
    expect(() => scheduledPipelineRecoveryStepMarker({ owner, source, recoveryStepId: "recovery-step-overflow",
      recoveryCursor: 1, inputThroughSequence: "9223372036854775808" })).toThrow("scheduled_recovery_step_identity_invalid")
  })

  it("rejects foreign, forged, discontinuous, and backwards-cursor markers", () => {
    const first = scheduledPipelineRecoveryStepMarker({ owner, source, recoveryStepId: "recovery-step-1",
      recoveryCursor: 1, inputThroughSequence: "11" })
    expect(() => scheduledPipelineRecoveryStepMarker({ owner: { ...owner, turnId: "foreign-turn" }, source,
      recoveryStepId: "recovery-step-foreign", recoveryCursor: 1, inputThroughSequence: "11" })).toThrow("scheduled_recovery_step_identity_invalid")
    expect(() => scheduledPipelineRecoveryStepMarker({ owner, source, recoveryStepId: "recovery-step-2",
      recoveryCursor: 3, inputThroughSequence: "12", previous: first })).toThrow("scheduled_recovery_step_chain_invalid")
    expect(() => scheduledPipelineRecoveryStepMarker({ owner, source, recoveryStepId: "recovery-step-2",
      recoveryCursor: 2, inputThroughSequence: "10", previous: first })).toThrow("scheduled_recovery_step_chain_invalid")
    expect(() => scheduledPipelineRecoveryStepMarker({ owner, source, recoveryStepId: "recovery-step-2",
      recoveryCursor: 2, inputThroughSequence: "12", previous: { ...first, sourceEventId: "forged-event" } }))
      .toThrow("scheduled_recovery_step_chain_invalid")
    expect(parseScheduledPipelineRecoveryStepMarker({ ...first, owner: { ...owner, userId: "" } })).toBeNull()
  })

  it("wraps primitive profiles without losing them and rejects a missing marker", () => {
    const marker = scheduledPipelineRecoveryStepMarker({ owner, source, recoveryStepId: "recovery-step-1",
      recoveryCursor: 1, inputThroughSequence: "10" })
    const profile = withScheduledPipelineRecoveryStepProfile("fixture-profile", marker)
    expect(profile).toMatchObject({ configuredModelProfile: "fixture-profile" })
    expect(readScheduledPipelineRecoveryStepProfile(profile)).toEqual(marker)
    expect(readScheduledPipelineRecoveryStepProfile({ provider: "fixture" })).toBeNull()
  })

  it("keeps the immutable source through repeated Audit waits and a blocker retry using exact wait receipts", () => {
    const firstMarker = scheduledPipelineRecoveryStepMarker({ owner, source, recoveryStepId: "recovery-step-5",
      recoveryCursor: 1, inputThroughSequence: "11" })
    const secondMarker = scheduledPipelineRecoveryStepMarker({ owner, source, recoveryStepId: "recovery-step-8",
      recoveryCursor: 2, inputThroughSequence: "12", previous: firstMarker })
    const evidence = (id: string, ordinal: number, marker: typeof firstMarker, status: string,
      receipt: ScheduledPipelineRecoveryStepEvidence["receipt"], waitId: string | null,
      errorCode: string | null): ScheduledPipelineRecoveryStepEvidence => {
      const step = { id, taskId: owner.rootTaskId, ordinal, attempt: 1, status, errorCode,
        inputThroughSequence: marker.inputThroughSequence, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0,
        consumedInputIds: [], modelProfileSnapshot: withScheduledPipelineRecoveryStepProfile({}, marker),
        hasModelActivity: false, hasToolActivity: false, hasFinalRejection: false, receipt, waitId }
      const event = (type: string, payload: Record<string, unknown>) => ({ type, actor: "orchestrator",
        taskId: owner.rootTaskId, itemId: null, correlationId: id, idempotencyKey: `turn:${owner.turnId}:event:${type.replace(".", "-")}:${id}`, payload })
      return { ...step, startedEvents: [event("step.started", { stepId: id, ordinal, taskId: owner.rootTaskId,
        scheduledPipelineRecoveryStep: marker })], completedEvents: [event("step.completed", {
        stepId: id, status: "waiting_for_dependency", ...(errorCode ? { errorCode } : {}), taskId: owner.rootTaskId,
        ...(waitId ? { waitId } : {}),
      })] }
    }
    const first = evidence("recovery-step-5", 5, firstMarker, "waiting_for_tool", "scheduled_wait", "audit-wait-1", null)
    const second = evidence("recovery-step-8", 8, secondMarker, "waiting_for_tool", "scheduled_blocker", null,
      "scheduled_audit_completion_unverified")

    expect(validateScheduledPipelineRecoverySteps(source, [first, second])).toMatchObject({
      marker: secondMarker, ordinal: 8, status: "waiting_for_tool", errorCode: "scheduled_audit_completion_unverified",
    })
    expect(validateScheduledPipelineRecoverySteps(source, [{ ...first, waitId: "other-wait" }, second])).toBeNull()
  })

  it("compares persisted JSONB markers independent of object-key order while preserving field values", () => {
    const marker = scheduledPipelineRecoveryStepMarker({ owner, source, recoveryStepId: "recovery-jsonb",
      recoveryCursor: 1, inputThroughSequence: "11" })
    const base = {
      id: marker.recoveryStepId, taskId: owner.rootTaskId, ordinal: 5, attempt: 1, status: "waiting_for_tool",
      errorCode: null, inputThroughSequence: "11", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0,
      consumedInputIds: [], modelProfileSnapshot: withScheduledPipelineRecoveryStepProfile({}, marker),
      hasModelActivity: false, hasToolActivity: false, hasFinalRejection: false,
      receipt: "scheduled_wait" as const, waitId: "wait-1",
    }
    const start = { type: "step.started", actor: "orchestrator", taskId: owner.rootTaskId, itemId: null,
      correlationId: base.id, idempotencyKey: `turn:${owner.turnId}:event:step-started:${base.id}`,
      payload: { stepId: base.id, ordinal: base.ordinal, taskId: owner.rootTaskId, scheduledPipelineRecoveryStep: marker } }
    const complete = { type: "step.completed", actor: "orchestrator", taskId: owner.rootTaskId, itemId: null,
      correlationId: base.id, idempotencyKey: `turn:${owner.turnId}:event:step-completed:${base.id}`,
      payload: { stepId: base.id, status: "waiting_for_dependency", taskId: owner.rootTaskId, waitId: "wait-1" } }
    const evidence: ScheduledPipelineRecoveryStepEvidence = { ...base, startedEvents: [start], completedEvents: [complete] }
    const reorder = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).reverse())
    const markerOutOfOrder = reorder({ ...marker, owner: reorder({ ...owner }) })
    const startOutOfOrder = { ...start, payload: { ...start.payload, scheduledPipelineRecoveryStep: markerOutOfOrder } }
    const profile = base.modelProfileSnapshot as Record<string, unknown>
    const profileOutOfOrder = reorder({ ...profile, scheduledPipelineRecoveryStep: markerOutOfOrder })

    expect(validateScheduledPipelineRecoverySteps(source, [{ ...evidence, startedEvents: [startOutOfOrder],
      modelProfileSnapshot: profileOutOfOrder as ScheduledPipelineRecoveryStepEvidence["modelProfileSnapshot"] }])).not.toBeNull()
    const changed = { ...markerOutOfOrder, sourceEventId: "another-source" }
    expect(validateScheduledPipelineRecoverySteps(source, [{ ...evidence, startedEvents: [{ ...start,
      payload: { ...start.payload, scheduledPipelineRecoveryStep: changed } }] }])).toBeNull()
  })

  it("invalidates a rejected recovery candidate across replan and terminal crash windows", () => {
    const marker = scheduledPipelineRecoveryStepMarker({ owner, source, recoveryStepId: "recovery-rejected",
      recoveryCursor: 1, inputThroughSequence: source.inputThroughSequence })
    const id = marker.recoveryStepId
    const event = (type: string, payload: Record<string, unknown>) => ({ type, actor: "orchestrator",
      taskId: owner.rootTaskId, itemId: null, correlationId: id,
      idempotencyKey: `turn:${owner.turnId}:event:${type.replace(".", "-")}:${id}`, payload })
    const base: ScheduledPipelineRecoveryStepEvidence = {
      id, taskId: owner.rootTaskId, ordinal: 5, attempt: 1, status: "completed", errorCode: null,
      inputThroughSequence: marker.inputThroughSequence, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0,
      consumedInputIds: [], modelProfileSnapshot: withScheduledPipelineRecoveryStepProfile({}, marker),
      startedEvents: [event("step.started", { stepId: id, ordinal: 5, taskId: owner.rootTaskId,
        scheduledPipelineRecoveryStep: marker })],
      completedEvents: [event("step.completed", { stepId: id, status: "completed", taskId: owner.rootTaskId })],
      waitId: null, hasModelActivity: false, hasToolActivity: false, hasFinalRejection: false, receipt: "none",
    }

    expect(validateScheduledPipelineRecoverySteps(source, [base])).not.toBeNull()
    expect(validateScheduledPipelineRecoverySteps(source, [{ ...base, hasFinalRejection: true }])).toBeNull()
    expect(validateScheduledPipelineRecoverySteps(source, [{ ...base, status: "streaming", completedEvents: [],
      hasFinalRejection: true }])).toBeNull()
  })
})
