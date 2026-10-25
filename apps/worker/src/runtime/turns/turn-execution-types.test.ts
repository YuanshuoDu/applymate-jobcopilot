import { describe, expect, it } from "vitest"

import { executionId, executionKey, parseScheduledPipelineCompletionDisposition,
  parseScheduledPipelineExistingAuditResumeDisposition, type TurnExecutionIdentity } from "./turn-execution-types.js"
import { TURN_SCHEDULED_GATE_CHOICE_SCHEMA, turnScheduledGateChoiceWaitId } from "./turn-question-gate-choice-contract.js"

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

  it("preserves only the exact private fixed Gate question binding", () => {
    const binding = { schemaVersion: TURN_SCHEDULED_GATE_CHOICE_SCHEMA,
      owner: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
        executionId: "execution-1", executionAttemptCount: 4 },
      continuationKey: `scheduled-taskgraph:sha256:${"a".repeat(64)}`, snapshotDigest: `sha256:${"b".repeat(64)}`,
      evidenceDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), analyzeGraphRevision: 3, graphRevision: 5,
      gateTaskId: "gate-1", gateAttempt: 1, kind: "weak_cover_letter", jobIds: ["job-1"],
      allowedChoiceIds: ["continue", "review", "skip"] } as const
    const waitId = turnScheduledGateChoiceWaitId(binding)!
    const value = { status: "waiting_for_scheduled_gate_choice", waitId, candidateText: "Exact candidate.",
      question: "A prepared application has a weak cover letter. How should I handle it?", binding }
    expect(parseScheduledPipelineCompletionDisposition(value)).toEqual(value)
    expect(parseScheduledPipelineCompletionDisposition({ ...value, waitId: "another-wait" })).toBeNull()
    expect(parseScheduledPipelineCompletionDisposition({ ...value, question: "Use this untrusted question" })).toBeNull()
    expect(parseScheduledPipelineCompletionDisposition({ ...value, extra: "not private" })).toBeNull()
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
    { status: "waiting_for_scheduled_gate_choice", waitId: "question-123", candidateText: "candidate", question: "Question?", binding: {} },
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

describe("scheduled existing Audit resume disposition", () => {
  it("accepts only the three exact Audit resume outcomes", () => {
    expect(parseScheduledPipelineExistingAuditResumeDisposition({ status: "not_applicable" }))
      .toEqual({ status: "not_applicable" })
    expect(parseScheduledPipelineExistingAuditResumeDisposition({ status: "waiting_for_dependency", waitId: "audit-wait-1" }))
      .toEqual({ status: "waiting_for_dependency", waitId: "audit-wait-1" })
    expect(parseScheduledPipelineExistingAuditResumeDisposition({ status: "completed" }))
      .toEqual({ status: "completed" })
  })

  it.each([
    null,
    [],
    { status: "not_applicable", waitId: "unexpected" },
    { status: "waiting_for_dependency" },
    { status: "waiting_for_dependency", waitId: "" },
    { status: "waiting_for_dependency", waitId: " audit-wait-1" },
    { status: "waiting_for_dependency", waitId: "audit-wait-1 " },
    { status: "waiting_for_dependency", waitId: "w".repeat(129) },
    { status: "waiting_for_dependency", waitId: "audit-wait-1", extra: true },
    { status: "completed", waitId: "audit-wait-1" },
    { status: "completed", extra: true },
    { status: "unknown" },
  ])("rejects malformed or widened Audit resume outcomes", value => {
    expect(parseScheduledPipelineExistingAuditResumeDisposition(value)).toBeNull()
  })

  it("rejects accessors and symbol properties without evaluating or ignoring them", () => {
    const accessor = Object.defineProperty({ status: "waiting_for_dependency" }, "waitId", {
      enumerable: true, get: () => "audit-wait-1",
    })
    const symbol = { status: "completed", [Symbol("extra")]: true }
    expect(parseScheduledPipelineExistingAuditResumeDisposition(accessor)).toBeNull()
    expect(parseScheduledPipelineExistingAuditResumeDisposition(symbol)).toBeNull()
  })
})
