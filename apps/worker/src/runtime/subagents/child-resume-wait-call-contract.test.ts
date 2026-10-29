import { describe, expect, it } from "vitest"

import { childWaitRecoveryEventKey, childWaitLogicalResumeCursor, childWaitRecoveryLogicalStepOrdinal,
  childWaitResumeCursorIsValid, parseChildWaitModelUsageReceipt } from "./child-resume-wait-call-contract.js"
import type { DurableWaitResume } from "./child-resume-observations.js"
import type { SubagentLease } from "./types.js"

const lease = { id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  ownerId: "worker-1", attemptCount: 2 } as SubagentLease
const wait: DurableWaitResume = { waitId: "wait-1", stepId: "task:child-1:step:4:attempt:2", attempt: 2, ordinal: 18,
  toolCallId: "old-call", sourceItemId: "old-result", input: {}, output: {}, continuationStepId: "task:child-1:step:5:attempt:2", continuationOrdinal: 39 }

function step(logical: number, persisted: number, status: string) {
  return { id: `task:child-1:step:${logical}:attempt:2`, ordinal: persisted, status }
}

function receiptEvents(stepId: string) {
  const startId = `start:${stepId}`, completeId = `complete:${stepId}`, usageId = `usage:${stepId}`
  return [
    { id: startId, sequence: "1", sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id, itemId: null, actor: "subagent",
      type: "model.started", correlationId: stepId, causationId: null, idempotencyKey: childWaitRecoveryEventKey(lease, `model-started:${stepId}`),
      payload: { taskId: lease.id, provider: "fixture", model: "model-a" } },
    { id: completeId, sequence: "2", sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id, itemId: null, actor: "subagent",
      type: "model.completed", correlationId: stepId, causationId: startId, idempotencyKey: childWaitRecoveryEventKey(lease, `model-completed:${stepId}`),
      payload: { taskId: lease.id, provider: "fixture", model: "model-a", toolCallCount: 1 } },
    { id: usageId, sequence: "3", sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id, itemId: null, actor: "subagent",
      type: "model.usage", correlationId: stepId, causationId: completeId, idempotencyKey: childWaitRecoveryEventKey(lease, `model-usage:${stepId}`),
      payload: { taskId: lease.id, provider: "fixture", model: "model-a", usage: { inputTokens: 37, outputTokens: 13, estimatedCostUsd: 0.0042 } } },
  ]
}

describe("child resume wait-call contract", () => {
  it("uses the canonical logical step suffix rather than Turn-global database ordinals", () => {
    expect(childWaitRecoveryLogicalStepOrdinal(wait.continuationStepId!, lease)).toBe(5)
    expect(childWaitLogicalResumeCursor([step(4, 18, "waiting_for_tool"), step(5, 39, "streaming")], lease, wait)).toBe(5)
    expect(childWaitLogicalResumeCursor([step(4, 18, "waiting_for_tool"), step(5, 39, "queued")], lease, wait)).toBe(5)
    expect(childWaitLogicalResumeCursor([step(4, 18, "waiting_for_tool"), step(5, 39, "streaming")], lease, wait, 5)).toBe(6)
    expect(childWaitLogicalResumeCursor([step(4, 18, "waiting_for_tool"), step(5, 39, "completed"), step(6, 53, "completed")], lease, wait, 5)).toBe(7)
  })

  it("rejects malformed gaps and an unknown streaming later step", () => {
    expect(() => childWaitLogicalResumeCursor([step(4, 18, "waiting_for_tool"), step(6, 53, "completed")], lease, wait)).toThrow("child_resume_wait_step_lineage")
    expect(() => childWaitLogicalResumeCursor([step(4, 18, "waiting_for_tool"), step(5, 39, "completed"), step(6, 53, "streaming")], lease, wait)).toThrow("child_resume_wait_step_lineage")
    expect(childWaitRecoveryLogicalStepOrdinal("other:step:5:attempt:2", lease)).toBeUndefined()
  })

  it("accepts only the source logical successor when no continuation exists", () => {
    const sourceOnly: DurableWaitResume = { ...wait, stepId: "task:child-1:step:4:attempt:2",
      continuationStepId: undefined, continuationOrdinal: undefined }
    expect(childWaitLogicalResumeCursor([step(3, 17, "completed"), step(4, 18, "waiting_for_tool")], lease, sourceOnly)).toBe(5)
    expect(childWaitResumeCursorIsValid(sourceOnly, lease, 5, false)).toBe(true)
    expect(childWaitResumeCursorIsValid(sourceOnly, lease, 6, false)).toBe(false)
    expect(childWaitResumeCursorIsValid(sourceOnly, lease, 5, true)).toBe(false)
    expect(() => childWaitLogicalResumeCursor([step(4, 18, "waiting_for_tool"), step(5, 39, "streaming")], lease, sourceOnly))
      .toThrow("child_resume_wait_step_lineage")
    expect(() => childWaitLogicalResumeCursor([step(3, 17, "completed"), step(4, 18, "waiting_for_tool")], lease, sourceOnly, 5))
      .toThrow("child_resume_wait_step_lineage")
  })

  it("requires the resume cursor to match attempt and consumed state", () => {
    expect(childWaitResumeCursorIsValid(wait, lease, 5, false)).toBe(true)
    expect(childWaitResumeCursorIsValid(wait, lease, 6, true)).toBe(true)
    expect(childWaitResumeCursorIsValid(wait, { ...lease, attemptCount: 3 }, 5, false)).toBe(false)
    expect(childWaitResumeCursorIsValid(wait, lease, 5, true)).toBe(false)
  })

  it("accepts only one exact model start/completion/usage receipt chain", () => {
    const events = receiptEvents(wait.continuationStepId!)
    expect(parseChildWaitModelUsageReceipt(events, lease, wait.continuationStepId!)).toMatchObject({
      eventId: `usage:${wait.continuationStepId}`, usage: { inputTokens: 37, outputTokens: 13, estimatedCostUsd: 0.0042 },
    })
    expect(() => parseChildWaitModelUsageReceipt([...events, { ...events[0], id: "failed", type: "model.failed" }], lease, wait.continuationStepId!))
      .toThrow("child_resume_wait_tool_call_conflict")
  })
})
