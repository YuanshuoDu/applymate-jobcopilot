import { describe, expect, it } from "vitest"
import { parseScheduledGateChoice, parseScheduledGateResult, parseScheduledGateTaskEnvelope,
  scheduledGateCandidateSetDigest } from "./scheduled-gate-result-contract.js"
import type { ScheduledGateQuestion } from "./scheduled-gate-result-contract.js"

const jobs = ["job-1", "job-2"]
const question: ScheduledGateQuestion = { status: "question_required", kind: "borderline_match", jobIds: ["job-2"],
  candidateSetDigest: scheduledGateCandidateSetDigest("borderline_match", ["job-2"]),
  allowedChoiceIds: ["add_to_pending", "skip", "lower_threshold"] }

describe("scheduled Gate result contract", () => {
  it("binds questions and fixed choices to a subset of the selected prepared IDs", () => {
    expect(parseScheduledGateResult(question, jobs)).toEqual(question)
    expect(parseScheduledGateChoice({ kind: question.kind, jobIds: ["job-2"], choiceId: "skip" }, question)).toBe("skip")
    expect(parseScheduledGateChoice({ kind: question.kind, jobIds: ["job-1"], choiceId: "skip" }, question)).toBeNull()
  })

  it("rejects approval, foreign IDs, and altered questions", () => {
    expect(parseScheduledGateResult({ status: "completed", nextStage: "execute", approvedJobIds: ["job-1"],
      pendingJobIds: ["job-2"], skippedJobIds: [], counts: { approved: 1, pending: 1, skipped: 0 } }, jobs)).toBeNull()
    expect(parseScheduledGateResult({ ...question, jobIds: ["other-job"] }, jobs)).toBeNull()
    expect(parseScheduledGateResult({ ...question, candidateSetDigest: "sha256:" + "0".repeat(64) }, jobs)).toBeNull()
  })

  it("checks the invocation envelope status and keeps the fixed 50-ID cap", () => {
    const envelope = { finalItemId: null, finalText: "", status: "waiting_for_user", stepCount: 0,
      toolCallCount: 0, taskGraphVerificationReport: null, structuredResult: question }
    expect(parseScheduledGateTaskEnvelope(envelope, "waiting_for_user", jobs)?.structuredResult.status).toBe("question_required")
    expect(parseScheduledGateTaskEnvelope(envelope, "completed", jobs)).toBeNull()
    expect(parseScheduledGateResult(question, Array.from({ length: 51 }, (_, index) => `job-${index}`))).toBeNull()
  })
})
