import { describe, expect, it } from "vitest"
import { unknownApplicationSubmissionEvidence } from "./application-submission-evidence"
import { applicationTaskSummary, mayCancelApplicationTask, projectApplicationTaskReadViews } from "./application-task-view"

describe("application task view", () => {
  it("groups the durable task states for the Agent summary", () => {
    expect(applicationTaskSummary([
      { status: "submitted" }, { status: "waiting_for_user" }, { status: "waiting_for_authorization" },
      { status: "failed" }, { status: "filling" }, { status: "skipped" },
    ])).toEqual({ submitted: 1, skipped: 1, failed: 1, needsUser: 2, inProgress: 1 })
  })

  it("keeps only bounded display fields and the evidence projection", () => {
    const source = {
      id: "task_1", userId: "user_1", jobId: "job_1", sessionId: "session_1",
      status: "submitted", checkpoint: "submission_verified", updatedAt: new Date("2026-11-12T10:00:00Z"),
      job: { company: "Example", role: "Engineer", url: "https://private.example/apply" },
      workerTaskId: "worker-secret", fillTurnId: "turn-secret", error: "private error",
      confirmedAnswers: { salary: "private" }, events: [{ body: "private event", data: { constraintHash: "secret" } }],
    }
    const evidence = { visible: true, availability: "available" as const, workerReport: "submitted" as const,
      localRecord: "recorded" as const, employerReceipt: "unverified" as const }
    const views = projectApplicationTaskReadViews([source], new Map([["task_1", evidence]]))

    expect(views).toEqual([{
      id: "task_1", userId: "user_1", jobId: "job_1", sessionId: "session_1",
      status: "submitted", checkpoint: "submission_verified", updatedAt: "2026-11-12T10:00:00.000Z",
      job: { company: "Example", role: "Engineer" }, submissionEvidence: evidence,
    }])
    expect(JSON.stringify(views)).not.toContain("private")
    expect(JSON.stringify(views)).not.toContain("secret")
    expect(JSON.stringify(views)).not.toContain("https://")
  })

  it("defaults legacy tasks to unknown evidence without changing Task status", () => {
    const source = {
      id: "task_legacy", userId: "user_1", jobId: "job_1", sessionId: null,
      status: "submitted", checkpoint: null, updatedAt: new Date("2026-11-12T10:00:00Z"),
      job: { company: "Example", role: "Engineer" },
    }
    const views = projectApplicationTaskReadViews([source], new Map())
    expect(views[0]?.submissionEvidence).toEqual(unknownApplicationSubmissionEvidence(true, "unknown"))
    expect(views[0]?.status).toBe("submitted")
  })

  it("strips unexpected evidence fields and never accepts employer receipt claims", () => {
    const source = {
      id: "task_1", userId: "user_1", jobId: "job_1", sessionId: null,
      status: "submitted", checkpoint: "submission_verified", updatedAt: new Date("2026-11-12T10:00:00Z"),
      job: { company: "Example", role: "Engineer" },
    }
    const untrusted = {
      visible: true, availability: "available", workerReport: "submitted", localRecord: "recorded",
      employerReceipt: "confirmed", attemptId: "secret", constraintHash: "secret",
    } as never
    const evidence = projectApplicationTaskReadViews([source], new Map([["task_1", untrusted]]))[0]?.submissionEvidence

    expect(evidence).toEqual({
      visible: true, availability: "available", workerReport: "submitted", localRecord: "recorded", employerReceipt: "unverified",
    })
    expect(JSON.stringify(evidence)).not.toContain("secret")
  })

  it("does not show submission evidence for a task that has not reached submission", () => {
    const source = {
      id: "task_1", userId: "user_1", jobId: "job_1", sessionId: null,
      status: "filling", checkpoint: "browser_active", updatedAt: new Date("2026-11-12T10:00:00Z"),
      job: { company: "Example", role: "Engineer" },
    }
    const views = projectApplicationTaskReadViews([source], new Map())
    expect(views[0]?.submissionEvidence).toEqual(unknownApplicationSubmissionEvidence(false, "unknown"))
  })

  it("never offers cancellation for a completed submission", () => {
    expect(mayCancelApplicationTask("submitted")).toBe(false)
    expect(mayCancelApplicationTask("skipped")).toBe(false)
    expect(mayCancelApplicationTask("waiting_for_user")).toBe(true)
  })
})
