import { describe, expect, it } from "vitest"
import { scheduledGateCandidateSetDigest, type ScheduledGateTaskEnvelope } from "./scheduled-gate-contract.js"
import { validateScheduledGateTaskFinish } from "./scheduled-gate-task-finish.js"

const expectedJobIds = ["job-a", "job-b"]
const envelope: ScheduledGateTaskEnvelope = {
  finalItemId: null,
  finalText: "",
  status: "completed",
  stepCount: 0,
  toolCallCount: 0,
  taskGraphVerificationReport: null,
  structuredResult: {
    status: "completed",
    nextStage: "execute",
    approvedJobIds: [],
    pendingJobIds: ["job-a"],
    skippedJobIds: ["job-b"],
    counts: { approved: 0, pending: 1, skipped: 1 },
  },
}

function finish(overrides: Partial<Parameters<typeof validateScheduledGateTaskFinish>[0]> = {}) {
  return validateScheduledGateTaskFinish({
    taskId: "gate-task",
    expectedTaskId: "gate-task",
    taskStatus: "completed",
    attemptCount: 2,
    expectedAttemptCount: 2,
    result: envelope,
    expectedJobIds,
    ...overrides,
  })
}

describe("validateScheduledGateTaskFinish", () => {
  it("accepts only the exact completed envelope for the current attempt and prepared set", () => {
    expect(finish()).toEqual(envelope)
    expect(finish({ result: JSON.stringify(envelope) })).toEqual(envelope)
  })

  it.each([
    ["foreign task", { expectedTaskId: "other-task" }],
    ["stale attempt", { expectedAttemptCount: 1 }],
    ["invalid attempt", { attemptCount: 0 }],
    ["nonterminal row", { taskStatus: "running" }],
    ["wrong inner job set", { expectedJobIds: ["job-a"] }],
    ["extra envelope field", { result: { ...envelope, privateBinding: "must-not-persist" } }],
    ["approved job", { result: { ...envelope, structuredResult: {
      ...envelope.structuredResult,
      approvedJobIds: ["job-a"],
      pendingJobIds: [],
      counts: { approved: 1, pending: 0, skipped: 1 },
    } } }],
  ] as const)("rejects %s", (_label, overrides) => {
    expect(finish(overrides)).toBeNull()
  })

  it("does not treat a waiting question envelope as successful completion", () => {
    const question: ScheduledGateTaskEnvelope = {
      ...envelope,
      status: "waiting_for_user",
      structuredResult: {
        status: "question_required",
        kind: "weak_cover_letter",
        jobIds: ["job-a"],
        candidateSetDigest: scheduledGateCandidateSetDigest("weak_cover_letter", ["job-a"]),
        allowedChoiceIds: ["continue", "review", "skip"],
      },
    }
    expect(finish({ taskStatus: "waiting_for_user", result: question })).toBeNull()
  })
})
