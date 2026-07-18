import { describe, expect, it, vi } from "vitest"
import { createRunSessionRecorder, mapPipelineEventToTranscript } from "./run-recorder"

function mockDb() {
  return {
    agentSession: {
      create: vi.fn(async ({ data }) => ({ id: "session_1", ...data })),
      update: vi.fn(async ({ data }) => ({ id: "session_1", ...data })),
    },
    agentTranscriptEvent: {
      create: vi.fn(async ({ data }) => ({ id: "event_1", ...data })),
    },
    subAgentTask: {
      create: vi.fn(),
      update: vi.fn(),
    },
  }
}

describe("run session recorder", () => {
  it("creates a manual_run session for the current pipeline run", async () => {
    const db = mockDb()

    const recorder = await createRunSessionRecorder(db, {
      userId: "user_1",
      goal: "Manual Agent Pipeline Run",
    })

    expect(recorder.sessionId).toBe("session_1")
    expect(db.agentSession.create).toHaveBeenCalledWith({
      data: {
        userId: "user_1",
        goal: "Manual Agent Pipeline Run",
        source: "manual_run",
        status: "running",
        memorySummary: "",
      },
    })
  })

  it("binds pipeline events to an existing chat session instead of creating another session", async () => {
    const db = mockDb()
    const recorder = await createRunSessionRecorder(db, {
      userId: "user_1",
      goal: "Chat Agent Pipeline Run",
      sessionId: "chat_session_1",
    })

    expect(recorder.sessionId).toBe("chat_session_1")
    expect(db.agentSession.create).not.toHaveBeenCalled()
    expect(db.agentSession.update).toHaveBeenCalledWith({
      where: { id: "chat_session_1" },
      data: { status: "running", completedAt: null },
    })

    await recorder.record("agent_plan", { role: "scout", plan: "Find matching jobs" })
    expect(db.agentTranscriptEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ sessionId: "chat_session_1" }),
    })
  })

  it("maps orchestrator and agent events to transcript event types", () => {
    expect(mapPipelineEventToTranscript("orchestrator_plan", { plan: "Run gates first" })).toMatchObject({
      type: "orchestrator_plan",
      speaker: "Orchestrator",
      title: "Plan",
      body: "Run gates first",
    })

    expect(mapPipelineEventToTranscript("agent_reflect", { role: "analyst", reflect: "Score confidence is high" })).toMatchObject({
      type: "thinking_summary",
      speaker: "Analyst",
      title: "Thinking Summary",
      body: "Score confidence is high",
    })

    expect(mapPipelineEventToTranscript("job_done", { company: "N26", role: "Software Engineer", score: 94 })).toMatchObject({
      type: "job_results",
      speaker: "Analyst",
      title: "Job Result",
      body: "N26 · Software Engineer — 94%",
    })
  })

  it("records mapped pipeline events as transcript rows", async () => {
    const db = mockDb()
    const recorder = await createRunSessionRecorder(db, {
      userId: "user_1",
      goal: "Manual Agent Pipeline Run",
    })

    await recorder.record("agent_plan", { role: "scout", plan: "Check saved jobs" })

    expect(db.agentTranscriptEvent.create).toHaveBeenCalledWith({
      data: {
        sessionId: "session_1",
        taskId: null,
        type: "orchestrator_plan",
        speaker: "Scout",
        title: "Plan",
        body: "Check saved jobs",
        data: { event: "agent_plan", payload: { role: "scout", plan: "Check saved jobs" } },
        durationMs: null,
      },
    })
  })

  it("creates and completes SubAgentTask rows from role lifecycle events", async () => {
    const db = mockDb()
    db.subAgentTask.create.mockResolvedValueOnce({
      id: "task_1",
      role: "scout",
      status: "queued",
    })
    db.subAgentTask.update.mockResolvedValueOnce({
      id: "task_1",
      status: "passed",
    })
    const recorder = await createRunSessionRecorder(db, {
      userId: "user_1",
      goal: "Manual Agent Pipeline Run",
    })

    await recorder.record("role_start", { role: "scout", plan: "Find saved and discovered jobs" })
    await recorder.record("role_done", { role: "scout", summary: "42 jobs queued", count: 42, durationMs: 1200 })

    expect(db.subAgentTask.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionId: "session_1",
        role: "scout",
        taskType: "pipeline_stage",
        status: "queued",
        goal: "Find saved and discovered jobs",
      }),
    })
    expect(db.subAgentTask.update).toHaveBeenCalledWith({
      where: { id: "task_1" },
      data: expect.objectContaining({
        status: "passed",
        result: { role: "scout", summary: "42 jobs queued", count: 42, durationMs: 1200 },
        confidence: 1,
        failureReason: null,
      }),
    })
    expect(db.agentTranscriptEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionId: "session_1",
        taskId: "task_1",
        type: "subagent_task_started",
        speaker: "Scout",
      }),
    })
    expect(db.agentTranscriptEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionId: "session_1",
        taskId: "task_1",
        type: "subagent_result",
        speaker: "Scout",
        body: "42 jobs queued",
      }),
    })
  })

  it("finalizes the session with completed status and quality score", async () => {
    const db = mockDb()
    const recorder = await createRunSessionRecorder(db, {
      userId: "user_1",
      goal: "Manual Agent Pipeline Run",
    })

    await recorder.finalize({
      status: "completed",
      report: { processed: 10, applied: 4, pending: 2, skipped: 4, failed: 0, durationMs: 120000 },
    })

    expect(db.agentSession.update).toHaveBeenCalledWith({
      where: { id: "session_1" },
      data: {
        status: "completed",
        completedAt: expect.any(Date),
        qualityScore: 100,
        memorySummary: "Processed 10 jobs · applied 4 · pending 2 · skipped 4 · failed 0",
      },
    })
  })
})
