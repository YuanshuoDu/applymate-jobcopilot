import { describe, expect, it } from "vitest"

import { executionId, executionKey, parseScheduledPipelineCompletionDisposition, type TurnExecutionIdentity } from "./turn-execution-types.js"

const root: TurnExecutionIdentity = {
  kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1",
  ownerId: "worker-1", leaseVersion: 1, leaseExpiresAt: new Date("2026-09-08T03:00:00.000Z"),
}

const child: TurnExecutionIdentity = {
  kind: "task", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "child-1", rootTaskId: "root-1",
  ownerId: "worker-2", attemptCount: 2, leaseExpiresAt: new Date("2026-09-08T03:00:00.000Z"),
}

describe("turn execution identity helpers", () => {
  it("uses the owner kind and actual task identity for durable keys", () => {
    expect(executionKey(root)).toBe("turn:turn-1")
    expect(executionKey(child)).toBe("task:child-1")
    expect(executionId(child, "item:final")).toBe("task:child-1:item:final")
  })

  it("keeps root and child generated identities disjoint in one turn", () => {
    expect(executionId(root, "step:0")).not.toBe(executionId(child, "step:0"))
    expect(executionId(root, "event:turn-started")).toBe("turn:turn-1:event:turn-started")
  })
})

describe("scheduled pipeline completion disposition", () => {
  it("preserves the exact staged candidate and durable wait receipt", () => {
    const candidateText = "  Exact candidate with its spacing.  "
    expect(parseScheduledPipelineCompletionDisposition({ status: "completed", candidateText }))
      .toEqual({ status: "completed", candidateText })
    expect(parseScheduledPipelineCompletionDisposition({ status: "waiting_for_dependency", waitId: "dependency-123", candidateText }))
      .toEqual({ status: "waiting_for_dependency", waitId: "dependency-123", candidateText })
    expect(parseScheduledPipelineCompletionDisposition({ status: "waiting_for_user", waitId: "question-123", candidateText }))
      .toEqual({ status: "waiting_for_user", waitId: "question-123", candidateText })
    expect(parseScheduledPipelineCompletionDisposition({ status: "waiting_for_external_user", externalWaitId: "web-question-123", scheduledWaitId: "worker-choice-123", candidateText }))
      .toEqual({ status: "waiting_for_external_user", externalWaitId: "web-question-123", scheduledWaitId: "worker-choice-123", candidateText })
    expect(parseScheduledPipelineCompletionDisposition({ status: "waiting_for_external_user", externalWaitId: "web-question-123", candidateText }))
      .toEqual({ status: "waiting_for_external_user", externalWaitId: "web-question-123", candidateText })
    expect(parseScheduledPipelineCompletionDisposition({ status: "blocked", errorCode: "scheduled_pipeline_entitlement_required" }))
      .toEqual({ status: "blocked", errorCode: "scheduled_pipeline_entitlement_required" })
  })

  it.each([
    null,
    { status: "blocked", candidateText: "candidate" },
    { status: "completed", candidateText: " " },
    { status: "completed", candidateText: "candidate", waitId: "question-123" },
    { status: "waiting_for_dependency", candidateText: "candidate" },
    { status: "waiting_for_dependency", waitId: " dependency-123", candidateText: "candidate" },
    { status: "waiting_for_dependency", waitId: "dependency-123", candidateText: " " },
    { status: "waiting_for_dependency", waitId: "d".repeat(129), candidateText: "candidate" },
    { status: "waiting_for_dependency", waitId: "dependency-123", candidateText: "candidate", errorCode: "ignored" },
    { status: "waiting_for_user", waitId: " question-123", candidateText: "candidate" },
    { status: "waiting_for_user", waitId: "question-123", candidateText: "candidate", errorCode: "ignored" },
    { status: "waiting_for_external_user", externalWaitId: "web-question-123", scheduledWaitId: "web-question-123", candidateText: "candidate" },
    { status: "waiting_for_external_user", externalWaitId: " web-question-123", candidateText: "candidate" },
    { status: "waiting_for_external_user", externalWaitId: "web-question-123", scheduledWaitId: "worker-choice-123", candidateText: " " },
    { status: "waiting_for_external_user", externalWaitId: "web-question-123", scheduledWaitId: "worker-choice-123", candidateText: "candidate", errorCode: "ignored" },
    { status: "blocked", errorCode: "Not safe" },
  ])("rejects malformed or non-durable scheduled dispositions", value => {
    expect(parseScheduledPipelineCompletionDisposition(value)).toBeNull()
  })

  it("rejects accessors and symbol properties instead of evaluating or ignoring them", () => {
    const accessor = Object.defineProperty({ status: "completed" }, "candidateText", { enumerable: true, get: () => "candidate" })
    const symbol = { status: "completed", candidateText: "candidate", [Symbol("extra")]: true }
    const dependencyAccessor = Object.defineProperty({ status: "waiting_for_dependency", waitId: "dependency-123" }, "candidateText", { enumerable: true, get: () => "candidate" })
    const dependencySymbol = { status: "waiting_for_dependency", waitId: "dependency-123", candidateText: "candidate", [Symbol("extra")]: true }
    expect(parseScheduledPipelineCompletionDisposition(accessor)).toBeNull()
    expect(parseScheduledPipelineCompletionDisposition(symbol)).toBeNull()
    expect(parseScheduledPipelineCompletionDisposition(dependencyAccessor)).toBeNull()
    expect(parseScheduledPipelineCompletionDisposition(dependencySymbol)).toBeNull()
  })
})
