import {
  APPLICATION_SUBMISSION_STOP_PROTOCOL_SCHEMA,
  applicationSubmissionStopEventId,
  type ApplicationSubmissionStopAttempt,
  type ApplicationSubmissionStopStage,
} from "@jobcopilot/shared/application-submission-stop-protocol"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }))
vi.mock("@/lib/db", () => ({ db: { applicationTask: { findMany: mocks.findMany } } }))

import { createApplicationSubmissionStopTarget } from "./submission-stop"
import { readApplicationSubmissionStopTargets } from "./submission-stop-target"

const body = "Application submission Stop protocol state recorded."
const attempt: ApplicationSubmissionStopAttempt = {
  userId: "private-user-1", sessionId: "private-session-1", fillTurnId: "private-turn-1",
  applicationTaskId: "private-task-1", jobId: "private-job-1", approvalId: "private-receipt-1",
  receiptId: "private-receipt-1", constraintHash: "a".repeat(64), workerTaskId: "private-worker-1",
  executionId: "private-execution-1",
}
const snapshot = {
  id: attempt.applicationTaskId, userId: attempt.userId, sessionId: attempt.sessionId, jobId: attempt.jobId,
  fillTurnId: attempt.fillTurnId, fillTurnSessionId: attempt.sessionId, fillTurnUserId: attempt.userId,
  workerTaskId: attempt.workerTaskId, status: "filling", checkpoint: "submission_request_started",
}
const key = {
  userId: attempt.userId, sessionId: attempt.sessionId, fillTurnId: attempt.fillTurnId,
  applicationTaskId: attempt.applicationTaskId, jobId: attempt.jobId, approvalId: attempt.approvalId,
  receiptId: attempt.receiptId, constraintHash: attempt.constraintHash, workerTaskId: attempt.workerTaskId,
}
type TestEvent = { id: string; taskId: string; type: string; actor: string; body: string; data: unknown }

function protocol(stage: ApplicationSubmissionStopStage, changes: Partial<ApplicationSubmissionStopAttempt> = {}) {
  const data = { schemaVersion: APPLICATION_SUBMISSION_STOP_PROTOCOL_SCHEMA, stage, ...attempt, ...changes }
  return {
    id: applicationSubmissionStopEventId(key, stage), taskId: attempt.applicationTaskId,
    type: "submission_stop_protocol", actor: stage === "stop_requested" ? "user" : "worker", body, data,
  }
}

function exactEvents(): TestEvent[] {
  return [
    { id: "queued-1", taskId: attempt.applicationTaskId, type: "submission_queued", actor: "user", body: "queued", data: key },
    {
      id: `evt_${attempt.executionId}`, taskId: attempt.applicationTaskId, type: "submission_execution_started",
      actor: "worker", body: "Submit execution started", data: {
        executionId: attempt.executionId, workerTaskId: attempt.workerTaskId, applicationTaskId: attempt.applicationTaskId,
        userId: attempt.userId, jobId: attempt.jobId, sessionId: attempt.sessionId, fillTurnId: attempt.fillTurnId,
        approvalId: attempt.approvalId, constraintHash: attempt.constraintHash,
      },
    },
    protocol("armed"),
  ]
}

function currentTask(events: TestEvent[] = exactEvents()) { return { ...snapshot, events } }

describe("Workbench submission Stop target projection", () => {
  beforeEach(() => mocks.findMany.mockReset())

  it("returns an opaque target only for the exact queued, started and armed attempt", async () => {
    mocks.findMany.mockResolvedValue([currentTask()])

    const targets = await readApplicationSubmissionStopTargets(attempt.userId, attempt.sessionId, [snapshot])

    expect(targets.size).toBe(1)
    expect(targets.get(attempt.applicationTaskId)).toMatch(/^ast1_[a-f0-9]{64}$/)
    expect(targets.get(attempt.applicationTaskId)).toBe(createApplicationSubmissionStopTarget(attempt))
    expect(targets.get(attempt.applicationTaskId)).not.toContain(attempt.workerTaskId)
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: { in: [attempt.applicationTaskId] }, userId: attempt.userId, sessionId: attempt.sessionId,
        status: "filling", checkpoint: "submission_request_started",
      },
      take: 1,
      select: expect.objectContaining({
        events: expect.objectContaining({ take: 34, where: { type: { in: expect.arrayContaining(["submission_queued", "submission_execution_started", "submission_stop_protocol"]) } } }),
      }),
    }))
  })

  it("does not read event history when the bounded session list has no eligible task", async () => {
    const ineligible = { ...snapshot, status: "waiting_for_user" }
    await expect(readApplicationSubmissionStopTargets(attempt.userId, attempt.sessionId, [ineligible])).resolves.toEqual(new Map())
    expect(mocks.findMany).not.toHaveBeenCalled()
  })

  it("removes a token if a duplicate reread row appears", async () => {
    mocks.findMany.mockResolvedValue([currentTask(), currentTask()])
    await expect(readApplicationSubmissionStopTargets(attempt.userId, attempt.sessionId, [snapshot])).resolves.toEqual(new Map())
  })

  it.each([
    ["foreign owner", { userId: "other-user" }],
    ["foreign Session", { sessionId: "other-session", fillTurnSessionId: "other-session" }],
    ["foreign Fill Turn owner", { fillTurnUserId: "other-user" }],
    ["missing Worker task", { workerTaskId: null }],
  ])("skips a snapshot with %s before reading events", async (_label, changes) => {
    await expect(readApplicationSubmissionStopTargets(attempt.userId, attempt.sessionId, [{ ...snapshot, ...changes }])).resolves.toEqual(new Map())
    expect(mocks.findMany).not.toHaveBeenCalled()
  })

  it.each([
    ["changed Worker task", { workerTaskId: "new-worker" }],
    ["changed status", { status: "submitted" }],
    ["changed checkpoint", { checkpoint: "submission_uncertain" }],
    ["changed Fill Turn", { fillTurnId: "new-turn" }],
  ])("omits a target when the bounded snapshot changed: %s", async (_label, changes) => {
    mocks.findMany.mockResolvedValueOnce([{ ...currentTask(), ...changes }])
    await expect(readApplicationSubmissionStopTargets(attempt.userId, attempt.sessionId, [snapshot])).resolves.toEqual(new Map())
  })

  it.each([
    ["missing armed record", exactEvents().slice(0, 2)],
    ["duplicate queue record", [...exactEvents(), exactEvents()[0]]],
    ["duplicate start marker", [...exactEvents(), exactEvents()[1]]],
    ["duplicate armed record", [...exactEvents(), protocol("armed")]],
    ["Stop already recorded", [...exactEvents(), protocol("stop_requested")]],
    ["grant already recorded", [...exactEvents(), protocol("dispatch_granted")]],
    ["malformed queue payload", [{ ...exactEvents()[0], data: { ...key, extra: true } }, ...exactEvents().slice(1)]],
    ["wrong queue actor", [{ ...exactEvents()[0], actor: "worker" }, ...exactEvents().slice(1)]],
    ["wrong start marker ID", [exactEvents()[0], { ...exactEvents()[1], id: "start-other" }, exactEvents()[2]]],
    ["wrong start actor", [exactEvents()[0], { ...exactEvents()[1], actor: "user" }, exactEvents()[2]]],
    ["mismatched armed attempt", [...exactEvents().slice(0, 2), protocol("armed", { constraintHash: "b".repeat(64) })]],
    ["same receipt queued by another Worker task", [
      { ...exactEvents()[0], id: "queued-prior", data: { ...key, workerTaskId: "prior-worker" } }, ...exactEvents(),
    ]],
  ])("fails closed for %s", async (_label, events) => {
    mocks.findMany.mockResolvedValue([currentTask(events)])
    await expect(readApplicationSubmissionStopTargets(attempt.userId, attempt.sessionId, [snapshot])).resolves.toEqual(new Map())
  })

  it.each(["submission_execution_settled", "submission_evidence_recorded"])("omits a target after %s for this Worker task", async type => {
    mocks.findMany.mockResolvedValue([currentTask([...exactEvents(), {
      id: "terminal-1", taskId: attempt.applicationTaskId, type, actor: "worker", body: "terminal",
      data: { workerTaskId: attempt.workerTaskId },
    }])])
    await expect(readApplicationSubmissionStopTargets(attempt.userId, attempt.sessionId, [snapshot])).resolves.toEqual(new Map())
  })

  it("rejects oversized candidate event history without inspecting a partial prefix", async () => {
    mocks.findMany.mockResolvedValue([currentTask(Array.from({ length: 34 }, (_, index) => exactEvents()[index % 3]))])
    await expect(readApplicationSubmissionStopTargets(attempt.userId, attempt.sessionId, [snapshot])).resolves.toEqual(new Map())
  })
})
