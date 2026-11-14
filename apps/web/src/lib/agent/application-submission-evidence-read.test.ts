import { describe, expect, it, vi } from "vitest"
import { readApplicationSubmissionEvidence } from "./application-submission-evidence-read"
import type { SubmissionEvidenceApproval, SubmissionEvidenceEvent, SubmissionEvidenceTask } from "./application-submission-evidence"

const updatedAt = new Date("2026-11-12T10:00:00Z")
const task = {
  id: "task-1", userId: "user-1", jobId: "job-1", sessionId: "session-1", fillTurnId: "turn-1",
  fillTurnSessionId: "session-1", fillTurnUserId: "user-1", workerTaskId: "worker-1",
  status: "submitted", checkpoint: "submission_verified", updatedAt,
} as SubmissionEvidenceTask & { updatedAt: Date }
const queue = {
  applicationTaskId: task.id, userId: task.userId, jobId: task.jobId, sessionId: task.sessionId,
  fillTurnId: task.fillTurnId, approvalId: "approval-1", receiptId: "approval-1",
  constraintHash: "scope-hash", workerTaskId: task.workerTaskId,
}
const execution = {
  executionId: "execution-1", workerTaskId: task.workerTaskId, applicationTaskId: task.id,
  userId: task.userId, jobId: task.jobId, sessionId: task.sessionId, fillTurnId: task.fillTurnId,
  approvalId: queue.approvalId, constraintHash: queue.constraintHash,
}
const producerEvidence = {
  schemaVersion: 1, userId: task.userId, sessionId: task.sessionId, fillTurnId: task.fillTurnId,
  applicationTaskId: task.id, jobId: task.jobId, approvalId: queue.approvalId, constraintHash: queue.constraintHash,
  workerTaskId: task.workerTaskId, executionId: execution.executionId, attemptId: "private-attempt",
  artifactHash: "artifact-hash", workerReport: "recorded_submitted", localRecord: "correlated", siteOutcome: "unverified",
}
const approval: SubmissionEvidenceApproval = {
  id: queue.approvalId, userId: task.userId, sessionId: task.sessionId, taskId: task.id,
  turnId: task.fillTurnId, jobId: task.jobId, toolCallId: `application-submit:${task.id}`,
  type: "submit_application", status: "consumed", scopeHash: queue.constraintHash, resourceHash: "artifact-hash",
}

function event(id: string, type: SubmissionEvidenceEvent["type"], actor: string, data: unknown): SubmissionEvidenceEvent {
  return { id, type, actor, data }
}

function eventRows(events: SubmissionEvidenceEvent[]) {
  return events.map(row => ({ id: row.id, type: row.type, actor: row.actor, data: row.data }))
}

function currentRow(events: SubmissionEvidenceEvent[], overrides: Record<string, unknown> = {}) {
  return { ...task, events: eventRows(events), ...overrides }
}

function exactEvents(): SubmissionEvidenceEvent[] {
  return [
    event("queued", "submission_queued", "user", { ...queue }),
    event("started", "submission_execution_started", "worker", { ...execution }),
    event("settled", "submission_execution_settled", "worker", { ...execution }),
    event("evidence", "submission_evidence_recorded", "worker", { ...producerEvidence }),
  ]
}

function client(events = exactEvents()) {
  return {
    applicationTask: { findMany: vi.fn().mockResolvedValue([currentRow(events)]) },
    agentApproval: { findMany: vi.fn().mockResolvedValue([approval]) },
  }
}

describe("readApplicationSubmissionEvidence", () => {
  it("reads bounded owner-scoped Task events and approvals, then emits only closed facts", async () => {
    const db = client()
    const evidence = await readApplicationSubmissionEvidence(db as never, task.userId, [task])

    expect(db.applicationTask.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1", id: { in: ["task-1"] } },
      select: {
        id: true, userId: true, jobId: true, sessionId: true, fillTurnId: true, fillTurnSessionId: true,
        fillTurnUserId: true, workerTaskId: true, status: true, checkpoint: true, updatedAt: true,
        events: {
          where: { type: { in: ["submission_queued", "submission_execution_started", "submission_execution_settled", "submission_evidence_recorded"] } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 33,
          select: { id: true, type: true, actor: true, data: true },
        },
      },
    })
    expect(db.agentApproval.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1", id: { in: ["approval-1"] }, taskId: { in: ["task-1"] } },
      take: 100,
      select: { id: true, userId: true, sessionId: true, taskId: true, turnId: true, jobId: true,
        toolCallId: true, type: true, status: true, scopeHash: true, resourceHash: true },
    })
    expect(JSON.stringify(db.agentApproval.findMany.mock.calls[0]?.[0])).not.toContain("payload")
    expect(evidence.get(task.id)).toEqual({
      visible: true, availability: "available", workerReport: "submitted", localRecord: "recorded", employerReceipt: "unverified",
    })
    expect(JSON.stringify([...evidence.values()])).not.toMatch(/task-1|user-1|private-attempt|artifact-hash|scope-hash/)
  })

  it("does not promote queued or settled-only Task events without the versioned Worker record", async () => {
    const db = client(exactEvents().filter(row => row.type !== "submission_evidence_recorded"))
    const evidence = await readApplicationSubmissionEvidence(db as never, task.userId, [task])

    expect(db.agentApproval.findMany).not.toHaveBeenCalled()
    expect(evidence.get(task.id)).toEqual({
      visible: true, availability: "unknown", workerReport: "unknown", localRecord: "unknown", employerReceipt: "unverified",
    })
  })

  it("returns unknown rather than unavailable when the current approval row is missing", async () => {
    const db = client()
    db.agentApproval.findMany.mockResolvedValueOnce([])
    const evidence = await readApplicationSubmissionEvidence(db as never, task.userId, [task])

    expect(evidence.get(task.id)).toEqual({
      visible: true, availability: "unknown", workerReport: "unknown", localRecord: "unknown", employerReceipt: "unverified",
    })
  })

  it("filters foreign Tasks from both reads and returns no evidence for them", async () => {
    const foreign = { ...task, id: "task-foreign", userId: "user-2" }
    const db = client()
    const evidence = await readApplicationSubmissionEvidence(db as never, task.userId, [task, foreign])

    expect(db.applicationTask.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "user-1", id: { in: ["task-1"] } } }))
    expect(db.agentApproval.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "user-1", id: { in: ["approval-1"] }, taskId: { in: ["task-1"] } },
    }))
    expect(evidence.get("task-foreign")).toEqual({
      visible: false, availability: "unknown", workerReport: "unknown", localRecord: "unknown", employerReceipt: "unverified",
    })
  })

  it("degrades event or approval permission failures to unavailable without leaking errors", async () => {
    const deniedEvents = client()
    deniedEvents.applicationTask.findMany.mockRejectedValueOnce(new Error("private event permission details"))
    const noEvents = await readApplicationSubmissionEvidence(deniedEvents as never, task.userId, [task])
    expect(noEvents.get(task.id)?.availability).toBe("unavailable")

    const deniedApproval = client()
    deniedApproval.agentApproval.findMany.mockRejectedValueOnce(new Error("private approval permission details"))
    const noApproval = await readApplicationSubmissionEvidence(deniedApproval as never, task.userId, [task])
    expect(noApproval.get(task.id)).toEqual({
      visible: true, availability: "unavailable", workerReport: "unknown", localRecord: "unknown", employerReceipt: "unverified",
    })
    expect(JSON.stringify([...noApproval.values()])).not.toMatch(/private|permission/)
  })

  it("rejects a Task snapshot that changed between the normal Task read and evidence read", async () => {
    const db = client()
    db.applicationTask.findMany.mockResolvedValueOnce([currentRow(exactEvents(), { checkpoint: "submission_uncertain" })])
    const evidence = await readApplicationSubmissionEvidence(db as never, task.userId, [task])
    expect(evidence.get(task.id)).toEqual({
      visible: true, availability: "unknown", workerReport: "unknown", localRecord: "unknown", employerReceipt: "unverified",
    })
  })

  it("does not query an empty or oversized Task window", async () => {
    const db = client()
    const empty = await readApplicationSubmissionEvidence(db as never, task.userId, [])
    const oversized = await readApplicationSubmissionEvidence(db as never, task.userId,
      Array.from({ length: 101 }, (_, index) => ({ ...task, id: `task-${index}` })))

    expect(empty.size).toBe(0)
    expect(db.applicationTask.findMany).not.toHaveBeenCalled()
    expect(db.agentApproval.findMany).not.toHaveBeenCalled()
    expect(oversized.size).toBe(101)
    expect(oversized.get("task-0")?.availability).toBe("unavailable")
  })
})
