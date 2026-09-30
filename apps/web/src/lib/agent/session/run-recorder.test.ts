import { beforeEach, describe, expect, it, vi } from "vitest"

const dualWriteMocks = vi.hoisted(() => ({ createDualWriteSession: vi.fn() }))
vi.mock("./dual-write", () => ({ createDualWriteSession: dualWriteMocks.createDualWriteSession }))

import { createRunSessionRecorder, mapPipelineEventToTranscript } from "./run-recorder"

interface MockDbOptions {
  sessionExists?: boolean
  sessionStatus?: string
  sessionUserId?: string
  updateCount?: number
  executionUpdateCount?: number
  turnStatus?: string | null
}

function queryText(query: unknown) {
  return typeof query === "object" && query !== null && "strings" in query
    ? ((query as { strings: readonly string[] }).strings ?? []).join(" ")
    : ""
}

function mockDb(options: MockDbOptions = {}) {
  let sessionStatus = options.sessionStatus ?? "running"
  let turnStatus = options.turnStatus === undefined ? "in_progress" : options.turnStatus
  const agentTurnUpdateMany = vi.fn(async ({ where, data }: { where?: { status?: { in?: string[] } }; data: { status?: string } }) => {
    if (where?.status?.in && !where.status.in.includes(turnStatus ?? "")) return { count: 0 }
    if (data.status) turnStatus = data.status
    return { count: 1 }
  })
  let rollbackCount = 0
  const agentSession = {
    create: vi.fn(async ({ data }) => ({ id: "session_1", ...data })),
    update: vi.fn(async ({ data }) => { sessionStatus = data.status ?? sessionStatus; return { id: "session_1", ...data } }),
    findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
      const owned = options.sessionExists !== false && (options.sessionUserId ?? "user_1") === where.userId
      return owned ? { id: where.id, status: sessionStatus } : null
    }),
    updateMany: vi.fn(async () => ({ count: options.updateCount ?? 1 })),
  }
  const agentTranscriptEvent = {
    create: vi.fn(async ({ data }) => ({ id: "event_1", ...data })),
  }
  const subAgentTask = {
    create: vi.fn(async () => ({ id: "task_1", role: "scout", status: "queued" })),
    update: vi.fn(async () => ({ id: "task_1", status: "completed" })),
  }
  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => {
      const sql = queryText(query)
      const owned = options.sessionExists !== false && (options.sessionUserId ?? "user_1") === "user_1"
      if (sql.includes('FROM "agent_sessions"')) {
        const open = !["aborted", "archived"].includes(sessionStatus)
        return owned && open ? [{ id: "session_1" }] : []
      }
      if (sql.includes('FROM "agent_turns"')) {
        return owned && turnStatus ? [{ id: "turn_1", status: turnStatus }] : []
      }
      return []
    }),
    agentSession,
    agentTurn: { updateMany: agentTurnUpdateMany },
    agentTranscriptEvent,
    subAgentTask,
    agentExecution: {
      updateMany: vi.fn(async () => ({ count: options.executionUpdateCount ?? 1 })),
      findFirst: vi.fn(async () => ({ status: "running" })),
    },
  }
  const db = {
    agentSession,
    agentTranscriptEvent,
    subAgentTask,
    $transaction: vi.fn(async <T>(work: (transaction: typeof tx) => Promise<T>) => {
      try {
        return await work(tx)
      } catch (error) {
        rollbackCount += 1
        throw error
      }
    }),
  }
  const state = {
    closeSession() { sessionStatus = "aborted" },
    interruptTurn() { turnStatus = "interrupted" },
    async stopTurn() { return agentTurnUpdateMany({ where: { status: { in: ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] } }, data: { status: "interrupted" } }) },
    get rollbackCount() { return rollbackCount },
  }
  return Object.assign(db, { db, tx, state })
}

describe("run session recorder", () => {
  beforeEach(() => {
    dualWriteMocks.createDualWriteSession.mockReset().mockResolvedValue({
      sessionId: "session_1", userId: "user_1", turnId: "turn_1", record: vi.fn(), finalize: vi.fn().mockResolvedValue(true),
    })
  })

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
    const { tx } = db
    const recorder = await createRunSessionRecorder(db, {
      userId: "user_1",
      goal: "Chat Agent Pipeline Run",
      sessionId: "chat_session_1",
    })

    expect(recorder.sessionId).toBe("chat_session_1")
    expect(db.agentSession.create).not.toHaveBeenCalled()
    expect(db.agentSession.updateMany).toHaveBeenCalledWith({
      where: { id: "chat_session_1", userId: "user_1", status: { notIn: ["aborted", "archived"] } },
      data: { status: "running", completedAt: null },
    })

    await recorder.record("agent_plan", { role: "scout", plan: "Find matching jobs" })
    expect(db.$transaction).toHaveBeenCalled()
    expect(tx.$queryRaw).toHaveBeenCalledBefore(tx.agentTranscriptEvent.create)
    expect(db.agentTranscriptEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ sessionId: "chat_session_1" }),
    })
  })

  it("keeps a deferred manual session paused until its recorder is activated", async () => {
    const db = mockDb()
    const recorder = await createRunSessionRecorder(db, {
      userId: "user_1",
      goal: "Manual deferred pipeline",
      deferActivation: true,
    })

    expect(recorder.sessionId).toBe("session_1")
    expect(db.agentSession.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: "paused" }) })
    expect(db.agentSession.updateMany).not.toHaveBeenCalled()
    await expect(recorder.record("agent_plan", { role: "scout", plan: "Too early" }))
      .rejects.toThrow("must be activated after claiming")

    await recorder.activate()
    expect(db.agentSession.updateMany).toHaveBeenCalledWith({
      where: { id: "session_1", userId: "user_1", status: { notIn: ["aborted", "archived"] } },
      data: { status: "running", completedAt: null },
    })
  })

  it("finalizes a Turn-owned session only while the exact terminal execution still owns the active Turn", async () => {
    const db = mockDb()
    const recorder = await createRunSessionRecorder(db, {
      userId: "user_1",
      goal: "Owned terminal write",
      sessionId: "session_1",
      turnId: "turn_1",
      deferActivation: true,
    })
    await recorder.activate({
      executionAttempt: { id: "execution_1", attemptCount: 3 },
      assertCurrent: async () => true,
    })
    db.tx.$queryRaw.mockClear()
    db.tx.agentExecution.updateMany.mockClear()
    db.agentSession.update.mockClear()

    await expect(recorder.finalize({
      status: "completed",
      report: null,
      owner: {
        turnId: "turn_1",
        executionAttempt: { id: "execution_1", userId: "user_1", attemptCount: 3 },
        terminalStatus: "completed",
      },
    })).resolves.toBe(true)

    const lockSql = db.tx.$queryRaw.mock.calls.map(([query]) => queryText(query))
    expect(lockSql[0]).toContain('FROM "agent_sessions"')
    expect(lockSql[1]).toContain('FROM "agent_turns"')
    expect(db.tx.agentExecution.updateMany).toHaveBeenCalledWith({
      where: { id: "execution_1", userId: "user_1", sessionId: "session_1", attemptCount: 3, status: "completed" },
      data: { updatedAt: expect.any(Date) },
    })
    expect(db.tx.$queryRaw).toHaveBeenCalledBefore(db.tx.agentExecution.updateMany)
    expect(db.tx.agentExecution.updateMany).toHaveBeenCalledBefore(db.agentSession.update)
    expect(db.agentSession.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "session_1" },
      data: expect.objectContaining({ status: "completed" }),
    }))
  })

  it("skips a pending finalization when Stop interrupted the Turn first", async () => {
    const db = mockDb()
    const recorder = await createRunSessionRecorder(db, {
      userId: "user_1",
      goal: "Stop before terminal write",
      sessionId: "session_1",
      turnId: "turn_1",
      deferActivation: true,
    })
    await recorder.activate({
      executionAttempt: { id: "execution_1", attemptCount: 3 },
      assertCurrent: async () => true,
    })
    db.state.interruptTurn()
    db.tx.agentExecution.updateMany.mockClear()
    db.agentSession.update.mockClear()

    await expect(recorder.finalize({
      status: "completed",
      report: null,
      owner: {
        turnId: "turn_1",
        executionAttempt: { id: "execution_1", userId: "user_1", attemptCount: 3 },
        terminalStatus: "completed",
      },
    })).resolves.toBe(false)

    expect(db.tx.agentExecution.updateMany).not.toHaveBeenCalled()
    expect(db.agentSession.update).not.toHaveBeenCalled()
  })

  it("atomically terminalizes an implicit V2 Turn and its session before a later Stop", async () => {
    const db = mockDb()
    const recorder = await createRunSessionRecorder(db, {
      userId: "user_1",
      goal: "Implicit dual-write terminal",
      sessionId: "session_1",
      dualWrite: true,
      deferActivation: true,
    })
    await recorder.activate({ executionAttempt: { id: "execution_1", attemptCount: 5 }, assertCurrent: async () => true })
    expect(recorder.getTurnId()).toBe("turn_1")
    db.tx.$queryRaw.mockClear()
    db.tx.agentExecution.updateMany.mockClear()
    db.tx.agentTurn.updateMany.mockClear()
    db.agentSession.update.mockClear()

    await expect(recorder.finalize({
      status: "completed",
      report: null,
      owner: { turnId: "turn_1", executionAttempt: { id: "execution_1", userId: "user_1", attemptCount: 5 }, terminalStatus: "completed" },
    })).resolves.toBe(true)

    const lockSql = db.tx.$queryRaw.mock.calls.map(([query]) => queryText(query))
    expect(lockSql[0]).toContain('FROM "agent_sessions"')
    expect(lockSql[1]).toContain('FROM "agent_turns"')
    expect(db.tx.agentExecution.updateMany).toHaveBeenCalledBefore(db.tx.agentTurn.updateMany)
    expect(db.tx.agentTurn.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "turn_1", sessionId: "session_1", status: { in: expect.any(Array) } }),
      data: expect.objectContaining({ status: "completed" }),
    }))
    expect(db.tx.agentTurn.updateMany).toHaveBeenCalledBefore(db.agentSession.update)
    await expect(db.state.stopTurn()).resolves.toEqual({ count: 0 })
    expect(db.agentSession.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "completed" }) }))
  })

  it("rejects a legacy transcript after the existing session closes", async () => {
    const { db, tx, state } = mockDb()
    const recorder = await createRunSessionRecorder(db, {
      userId: "user_1",
      goal: "Close before record",
      sessionId: "chat_session_1",
    })
    state.closeSession()

    await expect(recorder.record("agent_plan", { role: "scout", plan: "Late plan" }))
      .rejects.toThrow("does not exist for this user")
    expect(tx.agentTranscriptEvent.create).not.toHaveBeenCalled()
    expect(db.agentSession.update).not.toHaveBeenCalled()
    expect(state.rollbackCount).toBe(1)
  })

  it("rejects role_start after close before creating a task or current-task update", async () => {
    const { db, tx, state } = mockDb()
    const recorder = await createRunSessionRecorder(db, {
      userId: "user_1",
      goal: "Close before role",
      sessionId: "chat_session_1",
    })
    state.closeSession()

    await expect(recorder.record("role_start", { role: "scout", plan: "Late role" }))
      .rejects.toThrow("does not exist for this user")
    expect(tx.subAgentTask.create).not.toHaveBeenCalled()
    expect(db.agentSession.update).not.toHaveBeenCalled()
    expect(tx.agentTranscriptEvent.create).not.toHaveBeenCalled()
    expect(state.rollbackCount).toBe(1)
  })

  it("rejects role_done after close before completing its task", async () => {
    const { db, tx, state } = mockDb()
    const recorder = await createRunSessionRecorder(db, {
      userId: "user_1",
      goal: "Close before role done",
      sessionId: "chat_session_1",
    })
    await recorder.record("role_start", { role: "scout", plan: "Start role" })
    tx.subAgentTask.update.mockClear()
    tx.agentTranscriptEvent.create.mockClear()
    state.closeSession()

    await expect(recorder.record("role_done", { role: "scout", summary: "Late role" }))
      .rejects.toThrow("does not exist for this user")
    expect(tx.subAgentTask.update).not.toHaveBeenCalled()
    expect(tx.agentTranscriptEvent.create).not.toHaveBeenCalled()
    expect(state.rollbackCount).toBe(1)
  })

  it.each(["paused", "waiting_for_user"])("reopens an existing %s session", async (sessionStatus) => {
    const db = mockDb({ sessionStatus })

    await expect(createRunSessionRecorder(db, {
      userId: "user_1",
      goal: "Resume pipeline",
      sessionId: "chat_session_1",
    })).resolves.toMatchObject({ sessionId: "chat_session_1" })
    expect(db.agentSession.updateMany).toHaveBeenCalled()
  })

  it.each(["aborted", "archived"])("does not reopen a %s session", async (sessionStatus) => {
    const db = mockDb({ sessionStatus })

    await expect(createRunSessionRecorder(db, {
      userId: "user_1",
      goal: "Closed pipeline",
      sessionId: "chat_session_1",
    })).rejects.toThrow("does not exist for this user")
    expect(db.agentSession.updateMany).not.toHaveBeenCalled()
    expect(db.agentSession.update).not.toHaveBeenCalled()
    expect(db.agentTranscriptEvent.create).not.toHaveBeenCalled()
  })

  it.each([
    ["missing", { sessionExists: false }],
    ["cross-user", { sessionUserId: "another_user" }],
  ] as const)("rejects a %s existing session before writes", async (_label, options) => {
    const db = mockDb(options)

    await expect(createRunSessionRecorder(db, {
      userId: "user_1",
      goal: "Unauthorized pipeline",
      sessionId: "chat_session_1",
    })).rejects.toThrow("does not exist for this user")
    expect(db.agentSession.updateMany).not.toHaveBeenCalled()
    expect(db.agentSession.update).not.toHaveBeenCalled()
    expect(db.agentTranscriptEvent.create).not.toHaveBeenCalled()
  })

  it("fails closed when the session closes before the running update", async () => {
    const db = mockDb({ updateCount: 0 })

    await expect(createRunSessionRecorder(db, {
      userId: "user_1",
      goal: "Close race",
      sessionId: "chat_session_1",
    })).rejects.toThrow("does not exist for this user")
    expect(db.agentSession.updateMany).toHaveBeenCalled()
    expect(db.agentTranscriptEvent.create).not.toHaveBeenCalled()
  })

  it("rejects finalize after close without overwriting the closed session", async () => {
    const { db, state } = mockDb()
    const recorder = await createRunSessionRecorder(db, {
      userId: "user_1",
      goal: "Close before finalize",
      sessionId: "chat_session_1",
    })
    state.closeSession()

    await expect(recorder.finalize({ status: "completed", report: null }))
      .rejects.toThrow("does not exist for this user")
    expect(db.agentSession.update).not.toHaveBeenCalled()
    expect(state.rollbackCount).toBe(1)
  })

  it("rejects pause after close before completing a role task or updating the session", async () => {
    const { db, tx, state } = mockDb()
    const recorder = await createRunSessionRecorder(db, {
      userId: "user_1",
      goal: "Close before pause",
      sessionId: "chat_session_1",
    })
    await recorder.record("role_start", { role: "scout", plan: "Start role" })
    tx.subAgentTask.update.mockClear()
    db.agentSession.update.mockClear()
    state.closeSession()

    await expect(recorder.pause("Late pause", "scout"))
      .rejects.toThrow("does not exist for this user")
    expect(tx.subAgentTask.update).not.toHaveBeenCalled()
    expect(db.agentSession.update).not.toHaveBeenCalled()
    expect(state.rollbackCount).toBe(1)
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

    expect(mapPipelineEventToTranscript("application_queued", { company: "N26", role: "Software Engineer" })).toMatchObject({
      type: "application_queued",
      speaker: "Executor",
      title: "Unattended submission queued",
      body: "N26 · Software Engineer is queued for background submission.",
    })

    expect(mapPipelineEventToTranscript("artifact_created", { role: "writer", artifact: { artifactId: "resume-1", artifactType: "resume", version: 2, hash: "sha256:1234567890123456" } })).toMatchObject({
      type: "quality_gate",
      speaker: "Writer",
      body: expect.stringContaining("resume resume-1 v2"),
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
    const { tx } = db
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
        status: "completed",
        result: { role: "scout", summary: "42 jobs queued", count: 42, durationMs: 1200 },
        confidence: 1,
        failureReason: null,
      }),
    })
    expect(tx.$queryRaw).toHaveBeenCalledBefore(tx.subAgentTask.create)
    expect(tx.$queryRaw).toHaveBeenCalledBefore(tx.subAgentTask.update)
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

  it("binds stage tasks to the exact Turn and refuses an old role_done after Stop", async () => {
    const db = mockDb()
    const dualRecord = vi.fn().mockResolvedValue({})
    dualWriteMocks.createDualWriteSession.mockResolvedValueOnce({
      sessionId: "session_1", userId: "user_1", turnId: "turn_1", record: dualRecord, finalize: vi.fn().mockResolvedValue(true),
    })
    const recorder = await createRunSessionRecorder(db, {
      userId: "user_1", goal: "Owned stage task", sessionId: "session_1",
      turnId: "turn_1", dualWrite: true, deferActivation: true,
    })
    await recorder.activate({
      executionAttempt: { id: "execution_1", attemptCount: 7 },
      assertCurrent: async () => true,
    })

    await recorder.record("role_start", { role: "scout", plan: "Find jobs" })
    expect(db.subAgentTask.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ sessionId: "session_1", turnId: "turn_1", role: "scout" }),
    })
    expect(dualRecord).toHaveBeenCalledTimes(1)

    await db.state.stopTurn()
    db.tx.subAgentTask.update.mockClear()
    await expect(recorder.record("role_done", { role: "scout", summary: "Late result" })).rejects.toThrow()

    expect(db.tx.subAgentTask.update).not.toHaveBeenCalled()
    expect(dualRecord).toHaveBeenCalledTimes(1)
  })

  it("persists a legacy agent question as non-approval content behind the ownership fence", async () => {
    const db = mockDb()
    const dualRecord = vi.fn().mockResolvedValue({})
    dualWriteMocks.createDualWriteSession.mockResolvedValueOnce({
      sessionId: "session_1", userId: "user_1", turnId: "turn_1", record: dualRecord, finalize: vi.fn().mockResolvedValue(true),
    })
    const recorder = await createRunSessionRecorder(db, {
      userId: "user_1", goal: "Legacy question", sessionId: "session_1", ensureTurn: true, deferActivation: true,
    })
    await recorder.activate({
      executionAttempt: { id: "execution_1", attemptCount: 8 },
      assertCurrent: async () => true,
    })
    db.tx.$queryRaw.mockClear()
    db.tx.agentExecution.updateMany.mockClear()

    await expect(recorder.record("agent_question", { role: "analyst", questionId: "question_1", question: "Continue?" })).resolves.toMatchObject({
      type: "subagent_result", title: "Question", body: "Continue?",
    })

    expect(db.tx.$queryRaw.mock.calls.map(([query]) => queryText(query)))
      .toEqual(expect.arrayContaining([expect.stringContaining('FROM "agent_turns"')]))
    expect(db.tx.agentExecution.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "execution_1", userId: "user_1", sessionId: "session_1", attemptCount: 8 }),
    }))
    expect(dualRecord).not.toHaveBeenCalled()
    expect(db.agentTranscriptEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "subagent_result", title: "Question", body: "Continue?" }),
    })
    expect(db.agentTranscriptEvent.create).not.toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "approval_request" }),
    })
  })

  it("persists otherwise unmapped legacy events before allowing their SSE publication", async () => {
    const db = mockDb()
    const recorder = await createRunSessionRecorder(db, {
      userId: "user_1", goal: "Generic legacy event", sessionId: "session_1", ensureTurn: true, deferActivation: true,
    })
    await recorder.activate({ executionAttempt: { id: "execution_1", attemptCount: 9 }, assertCurrent: async () => true })

    await expect(recorder.record("job_skip", { message: "Below threshold" })).resolves.toMatchObject({
      type: "subagent_result", title: "job skip", body: "Below threshold",
    })

    expect(db.agentTranscriptEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "subagent_result", title: "job skip", body: "Below threshold" }),
    })
    expect(db.tx.agentExecution.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "execution_1",
        userId: "user_1",
        sessionId: "session_1",
        attemptCount: 9,
        status: { in: expect.any(Array) },
      }),
    }))
  })

  it("finalizes the session with completed status and quality score", async () => {
    const db = mockDb()
    const recorder = await createRunSessionRecorder(db, {
      userId: "user_1",
      goal: "Manual Agent Pipeline Run",
    })

    await recorder.finalize({
      status: "completed",
      report: { processed: 10, applied: 4, queued: 0, pending: 2, skipped: 4, failed: 0, durationMs: 120000 },
    })

    expect(db.agentSession.update).toHaveBeenCalledWith({
      where: { id: "session_1" },
      data: {
        status: "completed",
        completedAt: expect.any(Date),
        qualityScore: 100,
        memorySummary: "Processed 10 jobs · dispatched 0 · confirmed 4 · pending 2 · skipped 4 · failed 0",
      },
    })
    expect(db.$transaction).toHaveBeenCalled()
    expect(db.tx.$queryRaw).toHaveBeenCalledBefore(db.agentSession.update)
  })
})
