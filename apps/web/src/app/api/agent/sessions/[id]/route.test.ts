import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  APPLICATION_SUBMISSION_STOP_PROTOCOL_SCHEMA,
  applicationSubmissionStopEventId,
} from "@jobcopilot/shared/application-submission-stop-protocol"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findFirst: vi.fn(),
  questionFindMany: vi.fn(),
  applicationTaskFindMany: vi.fn(),
  executionFindFirst: vi.fn(),
  deleteMany: vi.fn(),
  updateMany: vi.fn(),
}))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (val: unknown) => val instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

vi.mock("@/lib/db", () => ({
  db: {
    agentSession: {
      findFirst: mocks.findFirst,
      deleteMany: mocks.deleteMany,
      updateMany: mocks.updateMany,
    },
    agentRunQuestion: { findMany: mocks.questionFindMany },
    applicationTask: { findMany: mocks.applicationTaskFindMany },
    agentExecution: { findFirst: mocks.executionFindFirst },
  },
}))

function getRequest() {
  return new Request("http://localhost/api/agent/sessions/session_1")
}

const params = { params: Promise.resolve({ id: "session_1" }) }
const stopAttempt = {
  userId: "user_1", sessionId: "session_1", fillTurnId: "private_turn", applicationTaskId: "application_1",
  jobId: "private_job", approvalId: "private_receipt", receiptId: "private_receipt",
  constraintHash: "a".repeat(64), workerTaskId: "private_worker", executionId: "private_execution",
}
const stopKey = {
  userId: stopAttempt.userId, sessionId: stopAttempt.sessionId, fillTurnId: stopAttempt.fillTurnId,
  applicationTaskId: stopAttempt.applicationTaskId, jobId: stopAttempt.jobId, approvalId: stopAttempt.approvalId,
  receiptId: stopAttempt.receiptId, constraintHash: stopAttempt.constraintHash, workerTaskId: stopAttempt.workerTaskId,
}

function stopEvidenceEvents() {
  return [
    {
      id: "queued_1", taskId: stopAttempt.applicationTaskId, type: "submission_queued", actor: "user", body: "queued",
      data: stopKey,
    },
    {
      id: `evt_${stopAttempt.executionId}`, taskId: stopAttempt.applicationTaskId,
      type: "submission_execution_started", actor: "worker", body: "Submit execution started",
      data: {
        executionId: stopAttempt.executionId, workerTaskId: stopAttempt.workerTaskId,
        applicationTaskId: stopAttempt.applicationTaskId, userId: stopAttempt.userId,
        jobId: stopAttempt.jobId, sessionId: stopAttempt.sessionId, fillTurnId: stopAttempt.fillTurnId,
        approvalId: stopAttempt.approvalId, constraintHash: stopAttempt.constraintHash,
      },
    },
    {
      id: applicationSubmissionStopEventId(stopKey, "armed"), taskId: stopAttempt.applicationTaskId,
      type: "submission_stop_protocol", actor: "worker", body: "Application submission Stop protocol state recorded.",
      data: { schemaVersion: APPLICATION_SUBMISSION_STOP_PROTOCOL_SCHEMA, stage: "armed", ...stopAttempt },
    },
  ]
}

describe("agent session detail API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.findFirst.mockReset()
    mocks.questionFindMany.mockReset()
    mocks.applicationTaskFindMany.mockReset()
    mocks.executionFindFirst.mockReset()
    mocks.deleteMany.mockReset()
    mocks.updateMany.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.deleteMany.mockResolvedValue({ count: 1 })
    mocks.updateMany.mockResolvedValue({ count: 1 })
    mocks.questionFindMany.mockResolvedValue([])
    mocks.applicationTaskFindMany.mockResolvedValue([])
    mocks.executionFindFirst.mockResolvedValue(null)
  })

  it("returns a session with task and approval summaries for the owner", async () => {
    mocks.findFirst.mockResolvedValueOnce({
      id: "session_1",
      goal: "Apply to Berlin SWE roles",
      status: "running",
      source: "manual_run",
      memorySummary: "Processed 10 jobs · applied 4",
      qualityScore: 87,
      currentTaskId: "task_1",
      createdAt: new Date("2026-06-18T08:00:00Z"),
      updatedAt: new Date("2026-06-18T08:05:00Z"),
      completedAt: null,
      tasks: [
        {
          id: "task_1",
          role: "scout",
          taskType: "liveness_gate",
          status: "passed",
          confidence: 0.94,
          failureReason: null,
          createdAt: new Date("2026-06-18T08:01:00Z"),
          updatedAt: new Date("2026-06-18T08:02:00Z"),
        },
      ],
      approvals: [
        {
          id: "approval_1",
          type: "apply_jobs",
          status: "pending",
          title: "Submit 4 applications",
          createdAt: new Date("2026-06-18T08:03:00Z"),
        },
      ],
    })
    const { GET } = await import("./route")

    const res = await GET(getRequest() as never, params)

    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toBe("private, no-store")
    await expect(res.json()).resolves.toEqual({
      session: {
        id: "session_1",
        goal: "Apply to Berlin SWE roles",
        status: "running",
        source: "manual_run",
        memorySummary: "Processed 10 jobs · applied 4",
        qualityScore: 87,
        currentTaskId: "task_1",
        createdAt: "2026-06-18T08:00:00.000Z",
        updatedAt: "2026-06-18T08:05:00.000Z",
        completedAt: null,
        tasks: [
          {
            id: "task_1",
            role: "scout",
            taskType: "liveness_gate",
            status: "passed",
            confidence: 0.94,
            failureReason: null,
            createdAt: "2026-06-18T08:01:00.000Z",
            updatedAt: "2026-06-18T08:02:00.000Z",
          },
        ],
        approvals: [
          {
            id: "approval_1",
            type: "apply_jobs",
            status: "pending",
            title: "Submit 4 applications",
            createdAt: "2026-06-18T08:03:00.000Z",
          },
        ],
        applicationTasks: [],
        execution: null,
        questions: [],
      },
    })
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { id: "session_1", userId: "user_1" },
      select: {
        id: true,
        goal: true,
        status: true,
        source: true,
        memorySummary: true,
        qualityScore: true,
        currentTaskId: true,
        createdAt: true,
        updatedAt: true,
        completedAt: true,
        tasks: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            role: true,
            taskType: true,
            status: true,
            confidence: true,
            failureReason: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        approvals: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            type: true,
            status: true,
            title: true,
            createdAt: true,
          },
        },
      },
    })
  })

  it("replays historical sessions when optional control-plane tables are not migrated yet", async () => {
    mocks.findFirst.mockResolvedValueOnce({
      id: "session_1", goal: "Historical run", status: "completed", source: "manual_run", memorySummary: "Done",
      qualityScore: 100, currentTaskId: null, createdAt: new Date("2026-06-18T08:00:00Z"), updatedAt: new Date("2026-06-18T08:05:00Z"), completedAt: new Date("2026-06-18T08:05:00Z"), tasks: [], approvals: [],
    })
    mocks.applicationTaskFindMany.mockRejectedValueOnce({ code: "P2021" })
    mocks.executionFindFirst.mockRejectedValueOnce({ code: "P2021" })
    mocks.questionFindMany.mockRejectedValueOnce({ code: "P2021" })
    const { GET } = await import("./route")

    const res = await GET(getRequest() as never, params)

    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toBe("private, no-store")
    await expect(res.json()).resolves.toMatchObject({
      session: { id: "session_1", questions: [], applicationTasks: [], execution: null },
    })
  })

  it("returns 404 when the session is not owned by the user", async () => {
    mocks.findFirst.mockResolvedValueOnce(null)
    const { GET } = await import("./route")

    const res = await GET(getRequest() as never, params)

    expect(res.status).toBe(404)
    expect(res.headers.get("Cache-Control")).toBe("private, no-store")
    await expect(res.json()).resolves.toEqual({ error: "Session not found" })
  })

  it("projects only an opaque target for the exact armed application attempt", async () => {
    mocks.findFirst.mockResolvedValueOnce({
      id: "session_1", goal: "Apply", status: "completed", source: "manual_run", memorySummary: "Done",
      qualityScore: null, currentTaskId: null, createdAt: new Date(0), updatedAt: new Date(0), completedAt: new Date(0),
      tasks: [], approvals: [],
    })
    const publicFields = {
      id: "application_1", status: "filling", checkpoint: "submission_request_started", error: null,
      question: null, job: { company: "Example", role: "Engineer" },
    }
    mocks.applicationTaskFindMany
      .mockResolvedValueOnce([{ ...publicFields, userId: stopAttempt.userId, sessionId: stopAttempt.sessionId,
        jobId: stopAttempt.jobId, fillTurnId: stopAttempt.fillTurnId, fillTurnSessionId: stopAttempt.sessionId,
        fillTurnUserId: stopAttempt.userId, workerTaskId: stopAttempt.workerTaskId }])
      .mockResolvedValueOnce([{
        id: stopAttempt.applicationTaskId, userId: stopAttempt.userId, sessionId: stopAttempt.sessionId,
        jobId: stopAttempt.jobId, fillTurnId: stopAttempt.fillTurnId, fillTurnSessionId: stopAttempt.sessionId,
        fillTurnUserId: stopAttempt.userId, workerTaskId: stopAttempt.workerTaskId,
        status: "filling", checkpoint: "submission_request_started", events: stopEvidenceEvents(),
      }])
    const { GET } = await import("./route")

    const res = await GET(getRequest() as never, params)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toBe("private, no-store")
    expect(body.session.applicationTasks).toHaveLength(1)
    expect(body.session.applicationTasks[0]).toMatchObject({ ...publicFields, submissionStopTarget: expect.stringMatching(/^ast1_[a-f0-9]{64}$/) })
    const serialized = JSON.stringify(body)
    for (const privateValue of [stopAttempt.userId, stopAttempt.jobId, stopAttempt.fillTurnId, stopAttempt.workerTaskId, stopAttempt.receiptId, stopAttempt.constraintHash]) {
      expect(serialized).not.toContain(privateValue)
    }
  }, 15_000)

  it("deletes an owned session", async () => {
    const { DELETE } = await import("./route")

    const res = await DELETE(getRequest() as never, params)

    expect(res.status).toBe(204)
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { id: "session_1", userId: "user_1" },
    })
  })

  it("records the last opened session only when it belongs to the user", async () => {
    const { PATCH } = await import("./route")

    const res = await PATCH(getRequest() as never, params)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ id: "session_1" })
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "session_1", userId: "user_1" },
      data: { lastViewedAt: expect.any(Date) },
    })
  })

  it("does not record a session outside the current user", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 0 })
    const { PATCH } = await import("./route")

    const res = await PATCH(getRequest() as never, params)

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: "Session not found" })
  })

  it("does not delete a session outside the current user", async () => {
    mocks.deleteMany.mockResolvedValueOnce({ count: 0 })
    const { DELETE } = await import("./route")

    const res = await DELETE(getRequest() as never, params)

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: "Session not found" })
  })

  it("returns auth errors without querying sessions", async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const { GET } = await import("./route")

    const res = await GET(getRequest() as never, params)

    expect(res.status).toBe(401)
    expect(res.headers.get("Cache-Control")).toBe("private, no-store")
    expect(mocks.findFirst).not.toHaveBeenCalled()
  })
})
