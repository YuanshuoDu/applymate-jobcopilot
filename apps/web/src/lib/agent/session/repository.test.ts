import { describe, expect, it, vi } from "vitest"
import {
  appendTranscriptEvent,
  createAgentSession,
  createSubAgentTask,
  completeSubAgentTask,
} from "./repository"

function mockDb() {
  return {
    agentSession: {
      create: vi.fn(async ({ data }) => ({
        id: "session_1",
        status: "running",
        memorySummary: "",
        qualityScore: null,
        currentTaskId: null,
        ...data,
      })),
      update: vi.fn(async ({ data }) => ({
        id: "session_1",
        ...data,
      })),
    },
    agentTranscriptEvent: {
      create: vi.fn(async ({ data }) => ({
        id: "event_1",
        taskId: null,
        title: null,
        durationMs: null,
        data: null,
        ...data,
      })),
    },
    subAgentTask: {
      create: vi.fn(async ({ data }) => ({
        id: "task_1",
        status: "queued",
        result: null,
        confidence: null,
        failureReason: null,
        qualityGateResult: null,
        ...data,
      })),
      update: vi.fn(async ({ data }) => ({
        id: "task_1",
        ...data,
      })),
    },
  }
}

describe("agent session repository", () => {
  it("creates a running session with explicit goal and source", async () => {
    const db = mockDb()

    const session = await createAgentSession(db, {
      userId: "user_1",
      goal: "Apply to Berlin SWE roles over 85 with approval",
      source: "chat",
    })

    expect(session).toMatchObject({
      userId: "user_1",
      goal: "Apply to Berlin SWE roles over 85 with approval",
      source: "chat",
      status: "running",
      memorySummary: "",
    })
    expect(db.agentSession.create).toHaveBeenCalledWith({
      data: {
        userId: "user_1",
        goal: "Apply to Berlin SWE roles over 85 with approval",
        source: "chat",
        status: "running",
        memorySummary: "",
      },
    })
  })

  it("appends transcript events with nullable task metadata", async () => {
    const db = mockDb()

    const event = await appendTranscriptEvent(db, {
      sessionId: "session_1",
      type: "orchestrator_plan",
      speaker: "Orchestrator",
      body: "Run liveness before spending AI tokens.",
      data: { gates: ["LivenessGate"] },
    })

    expect(event).toMatchObject({
      sessionId: "session_1",
      taskId: null,
      type: "orchestrator_plan",
      speaker: "Orchestrator",
      title: null,
      body: "Run liveness before spending AI tokens.",
      data: { gates: ["LivenessGate"] },
      durationMs: null,
    })
  })

  it("creates a queued subagent task with a narrow task contract", async () => {
    const db = mockDb()
    const schema = {
      type: "object",
      required: ["status", "confidence"],
      properties: { status: { type: "string" }, confidence: { type: "number" } },
    }

    const task = await createSubAgentTask(db, {
      sessionId: "session_1",
      role: "scout",
      taskType: "liveness_gate",
      goal: "Check whether the posting is still active.",
      constraints: ["Do not classify anti-bot pages as expired."],
      successCriteria: ["Return active, expired, or uncertain with evidence."],
      allowedActions: ["fetch_url", "inspect_page"],
      context: { url: "https://example.com/job/123" },
      expectedOutputSchema: schema,
    })

    expect(task).toMatchObject({
      sessionId: "session_1",
      role: "scout",
      taskType: "liveness_gate",
      status: "queued",
      goal: "Check whether the posting is still active.",
      constraints: ["Do not classify anti-bot pages as expired."],
      successCriteria: ["Return active, expired, or uncertain with evidence."],
      allowedActions: ["fetch_url", "inspect_page"],
      context: { url: "https://example.com/job/123" },
      expectedOutputSchema: schema,
    })
  })

  it("completes a task with structured result and quality gate data", async () => {
    const db = mockDb()

    const task = await completeSubAgentTask(db, {
      taskId: "task_1",
      status: "passed",
      result: { status: "active", confidence: 0.94 },
      confidence: 0.94,
      qualityGateResult: {
        gate: "LivenessGate",
        status: "passed",
        score: 0.94,
        retryRecommended: false,
        askUserRecommended: false,
        hitMissReason: "title and apply button matched",
        evidence: ["apply button visible"],
      },
    })

    expect(db.subAgentTask.update).toHaveBeenCalledWith({
      where: { id: "task_1" },
      data: {
        status: "passed",
        result: { status: "active", confidence: 0.94 },
        confidence: 0.94,
        failureReason: null,
        qualityGateResult: {
          gate: "LivenessGate",
          status: "passed",
          score: 0.94,
          retryRecommended: false,
          askUserRecommended: false,
          hitMissReason: "title and apply button matched",
          evidence: ["apply button visible"],
        },
      },
    })
    expect(task).toMatchObject({ status: "passed", confidence: 0.94 })
  })
})
