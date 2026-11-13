import { describe, expect, it } from "vitest"
import {
  evaluateApplicationSubmissionEvidence,
  unknownApplicationSubmissionEvidence,
  type SubmissionEvidenceApproval,
  type SubmissionEvidenceEvent,
  type SubmissionEvidenceTask,
} from "./application-submission-evidence"

const task: SubmissionEvidenceTask = {
  id: "application-task-1", userId: "user-1", jobId: "job-1", sessionId: "session-1", fillTurnId: "turn-1",
  fillTurnSessionId: "session-1", fillTurnUserId: "user-1", workerTaskId: "worker-task-1",
  status: "submitted", checkpoint: "submission_verified",
}
const queueData = {
  applicationTaskId: task.id, userId: task.userId, jobId: task.jobId, sessionId: task.sessionId,
  fillTurnId: task.fillTurnId, approvalId: "approval-1", receiptId: "approval-1",
  constraintHash: "hash-1", workerTaskId: task.workerTaskId,
}
const executionData = {
  executionId: "execution-1", workerTaskId: task.workerTaskId, applicationTaskId: task.id,
  userId: task.userId, jobId: task.jobId, sessionId: task.sessionId, fillTurnId: task.fillTurnId,
  approvalId: queueData.approvalId, constraintHash: queueData.constraintHash,
}
const evidenceData = {
  schemaVersion: 1, userId: task.userId, sessionId: task.sessionId, fillTurnId: task.fillTurnId,
  applicationTaskId: task.id, jobId: task.jobId, approvalId: queueData.approvalId,
  constraintHash: queueData.constraintHash, workerTaskId: task.workerTaskId,
  executionId: executionData.executionId, attemptId: "attempt-1", artifactHash: "artifact-hash-1",
  workerReport: "recorded_submitted", localRecord: "correlated", siteOutcome: "unverified",
} as const
const approval: SubmissionEvidenceApproval = {
  id: queueData.approvalId, userId: task.userId, sessionId: task.sessionId, taskId: task.id,
  turnId: task.fillTurnId, jobId: task.jobId, toolCallId: `application-submit:${task.id}`,
  type: "submit_application", status: "consumed", scopeHash: queueData.constraintHash,
  resourceHash: evidenceData.artifactHash,
}

function event(id: string, type: SubmissionEvidenceEvent["type"], actor: string, data: unknown): SubmissionEvidenceEvent {
  return { id, type, actor, data }
}

function exactInput() {
  return {
    task: { ...task },
    events: [
      event("event-queued", "submission_queued", "user", { ...queueData }),
      event("event-started", "submission_execution_started", "worker", { ...executionData }),
      event("event-settled", "submission_execution_settled", "worker", { ...executionData }),
      event("event-evidence", "submission_evidence_recorded", "worker", { ...evidenceData }),
    ],
    approvals: [{ ...approval }],
  }
}

const expected = {
  visible: true, availability: "available", workerReport: "submitted", localRecord: "recorded", employerReceipt: "unverified",
} as const

describe("application submission evidence", () => {
  it("returns only bounded facts for the exact producer-shaped current lineage", () => {
    const result = evaluateApplicationSubmissionEvidence(exactInput())
    expect(result).toEqual(expected)
    expect(Object.keys(result).sort()).toEqual(["availability", "employerReceipt", "localRecord", "visible", "workerReport"])
    expect(JSON.stringify(result)).not.toMatch(/application-task-1|attempt-1|artifact-hash-1|approval-1|hash-1|execution-1/)
  })

  it("requires the current Task owner, session, Turn, job, and Worker job identity", () => {
    const mismatches: Array<[string, Partial<SubmissionEvidenceTask>]> = [
      ["Task", { id: "application-task-old" }], ["owner", { userId: "user-other" }],
      ["session", { sessionId: "session-other" }], ["Turn", { fillTurnId: "turn-old" }],
      ["Turn session", { fillTurnSessionId: "session-other" }], ["Turn owner", { fillTurnUserId: "user-other" }],
      ["job", { jobId: "job-other" }], ["Worker job", { workerTaskId: "worker-task-old" }],
    ]
    for (const [label, patch] of mismatches) {
      const data = exactInput()
      data.task = { ...data.task, ...patch }
      expect(evaluateApplicationSubmissionEvidence(data), label).toEqual(unknownApplicationSubmissionEvidence(true, "unknown"))
    }
  })

  it.each([
    ["applicationTaskId", "application-task-old"], ["userId", "user-other"], ["jobId", "job-other"],
    ["sessionId", "session-other"], ["fillTurnId", "turn-old"], ["approvalId", "approval-old"],
    ["receiptId", "receipt-old"], ["constraintHash", "hash-old"], ["workerTaskId", "worker-task-old"],
  ])("rejects queue data with mismatched %s", (key, value) => {
    const data = exactInput()
    data.events[0] = event("event-queued", "submission_queued", "user", { ...queueData, [key]: value })
    expect(evaluateApplicationSubmissionEvidence(data)).toEqual(unknownApplicationSubmissionEvidence(true, "unknown"))
  })

  it("rejects a queue record that separates approval and receipt identity", () => {
    const data = exactInput()
    data.events[0] = event("event-queued", "submission_queued", "user", { ...queueData, receiptId: "different-receipt" })
    expect(evaluateApplicationSubmissionEvidence(data)).toEqual(unknownApplicationSubmissionEvidence(true, "unknown"))
  })

  it.each([
    ["id", "approval-old"], ["userId", "user-other"], ["sessionId", "session-other"],
    ["taskId", "application-task-old"], ["turnId", "turn-old"], ["jobId", "job-other"],
    ["toolCallId", "application-submit:other"], ["type", "send_gmail"], ["status", "approved"],
    ["scopeHash", "hash-old"], ["resourceHash", "artifact-hash-old"],
  ])("rejects a stale or replaced approval with mismatched %s", (key, value) => {
    const data = exactInput()
    data.approvals[0] = { ...data.approvals[0], [key]: value }
    expect(evaluateApplicationSubmissionEvidence(data)).toEqual(unknownApplicationSubmissionEvidence(true, "unknown"))
  })

  it.each([
    ["workerTaskId", "worker-task-old"], ["applicationTaskId", "application-task-old"],
    ["userId", "user-other"], ["jobId", "job-other"], ["sessionId", "session-other"],
    ["fillTurnId", "turn-old"], ["approvalId", "approval-old"], ["constraintHash", "hash-old"],
    ["executionId", "execution-old"],
  ])("rejects an execution start with mismatched %s", (key, value) => {
    const data = exactInput()
    data.events[1] = event("event-started", "submission_execution_started", "worker", { ...executionData, [key]: value })
    expect(evaluateApplicationSubmissionEvidence(data)).toEqual(unknownApplicationSubmissionEvidence(true, "unknown"))
  })

  it.each([
    ["userId", "user-other"], ["sessionId", "session-other"], ["fillTurnId", "turn-old"],
    ["applicationTaskId", "application-task-old"], ["jobId", "job-other"], ["approvalId", "approval-old"],
    ["constraintHash", "hash-old"], ["workerTaskId", "worker-task-old"], ["executionId", "execution-old"],
    ["attemptId", ""], ["artifactHash", ""],
  ])("rejects a producer record with invalid %s", (key, value) => {
    const data = exactInput()
    data.events[3] = event("event-evidence", "submission_evidence_recorded", "worker", { ...evidenceData, [key]: value })
    expect(evaluateApplicationSubmissionEvidence(data)).toEqual(unknownApplicationSubmissionEvidence(true, "unknown"))
  })

  it.each([
    ["schema version", { schemaVersion: 2 }],
    ["Worker report", { workerReport: "submitted" }],
    ["local-record flag", { localRecord: "confirmed" }],
    ["site outcome", { siteOutcome: "received" }],
    ["extra raw ref", { responseRef: `application:${task.id}` }],
  ])("rejects evidence with an invalid %s", (_label, patch) => {
    const data = exactInput()
    data.events[3] = event("event-evidence", "submission_evidence_recorded", "worker", { ...evidenceData, ...patch })
    expect(evaluateApplicationSubmissionEvidence(data)).toEqual(unknownApplicationSubmissionEvidence(true, "unknown"))
  })

  it("rejects missing, wrong-actor, duplicate, stale, and oversized evidence records", () => {
    const missing = exactInput()
    missing.events = missing.events.filter(row => row.type !== "submission_evidence_recorded")
    expect(evaluateApplicationSubmissionEvidence(missing)).toEqual(unknownApplicationSubmissionEvidence(true, "unknown"))

    const wrongActor = exactInput()
    wrongActor.events[3] = event("event-evidence", "submission_evidence_recorded", "system", { ...evidenceData })
    expect(evaluateApplicationSubmissionEvidence(wrongActor)).toEqual(unknownApplicationSubmissionEvidence(true, "unknown"))

    const duplicate = exactInput()
    duplicate.events.push(event("event-evidence-2", "submission_evidence_recorded", "worker", { ...evidenceData }))
    expect(evaluateApplicationSubmissionEvidence(duplicate)).toEqual(unknownApplicationSubmissionEvidence(true, "unknown"))

    const stale = exactInput()
    stale.events[3] = event("event-evidence", "submission_evidence_recorded", "worker", { ...evidenceData, executionId: "old-execution" })
    expect(evaluateApplicationSubmissionEvidence(stale)).toEqual(unknownApplicationSubmissionEvidence(true, "unknown"))

    const oversized = exactInput()
    oversized.events = [...oversized.events, ...Array.from({ length: 29 }, (_, index) => event(`old-${index}`, "submission_queued", "user", { ...queueData }))]
    expect(evaluateApplicationSubmissionEvidence(oversized)).toEqual(unknownApplicationSubmissionEvidence(true, "unknown"))
  })

  it("requires exactly one current start and settled event; settled alone is insufficient", () => {
    for (const missingType of ["submission_execution_started", "submission_execution_settled"] as const) {
      const data = exactInput()
      data.events = data.events.filter(row => row.type !== missingType)
      expect(evaluateApplicationSubmissionEvidence(data)).toEqual(unknownApplicationSubmissionEvidence(true, "unknown"))
    }
    const duplicate = exactInput()
    duplicate.events.push(event("settled-2", "submission_execution_settled", "worker", { ...executionData }))
    expect(evaluateApplicationSubmissionEvidence(duplicate)).toEqual(unknownApplicationSubmissionEvidence(true, "unknown"))
  })

  it("requires the exact record-to-approval artifact hash and current submitted Task", () => {
    const wrongHash = exactInput()
    wrongHash.events[3] = event("event-evidence", "submission_evidence_recorded", "worker", { ...evidenceData, artifactHash: "other" })
    expect(evaluateApplicationSubmissionEvidence(wrongHash)).toEqual(unknownApplicationSubmissionEvidence(true, "unknown"))

    for (const patch of [
      { status: "failed", checkpoint: "submission_verified" },
      { status: "submitted", checkpoint: "execution_failed" },
      { status: "waiting_for_user", checkpoint: "submission_uncertain" },
    ]) {
      const data = exactInput()
      data.task = { ...data.task, ...patch }
      expect(evaluateApplicationSubmissionEvidence(data)).toEqual(unknownApplicationSubmissionEvidence(true, "unknown"))
    }
  })

  it("uses only the producer's bounded local correlation flag and never asserts site receipt", () => {
    const localUnavailable = exactInput()
    localUnavailable.events[3] = event("event-evidence", "submission_evidence_recorded", "worker", { ...evidenceData, localRecord: "unavailable" })
    expect(evaluateApplicationSubmissionEvidence(localUnavailable)).toEqual({ ...expected, localRecord: "unknown" })

    const unknown = evaluateApplicationSubmissionEvidence({ task, events: [], approvals: [] })
    expect(unknown).toEqual(unknownApplicationSubmissionEvidence(true, "unknown"))
    expect(unknown.employerReceipt).toBe("unverified")
  })

  it("returns unknown for legacy, missing approval, and hidden non-submission tasks", () => {
    const legacy = exactInput()
    legacy.events[3] = event("event-evidence", "submission_evidence_recorded", "worker", { approvalId: queueData.approvalId })
    expect(evaluateApplicationSubmissionEvidence(legacy)).toEqual(unknownApplicationSubmissionEvidence(true, "unknown"))
    expect(evaluateApplicationSubmissionEvidence({ ...exactInput(), approvals: [] })).toEqual(unknownApplicationSubmissionEvidence(true, "unknown"))
    expect(evaluateApplicationSubmissionEvidence({ task: { ...task, status: "filling", checkpoint: "form_filled" }, events: [], approvals: [] }))
      .toEqual(unknownApplicationSubmissionEvidence(false, "unknown"))
  })
})
