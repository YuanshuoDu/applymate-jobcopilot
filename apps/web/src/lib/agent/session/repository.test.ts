import { describe, expect, it, vi } from "vitest"
import {
  appendTranscriptEvent,
  consumeAgentMailboxMessage,
  createAgentMailboxMessage,
  createAgentSession,
  createSubAgentTask,
  completeSubAgentTask,
} from "./repository"
import { AgentSessionIdempotencyConflictError } from "./agent-session-create-idempotency"

function mockDb(consent = { enabled: false, version: 0 }) {
  const db = {
    $queryRaw: vi.fn(async () => []),
    user: { findUnique: vi.fn(async () => ({
      agentSearchFootprintMemoryEnabled: consent.enabled, agentSearchFootprintMemoryConsentVersion: consent.version,
    })) },
    $transaction: vi.fn(),
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
      createMany: vi.fn(async (_args: { data: Record<string, unknown>; skipDuplicates: true }) => ({ count: 1 })),
      findUnique: vi.fn(async (): Promise<unknown> => null),
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
  db.$transaction.mockImplementation(async (work: (tx: never) => unknown) => work(db as never))
  return db
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
        searchFootprintMemoryEnabledAtCreation: false,
        searchFootprintMemoryConsentVersionAtCreation: 0,
      },
    })
    expect(db.$transaction).toHaveBeenCalledOnce()
    expect(db.$queryRaw).toHaveBeenCalledOnce()
    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { id: "user_1" }, select: {
      agentSearchFootprintMemoryEnabled: true, agentSearchFootprintMemoryConsentVersion: true,
    } })
    expect(db.agentSession.createMany).not.toHaveBeenCalled()
  })

  it("atomically inserts or returns the same user's session for a stable key", async () => {
    const db = mockDb()
    const existing = { id: "session_existing", creationIdempotencyRequestHash: "" }
    db.agentSession.createMany.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => {
      existing.creationIdempotencyRequestHash = String(data.creationIdempotencyRequestHash)
      return { count: 0 }
    })
    db.agentSession.findUnique.mockResolvedValueOnce(existing)

    const session = await createAgentSession(db, {
      userId: "user_1",
      goal: "  Apply to Berlin SWE roles  ",
      source: "chat",
      idempotencyKey: "attempt-1",
    })

    expect(session).toBe(existing)
    expect(db.agentSession.createMany).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user_1",
        goal: "Apply to Berlin SWE roles",
        creationIdempotencyKey: "attempt-1",
        creationIdempotencyRequestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      skipDuplicates: true,
    })
    expect(db.agentSession.findUnique).toHaveBeenCalledWith({
      where: { userId_creationIdempotencyKey: { userId: "user_1", creationIdempotencyKey: "attempt-1" } },
    })
    expect(db.agentSession.create).not.toHaveBeenCalled()
    expect(db.$queryRaw).toHaveBeenCalledOnce()
  })

  it("fails closed when a stored key belongs to a different normalized request", async () => {
    const db = mockDb()
    db.agentSession.createMany.mockResolvedValueOnce({ count: 0 })
    db.agentSession.findUnique.mockResolvedValueOnce({ creationIdempotencyRequestHash: "another-request" })

    await expect(createAgentSession(db, {
      userId: "user_1",
      goal: "Apply to Berlin SWE roles",
      source: "chat",
      idempotencyKey: "attempt-1",
    })).rejects.toBeInstanceOf(AgentSessionIdempotencyConflictError)
    expect(db.$queryRaw).toHaveBeenCalledOnce()
  })

  it("inserts a keyed session with the captured consent snapshot under the same transaction", async () => {
    const db = mockDb({ enabled: true, version: 7 })
    const existing = { id: "session_keyed", creationIdempotencyRequestHash: "" }
    db.agentSession.createMany.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(existing, data)
      return { count: 1 }
    })
    db.agentSession.findUnique.mockResolvedValueOnce(existing)

    const session = await createAgentSession(db, {
      userId: "user_1",
      goal: "Apply to Berlin SWE roles",
      source: "chat",
      idempotencyKey: "attempt-snapshot",
    })

    expect(session).toMatchObject({
      creationIdempotencyKey: "attempt-snapshot",
      searchFootprintMemoryEnabledAtCreation: true,
      searchFootprintMemoryConsentVersionAtCreation: 7,
    })
    expect(db.$transaction).toHaveBeenCalledOnce()
    expect(db.$queryRaw).toHaveBeenCalledOnce()
    expect(db.agentSession.createMany).toHaveBeenCalledWith({
      data: expect.objectContaining({
        creationIdempotencyKey: "attempt-snapshot",
        searchFootprintMemoryEnabledAtCreation: true,
        searchFootprintMemoryConsentVersionAtCreation: 7,
      }),
      skipDuplicates: true,
    })
    expect(db.agentSession.findUnique).toHaveBeenCalledOnce()
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
