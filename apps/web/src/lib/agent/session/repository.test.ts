import { describe, expect, it, vi } from "vitest"
import {
  appendTranscriptEvent,
  consumeAgentMailboxMessage,
  createAgentMailboxMessage,
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
    agentMailboxMessage: {
      create: vi.fn(async ({ data }) => ({ id: "message_1", ...data })),
      updateMany: vi.fn(),
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

  it("preserves automation drafts and opaque approval references through transcript redaction", async () => {
    const db = mockDb()

    const event = await appendTranscriptEvent(db, {
      sessionId: "session_1",
      type: "automation_draft",
      speaker: "Orchestrator",
      body: "Review the automation before saving it.",
      data: {
        draft: {
          name: "Berlin SWE weekdays",
          triggerType: "weekdays",
          cron: "0 8 * * 1-5",
          timezone: "Europe/Berlin",
          targetRoles: ["Software Engineer"],
          targetLocations: ["Berlin"],
          minScore: 85,
          dailyCap: 8,
          requireApproval: true,
          autoApply: false,
        },
        approval: { id: "approval_1", receiptNonce: "nonce_1", scopeHash: "hash_1" },
      },
    }) as { data: unknown }

    expect(event.data).toEqual({
      draft: {
        name: "Berlin SWE weekdays",
        triggerType: "weekdays",
        cron: "0 8 * * 1-5",
        timezone: "Europe/Berlin",
        targetRoles: ["Software Engineer"],
        targetLocations: ["Berlin"],
        minScore: 85,
        dailyCap: 8,
        requireApproval: true,
        autoApply: false,
      },
      approval: { id: "approval_1", receiptNonce: "nonce_1", scopeHash: "hash_1" },
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
        status: "completed",
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
    expect(task).toMatchObject({ status: "completed", confidence: 0.94 })
  })

  it("normalizes the legacy passed status for durable writes", async () => {
    const db = mockDb()

    await completeSubAgentTask(db, { taskId: "task_1", status: "passed" })

    expect(db.subAgentTask.update).toHaveBeenCalledWith({
      where: { id: "task_1" },
      data: expect.objectContaining({ status: "completed" }),
    })
  })

  it("creates mailbox messages with a session-scoped idempotency key", async () => {
    const db = mockDb()

    await createAgentMailboxMessage(db, {
      sessionId: "session_1",
      turnId: "turn_1",
      fromTaskId: "task_1",
      toTaskId: "task_2",
      kind: "task.result",
      payload: { summary: "done" },
      idempotencyKey: "result:task_1:1",
    })

    expect(db.agentMailboxMessage.create).toHaveBeenCalledWith({
      data: {
        sessionId: "session_1",
        turnId: "turn_1",
        fromTaskId: "task_1",
        toTaskId: "task_2",
        kind: "task.result",
        payload: { summary: "done" },
        idempotencyKey: "result:task_1:1",
      },
    })
  })

  it("allows only one concurrent consumer to win the atomic null check", async () => {
    const db = mockDb()
    let consumed = false
    db.agentMailboxMessage.updateMany.mockImplementation(async ({ where }) => {
      if (where.consumedAt === null && !consumed) {
        consumed = true
        return { count: 1 }
      }
      return { count: 0 }
    })

    const results = await Promise.all([
      consumeAgentMailboxMessage(db, { messageId: "message_1", sessionId: "session_1", toTaskId: "task_2", consumedAt: new Date("2026-09-02T00:00:00Z") }),
      consumeAgentMailboxMessage(db, { messageId: "message_1", sessionId: "session_1", toTaskId: "task_2", consumedAt: new Date("2026-09-02T00:00:01Z") }),
    ])

    expect(results.sort()).toEqual([false, true])
    expect(db.agentMailboxMessage.updateMany).toHaveBeenCalledTimes(2)
    expect(db.agentMailboxMessage.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "message_1", sessionId: "session_1", toTaskId: "task_2", consumedAt: null },
    }))
  })
})
