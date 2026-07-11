import { describe, expect, it, vi } from "vitest"
import { runSubAgentTask } from "./subagent-task-runner"

function mockDb() {
  return {
    agentSession: {
      create: vi.fn(),
      update: vi.fn(async ({ data }) => ({ id: "session_1", ...data })),
    },
    agentTranscriptEvent: {
      create: vi.fn(async ({ data }) => ({
        id: `event_${data.type}`,
        createdAt: new Date("2026-06-20T09:00:00Z"),
        ...data,
      })),
    },
    subAgentTask: {
      create: vi.fn(async ({ data }) => ({
        id: "task_1",
        status: "queued",
        ...data,
      })),
      update: vi.fn(async ({ data }) => ({
        id: "task_1",
        ...data,
      })),
    },
  }
}

const contract = {
  sessionId: "session_1",
  role: "scout" as const,
  taskType: "liveness_gate",
  goal: "Check whether the posting is still active.",
  constraints: ["Do not mark anti-bot pages as expired."],
  successCriteria: ["Return active, expired, or uncertain with evidence."],
  allowedActions: ["fetch_url", "inspect_page"],
  context: { url: "https://example.com/job/123" },
  expectedOutputSchema: {
    type: "object",
    required: ["status", "confidence"],
  },
}

describe("runSubAgentTask", () => {
  it("creates a task, records lifecycle transcript events, and stores structured success", async () => {
    const db = mockDb()

    const result = await runSubAgentTask(db, contract, async () => ({
      result: { status: "active", evidence: ["apply button visible"] },
      confidence: 0.94,
      summary: "Posting is active.",
      qualityGateResult: {
        gate: "LivenessGate",
        status: "passed",
        score: 0.94,
        retryRecommended: false,
        askUserRecommended: false,
        hitMissReason: "apply button visible",
        evidence: ["apply button visible"],
      },
    }))

    expect(result).toMatchObject({
      status: "passed",
      taskId: "task_1",
      result: { status: "active" },
      confidence: 0.94,
    })
    expect(db.subAgentTask.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionId: "session_1",
        role: "scout",
        status: "queued",
        goal: "Check whether the posting is still active.",
      }),
    })
    expect(db.agentSession.update).toHaveBeenCalledWith({
      where: { id: "session_1" },
      data: { currentTaskId: "task_1" },
    })
    expect(db.agentTranscriptEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionId: "session_1",
        taskId: "task_1",
        type: "subagent_task_started",
        speaker: "Scout",
      }),
    })
    expect(db.subAgentTask.update).toHaveBeenCalledWith({
      where: { id: "task_1" },
      data: expect.objectContaining({
        status: "passed",
        result: { status: "active", evidence: ["apply button visible"] },
        confidence: 0.94,
        failureReason: null,
      }),
    })
    expect(db.agentTranscriptEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionId: "session_1",
        taskId: "task_1",
        type: "subagent_result",
        speaker: "Scout",
        body: "Posting is active.",
      }),
    })
  })

  it("marks the task failed and records an error transcript when the handler throws", async () => {
    const db = mockDb()

    const result = await runSubAgentTask(db, contract, async () => {
      throw new Error("Network blocked")
    })

    expect(result).toMatchObject({
      status: "failed",
      taskId: "task_1",
      failureReason: "Network blocked",
    })
    expect(db.subAgentTask.update).toHaveBeenCalledWith({
      where: { id: "task_1" },
      data: expect.objectContaining({
        status: "failed",
        result: null,
        confidence: 0,
        failureReason: "Network blocked",
      }),
    })
    expect(db.agentTranscriptEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionId: "session_1",
        taskId: "task_1",
        type: "error",
        speaker: "Scout",
        body: "Network blocked",
      }),
    })
  })
})
