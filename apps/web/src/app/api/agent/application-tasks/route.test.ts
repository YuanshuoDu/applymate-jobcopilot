import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  queryRaw: vi.fn(),
  taskUpdate: vi.fn(),
  approvalUpdateMany: vi.fn(),
  eventCreate: vi.fn(),
  fillerFindMany: vi.fn(),
  transaction: vi.fn(),
  queueApplicationFill: vi.fn(),
  applicationFillTaskGraphEnabled: vi.fn(),
  taskInterrupt: vi.fn(),
}))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

vi.mock("@/lib/db", () => ({
  db: {
    applicationTask: { findMany: mocks.findMany, findFirst: mocks.findFirst, updateMany: mocks.updateMany, update: mocks.taskUpdate },
    subAgentTask: { findMany: mocks.fillerFindMany },
    agentApproval: { updateMany: mocks.approvalUpdateMany },
    applicationTaskEvent: { create: mocks.eventCreate },
    $transaction: mocks.transaction,
  },
}))

vi.mock("@/lib/auto-apply", () => ({
  applicationFillTaskGraphEnabled: mocks.applicationFillTaskGraphEnabled,
  queueApplicationFill: mocks.queueApplicationFill,
}))

vi.mock("@/lib/agent/control-plane/commands/task-interrupt-service", () => ({
  TaskInterruptError: class TaskInterruptError extends Error {},
  TaskInterruptService: class TaskInterruptService {
    interrupt = mocks.taskInterrupt
  },
}))

function retryReadinessTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task_1", status: "cancelled", checkpoint: "turn_stopped_before_submit", fillTurnId: "turn_1",
    fillTurn: { id: "turn_1", status: "cancelled", leaseOwnerId: null, leaseExpiresAt: null, subAgentTasks: [
      { role: "application_filler", taskType: "application_fill_for_review", status: "completed", leaseOwner: null, leaseExpiresAt: null },
    ] },
    ...overrides,
  }
}

describe("GET /api/agent/application-tasks retry readiness projection", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.findMany.mockResolvedValue([retryReadinessTask()])
  })

  async function getReadiness() {
    const { GET } = await import("./route")
    return GET(new Request("http://localhost/api/agent/application-tasks?projection=cancelled-fill-retry&sessionId=session_1") as never)
  }

  it("returns only the scoped projection and disables caching", async () => {
    const response = await getReadiness()

    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("no-store, private")
    await expect(response.json()).resolves.toEqual({ tasks: [{ id: "task_1", cancelledFillRetryReady: true }] })
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      userId: "user_1", sessionId: "session_1", fillTurnSessionId: "session_1", fillTurnUserId: "user_1", fillTurnId: { not: null },
    }) }))
  })

  it("does not mark a retry ready while its bound Turn is active", async () => {
    mocks.findMany.mockResolvedValueOnce([retryReadinessTask({ fillTurn: { ...retryReadinessTask().fillTurn, status: "running" } })])

    await expect((await getReadiness()).json()).resolves.toEqual({ tasks: [{ id: "task_1", cancelledFillRetryReady: false }] })
  })

  it.each([
    ["active", { status: "running", leaseOwner: null, leaseExpiresAt: null }],
    ["leased", { status: "completed", leaseOwner: "worker_1", leaseExpiresAt: new Date("2026-10-16T12:00:00Z") }],
    ["ambiguous", { status: "completed", leaseOwner: null, leaseExpiresAt: null }, true],
  ])("does not mark an %s filler ready", async (_state, filler, duplicate = false) => {
    const fillers = [
      { role: "application_filler", taskType: "application_fill_for_review", ...filler },
      ...(duplicate ? [{ role: "application_filler", taskType: "application_fill_for_review", ...filler }] : []),
    ]
    mocks.findMany.mockResolvedValueOnce([retryReadinessTask({ fillTurn: { ...retryReadinessTask().fillTurn, subAgentTasks: fillers } })])

    await expect((await getReadiness()).json()).resolves.toEqual({ tasks: [{ id: "task_1", cancelledFillRetryReady: false }] })
  })
})

describe("DELETE /api/agent/application-tasks", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.applicationFillTaskGraphEnabled.mockReturnValue(false)
    mocks.findFirst.mockResolvedValue({ id: "task_1", sessionId: "session_1", fillTurnId: null, fillTurnSessionId: null, fillTurnUserId: null, status: "waiting_for_authorization", checkpoint: "form_filled" })
    mocks.fillerFindMany.mockResolvedValue([])
    mocks.updateMany.mockResolvedValue({ count: 1 })
    mocks.queryRaw.mockResolvedValue([{ id: "task_1" }])
    mocks.approvalUpdateMany.mockResolvedValue({ count: 1 })
    mocks.eventCreate.mockResolvedValue({ id: "event_1" })
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      applicationTask: { updateMany: mocks.updateMany, update: mocks.taskUpdate },
      $queryRaw: mocks.queryRaw,
      applicationTaskEvent: { create: mocks.eventCreate },
      agentApproval: { updateMany: mocks.approvalUpdateMany },
    }))
  })

  it("revokes a pending final-submission authorization with the cancelled task", async () => {
    const { DELETE } = await import("./route")
    const request = new Request("http://localhost/api/agent/application-tasks?id=task_1", { method: "DELETE" })

    const response = await DELETE(request as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ cancelled: true })
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "task_1",
        userId: "user_1",
        status: { notIn: ["submitted", "skipped", "cancelled"] },
        OR: [{ checkpoint: null }, { checkpoint: { notIn: ["submission_request_started", "submission_uncertain"] } }],
      }),
      data: expect.objectContaining({ status: "cancelled", checkpoint: "cancelled_by_user" }),
    }))
    expect(mocks.approvalUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        sessionId: "session_1",
        userId: "user_1",
        type: "submit_application",
        status: "pending",
        payload: { path: ["applicationTaskId"], equals: "task_1" },
      }),
      data: expect.objectContaining({ status: "cancelled" }),
    }))
  })

  it("does not mutate an already screened-out task", async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: "task_1", sessionId: "session_1", status: "skipped", checkpoint: "screened_out" })
    const { DELETE } = await import("./route")
    const request = new Request("http://localhost/api/agent/application-tasks?id=task_1", { method: "DELETE" })

    const response = await DELETE(request as never)

    expect(response.status).toBe(409)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it("conflicts if the worker marks submission started after the user's initial read", async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: "task_1", sessionId: "session_1", status: "filling", checkpoint: "browser_active" })
    mocks.updateMany.mockResolvedValueOnce({ count: 0 })
    const { DELETE } = await import("./route")
    const request = new Request("http://localhost/api/agent/application-tasks?id=task_1", { method: "DELETE" })

    const response = await DELETE(request as never)

    expect(response.status).toBe(409)
    expect(mocks.updateMany).toHaveBeenCalledOnce()
    expect(mocks.eventCreate).not.toHaveBeenCalled()
    expect(mocks.approvalUpdateMany).not.toHaveBeenCalled()
  })

  it("rejects a task already at the submission-start checkpoint", async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: "task_1", sessionId: "session_1", status: "filling", checkpoint: "submission_request_started" })
    const { DELETE } = await import("./route")
    const request = new Request("http://localhost/api/agent/application-tasks?id=task_1", { method: "DELETE" })

    const response = await DELETE(request as never)

    expect(response.status).toBe(409)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it("rejects an application with an uncertain submission outcome", async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: "task_1", sessionId: "session_1", status: "waiting_for_user", checkpoint: "submission_uncertain" })
    const { DELETE } = await import("./route")
    const request = new Request("http://localhost/api/agent/application-tasks?id=task_1", { method: "DELETE" })

    const response = await DELETE(request as never)

    expect(response.status).toBe(409)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it("replays cancellation for the same stopped TaskGraph fill and cleans pending approvals", async () => {
    mocks.findFirst.mockResolvedValueOnce({
      id: "task_1", sessionId: "session_1", status: "cancelled", checkpoint: "turn_stopped_before_submit",
      fillTurnId: "turn_fill_1", fillTurnSessionId: "session_1", fillTurnUserId: "user_1",
    })
    const { DELETE } = await import("./route")
    const response = await DELETE(new Request("http://localhost/api/agent/application-tasks?id=task_1", { method: "DELETE" }) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ cancelled: true })
    expect(mocks.transaction).toHaveBeenCalledOnce()
    expect(mocks.approvalUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sessionId: "session_1", userId: "user_1", status: "pending" }),
    }))
    expect(mocks.eventCreate).not.toHaveBeenCalled()
    expect(mocks.queryRaw).toHaveBeenCalledOnce()
    expect(mocks.queryRaw).toHaveBeenCalledWith(expect.objectContaining({
      sql: expect.stringContaining("FOR UPDATE"),
      values: ["task_1", "user_1", "session_1", "turn_fill_1", "session_1", "user_1", "cancelled", "turn_stopped_before_submit"],
    }))
    expect(mocks.updateMany).not.toHaveBeenCalled()
    expect(mocks.taskInterrupt).not.toHaveBeenCalled()
  })

  it("conflicts and leaves approvals pending if the stopped-fill binding changes before replay", async () => {
    const currentTask = {
      id: "task_1", userId: "user_1", sessionId: "session_1", fillTurnId: "turn_fill_2",
      fillTurnSessionId: "session_1", fillTurnUserId: "user_1", status: "filling", checkpoint: "browser_active",
    }
    mocks.findFirst.mockResolvedValueOnce({
      id: "task_1", sessionId: "session_1", status: "cancelled", checkpoint: "turn_stopped_before_submit",
      fillTurnId: "turn_fill_1", fillTurnSessionId: "session_1", fillTurnUserId: "user_1",
    })
    mocks.queryRaw.mockImplementationOnce(async (query: { values: unknown[] }) => {
      const [id, userId, sessionId, fillTurnId, fillTurnSessionId, fillTurnUserId, status, checkpoint] = query.values
      const matchesCurrentTask = id === currentTask.id && userId === currentTask.userId
        && sessionId === currentTask.sessionId && fillTurnId === currentTask.fillTurnId
        && fillTurnSessionId === currentTask.fillTurnSessionId && fillTurnUserId === currentTask.fillTurnUserId
        && status === currentTask.status && checkpoint === currentTask.checkpoint
      return matchesCurrentTask ? [{ id: currentTask.id }] : []
    })
    const { DELETE } = await import("./route")
    const response = await DELETE(new Request("http://localhost/api/agent/application-tasks?id=task_1", { method: "DELETE" }) as never)

    expect(response.status).toBe(409)
    expect(mocks.transaction).toHaveBeenCalledOnce()
    expect(mocks.queryRaw).toHaveBeenCalledWith(expect.objectContaining({
      sql: expect.stringContaining("FOR UPDATE"),
      values: ["task_1", "user_1", "session_1", "turn_fill_1", "session_1", "user_1", "cancelled", "turn_stopped_before_submit"],
    }))
    expect(mocks.approvalUpdateMany).not.toHaveBeenCalled()
    expect(mocks.eventCreate).not.toHaveBeenCalled()
  })

  it.each([
    { label: "a foreign Turn binding", task: { fillTurnId: "turn_fill_1", fillTurnSessionId: "session_other", fillTurnUserId: "user_1", checkpoint: "turn_stopped_before_submit" } },
    { label: "another cancellation reason", task: { fillTurnId: "turn_fill_1", fillTurnSessionId: "session_1", fillTurnUserId: "user_1", checkpoint: "cancelled_by_user" } },
    { label: "a legacy cancelled task", task: { fillTurnId: null, fillTurnSessionId: null, fillTurnUserId: null, checkpoint: "cancelled_by_user" } },
  ])("keeps $label as a conflict", async ({ task }) => {
    mocks.findFirst.mockResolvedValueOnce({ id: "task_1", sessionId: "session_1", status: "cancelled", ...task })
    const { DELETE } = await import("./route")
    const response = await DELETE(new Request("http://localhost/api/agent/application-tasks?id=task_1", { method: "DELETE" }) as never)

    expect(response.status).toBe(409)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it("accepts the exact-bound Worker cancellation if its acknowledgement wins the route update race", async () => {
    mocks.applicationFillTaskGraphEnabled.mockReturnValue(true)
    mocks.findFirst.mockResolvedValueOnce({
      id: "task_1", sessionId: "session_1", status: "filling", checkpoint: "browser_active",
      fillTurnId: "turn_fill_1", fillTurnSessionId: "session_1", fillTurnUserId: "user_1",
    })
    mocks.fillerFindMany.mockResolvedValue([{ id: "filler_1", status: "running" }])
    mocks.taskInterrupt.mockResolvedValue({ disposition: "accepted" })
    mocks.updateMany.mockResolvedValueOnce({ count: 0 })
    const { DELETE } = await import("./route")
    const response = await DELETE(new Request("http://localhost/api/agent/application-tasks?id=task_1", { method: "DELETE" }) as never)

    expect(response.status).toBe(200)
    expect(mocks.queryRaw).toHaveBeenCalledWith(expect.objectContaining({
      sql: expect.stringContaining("FOR UPDATE"),
      values: ["task_1", "user_1", "session_1", "turn_fill_1", "session_1", "user_1", "cancelled", "turn_stopped_before_submit"],
    }))
    expect(mocks.eventCreate).not.toHaveBeenCalled()
    expect(mocks.approvalUpdateMany).toHaveBeenCalledOnce()
    expect(mocks.taskInterrupt).toHaveBeenCalledTimes(2)
  })

  it.each(["a changed Turn binding", "another cancellation reason"])("still conflicts after an update race with %s", async () => {
    mocks.applicationFillTaskGraphEnabled.mockReturnValue(true)
    mocks.findFirst.mockResolvedValueOnce({
      id: "task_1", sessionId: "session_1", status: "filling", checkpoint: "browser_active",
      fillTurnId: "turn_fill_1", fillTurnSessionId: "session_1", fillTurnUserId: "user_1",
    })
    mocks.fillerFindMany.mockResolvedValue([{ id: "filler_1", status: "running" }])
    mocks.taskInterrupt.mockResolvedValue({ disposition: "accepted" })
    mocks.updateMany.mockResolvedValueOnce({ count: 0 })
    mocks.queryRaw.mockResolvedValueOnce([])
    const { DELETE } = await import("./route")
    const response = await DELETE(new Request("http://localhost/api/agent/application-tasks?id=task_1", { method: "DELETE" }) as never)

    expect(response.status).toBe(409)
    expect(mocks.queryRaw).toHaveBeenCalledWith(expect.objectContaining({
      sql: expect.stringContaining("FOR UPDATE"),
      values: ["task_1", "user_1", "session_1", "turn_fill_1", "session_1", "user_1", "cancelled", "turn_stopped_before_submit"],
    }))
    expect(mocks.eventCreate).not.toHaveBeenCalled()
    expect(mocks.approvalUpdateMany).not.toHaveBeenCalled()
  })

  it("persists an exact-bound filler interrupt before cancelling an active TaskGraph fill", async () => {
    mocks.applicationFillTaskGraphEnabled.mockReturnValue(true)
    mocks.findFirst.mockResolvedValueOnce({
      id: "task_1", sessionId: "session_1", status: "filling", checkpoint: "browser_active",
      fillTurnId: "turn_fill_1", fillTurnSessionId: "session_1", fillTurnUserId: "user_1",
    })
    mocks.fillerFindMany.mockResolvedValue([{ id: "filler_1", status: "running" }])
    mocks.taskInterrupt.mockResolvedValue({ disposition: "accepted" })
    const { DELETE } = await import("./route")
    const request = new Request("http://localhost/api/agent/application-tasks?id=task_1", { method: "DELETE" })

    const response = await DELETE(request as never)

    expect(response.status).toBe(200)
    expect(mocks.taskInterrupt).toHaveBeenNthCalledWith(1, {
      sessionId: "session_1", taskId: "filler_1", userId: "user_1",
      clientMessageId: "application-task-cancel:task_1:turn_fill_1",
    })
    expect(mocks.taskInterrupt).toHaveBeenNthCalledWith(2, {
      sessionId: "session_1", taskId: "filler_1", userId: "user_1",
      clientMessageId: "application-task-cancel:task_1:turn_fill_1",
    })
    expect(mocks.taskInterrupt).toHaveBeenCalledTimes(2)
    expect(mocks.taskInterrupt.mock.invocationCallOrder[0]).toBeLessThan(mocks.transaction.mock.invocationCallOrder[0]!)
    expect(mocks.transaction.mock.invocationCallOrder[0]).toBeLessThan(mocks.taskInterrupt.mock.invocationCallOrder[1]!)
  })

  it("interrupts a durably bound TaskGraph fill after new fills are disabled", async () => {
    mocks.applicationFillTaskGraphEnabled.mockReturnValue(false)
    mocks.findFirst.mockResolvedValueOnce({
      id: "task_1", sessionId: "session_1", status: "filling", checkpoint: "browser_active",
      fillTurnId: "turn_fill_1", fillTurnSessionId: "session_1", fillTurnUserId: "user_1",
    })
    mocks.fillerFindMany.mockResolvedValue([{ id: "filler_1", status: "running" }])
    mocks.taskInterrupt.mockResolvedValue({ disposition: "accepted" })
    const { DELETE } = await import("./route")
    const request = new Request("http://localhost/api/agent/application-tasks?id=task_1", { method: "DELETE" })

    const response = await DELETE(request as never)

    expect(response.status).toBe(200)
    expect(mocks.taskInterrupt).toHaveBeenCalledTimes(2)
    expect(mocks.taskInterrupt).toHaveBeenCalledWith(expect.objectContaining({ taskId: "filler_1" }))
  })

  it("conflicts if answer-resume rebinds the task after the old filler interrupt", async () => {
    let currentTaskBinding = { fillTurnId: "turn_old", fillTurnSessionId: "session_1", fillTurnUserId: "user_1" }
    mocks.applicationFillTaskGraphEnabled.mockReturnValue(true)
    mocks.findFirst.mockResolvedValueOnce({
      id: "task_1", sessionId: "session_1", status: "waiting_for_user", checkpoint: "form_answer_required",
      fillTurnId: "turn_old", fillTurnSessionId: "session_1", fillTurnUserId: "user_1",
    })
    mocks.fillerFindMany.mockResolvedValueOnce([{ id: "filler_old", status: "waiting_for_user" }])
    mocks.taskInterrupt.mockImplementationOnce(async () => {
      currentTaskBinding = { ...currentTaskBinding, fillTurnId: "turn_new" }
      return { disposition: "accepted" }
    })
    mocks.queryRaw.mockResolvedValueOnce([])
    mocks.updateMany.mockImplementation(async (args: { where: { fillTurnId?: string | null; fillTurnSessionId?: string | null; fillTurnUserId?: string | null } }) => ({
      count: (["fillTurnId", "fillTurnSessionId", "fillTurnUserId"] as const).every(key =>
        args.where[key] === undefined || args.where[key] === currentTaskBinding[key],
      ) ? 1 : 0,
    }))
    const { DELETE } = await import("./route")
    const request = new Request("http://localhost/api/agent/application-tasks?id=task_1", { method: "DELETE" })

    const response = await DELETE(request as never)

    expect(response.status).toBe(409)
    expect(currentTaskBinding.fillTurnId).toBe("turn_new")
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "task_1", userId: "user_1", sessionId: "session_1",
        fillTurnId: "turn_old", fillTurnSessionId: "session_1", fillTurnUserId: "user_1",
      }),
    }))
    expect(mocks.updateMany).toHaveBeenCalledOnce()
    expect(mocks.queryRaw).toHaveBeenCalledWith(expect.objectContaining({
      sql: expect.stringContaining("FOR UPDATE"),
      values: ["task_1", "user_1", "session_1", "turn_old", "session_1", "user_1", "cancelled", "turn_stopped_before_submit"],
    }))
    expect(mocks.taskInterrupt).toHaveBeenCalledOnce()
    expect(mocks.eventCreate).not.toHaveBeenCalled()
    expect(mocks.approvalUpdateMany).not.toHaveBeenCalled()
  })

  it("allows cancellation before filler admission and interrupts a filler found after commit", async () => {
    mocks.applicationFillTaskGraphEnabled.mockReturnValue(true)
    mocks.findFirst.mockResolvedValueOnce({
      id: "task_1", sessionId: "session_1", status: "filling", checkpoint: "taskgraph_fill_queued",
      fillTurnId: "turn_fill_1", fillTurnSessionId: "session_1", fillTurnUserId: "user_1",
    })
    mocks.fillerFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "filler_1", status: "running" }])
    mocks.taskInterrupt.mockResolvedValueOnce({ disposition: "accepted" })
    const { DELETE } = await import("./route")
    const request = new Request("http://localhost/api/agent/application-tasks?id=task_1", { method: "DELETE" })

    const response = await DELETE(request as never)

    expect(response.status).toBe(200)
    expect(mocks.transaction).toHaveBeenCalledOnce()
    expect(mocks.taskInterrupt).toHaveBeenCalledWith(expect.objectContaining({ taskId: "filler_1" }))
    expect(mocks.transaction.mock.invocationCallOrder[0]).toBeLessThan(mocks.taskInterrupt.mock.invocationCallOrder[0]!)
  })

  it("rejects ambiguous bound fillers before cancelling the application task", async () => {
    mocks.applicationFillTaskGraphEnabled.mockReturnValue(true)
    mocks.findFirst.mockResolvedValueOnce({
      id: "task_1", sessionId: "session_1", status: "filling", checkpoint: "browser_active",
      fillTurnId: "turn_fill_1", fillTurnSessionId: "session_1", fillTurnUserId: "user_1",
    })
    mocks.fillerFindMany.mockResolvedValueOnce([{ id: "filler_1", status: "running" }, { id: "filler_2", status: "running" }])
    const { DELETE } = await import("./route")
    const request = new Request("http://localhost/api/agent/application-tasks?id=task_1", { method: "DELETE" })

    const response = await DELETE(request as never)

    expect(response.status).toBe(409)
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.taskInterrupt).not.toHaveBeenCalled()
  })

  it("fails closed when the active filler interrupt cannot be persisted", async () => {
    mocks.applicationFillTaskGraphEnabled.mockReturnValue(true)
    mocks.findFirst.mockResolvedValueOnce({
      id: "task_1", sessionId: "session_1", status: "filling", checkpoint: "browser_active",
      fillTurnId: "turn_fill_1", fillTurnSessionId: "session_1", fillTurnUserId: "user_1",
    })
    mocks.fillerFindMany.mockResolvedValueOnce([{ id: "filler_1", status: "running" }])
    mocks.taskInterrupt.mockRejectedValueOnce(new Error("outbox unavailable"))
    const { DELETE } = await import("./route")
    const request = new Request("http://localhost/api/agent/application-tasks?id=task_1", { method: "DELETE" })

    const response = await DELETE(request as never)

    expect(response.status).toBe(500)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
})

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "task_1", userId: "user_1", sessionId: "session_1", fillTurnId: "turn_waiting",
    fillTurnSessionId: "session_1", fillTurnUserId: "user_1", status: "waiting_for_user",
    checkpoint: "form_answer_required", question: { waitId: "wait_1", missing: ["Location"] }, confirmedAnswers: null,
    job: { id: "job_1", url: "https://jobs.lever.co/acme/123" }, ...overrides,
  }
}

function patchRequest(action: "resume_after_input" | "answer_and_resume", answers?: Record<string, string>, waitId = "wait_1") {
  return new Request("http://localhost/api/agent/application-tasks", {
    method: "PATCH",
    body: JSON.stringify({ id: "task_1", waitId, action, ...(answers ? { answers } : {}) }),
  })
}

describe("PATCH /api/agent/application-tasks with TaskGraph fills", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.findFirst.mockResolvedValue(task())
    mocks.updateMany.mockResolvedValue({ count: 1 })
    mocks.taskUpdate.mockResolvedValue({})
    mocks.eventCreate.mockResolvedValue({ id: "event_1" })
    mocks.applicationFillTaskGraphEnabled.mockReturnValue(true)
    mocks.queueApplicationFill.mockResolvedValue({ taskId: "turn_new", turnId: "turn_new", disposition: "started" })
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      applicationTask: { updateMany: mocks.updateMany, update: mocks.taskUpdate },
      applicationTaskEvent: { create: mocks.eventCreate },
      agentApproval: { updateMany: mocks.approvalUpdateMany },
    }))
  })

  it("persists scoped answers before queueing a TaskGraph resume", async () => {
    const { PATCH } = await import("./route")
    const response = await PATCH(patchRequest("answer_and_resume", { Location: " Dublin " }) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ resumed: true, turnId: "turn_new" })
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "task_1", userId: "user_1", sessionId: "session_1", status: "waiting_for_user",
        checkpoint: "form_answer_required", fillTurnId: "turn_waiting", fillTurnSessionId: "session_1", fillTurnUserId: "user_1",
        question: { path: ["waitId"], equals: "wait_1" },
      }),
      data: { confirmedAnswers: { Location: "Dublin" } },
    }))
    expect(mocks.eventCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: "user_answers_confirmed", actor: "user", data: { answeredFieldCount: 1 } }),
    }))
    expect(mocks.queueApplicationFill).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_1", applicationTaskId: "task_1", sessionId: "session_1", resumeAfterUserInput: true,
    }))
  })

  it("retries already-persisted answers on the same active wait without duplicating the confirmation event", async () => {
    mocks.findFirst.mockResolvedValueOnce(task({ confirmedAnswers: { Location: "Dublin" } }))
    const { PATCH } = await import("./route")

    const response = await PATCH(patchRequest("answer_and_resume", { Location: " Dublin " }) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ resumed: true, turnId: "turn_new" })
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.updateMany).not.toHaveBeenCalled()
    expect(mocks.eventCreate).not.toHaveBeenCalled()
    expect(mocks.queueApplicationFill).toHaveBeenCalledOnce()
    expect(mocks.queueApplicationFill).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_1", applicationTaskId: "task_1", sessionId: "session_1", resumeAfterUserInput: true,
    }))
  })

  it("scopes answer drafts to task, wait, and field so a later wait gets a fresh draft", async () => {
    const { formAnswerDraftKey } = await import("@/components/agent-workspace/SessionFocusPanel")

    const firstWaitKey = formAnswerDraftKey("task_1", "wait_1", "Location")
    const laterWaitKey = formAnswerDraftKey("task_1", "wait_2", "Location")

    expect(firstWaitKey).not.toBe(laterWaitKey)
    expect(firstWaitKey).toBe(formAnswerDraftKey("task_1", "wait_1", "Location"))
    expect(firstWaitKey).not.toBe(formAnswerDraftKey("task_2", "wait_1", "Location"))
    expect(firstWaitKey).not.toBe(formAnswerDraftKey("task_1", "wait_1", "Salary"))
  })

  it("returns the bound resumed Turn for an exact answer replay", async () => {
    mocks.findFirst.mockResolvedValueOnce(task({ status: "filling", checkpoint: "taskgraph_fill_queued", confirmedAnswers: { Location: "Dublin" }, fillTurnId: "turn_resumed" }))
    mocks.queueApplicationFill.mockResolvedValueOnce({ taskId: "turn_resumed", turnId: "turn_resumed", disposition: "duplicate" })
    const { PATCH } = await import("./route")
    const response = await PATCH(patchRequest("answer_and_resume", { Location: "Dublin" }) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ resumed: true, duplicate: true, turnId: "turn_resumed" })
    expect(mocks.queueApplicationFill).toHaveBeenCalledWith(expect.objectContaining({ resumeAfterUserInput: true }))
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it("rejects an answer replay from a prior wait after a later form-answer wait is active", async () => {
    mocks.findFirst.mockResolvedValueOnce(task({
      question: { waitId: "wait_2", missing: ["Location"] },
      confirmedAnswers: { Location: "Dublin" },
    }))
    const { PATCH } = await import("./route")
    const response = await PATCH(patchRequest("answer_and_resume", { Location: "Dublin" }, "wait_1") as never)

    expect(response.status).toBe(409)
    expect(mocks.updateMany).not.toHaveBeenCalled()
    expect(mocks.eventCreate).not.toHaveBeenCalled()
    expect(mocks.queueApplicationFill).not.toHaveBeenCalled()
  })

  it("fails closed when a legacy form wait has no wait ID", async () => {
    mocks.findFirst.mockResolvedValueOnce(task({ question: { missing: ["Location"] } }))
    const { PATCH } = await import("./route")
    const response = await PATCH(patchRequest("answer_and_resume", { Location: "Dublin" }, "") as never)

    expect(response.status).toBe(409)
    expect(mocks.updateMany).not.toHaveBeenCalled()
    expect(mocks.eventCreate).not.toHaveBeenCalled()
    expect(mocks.queueApplicationFill).not.toHaveBeenCalled()
  })

  it.each([
    { label: "browser_active", status: "filling", checkpoint: "browser_active" },
    { label: "completed review checkpoint", status: "waiting_for_authorization", checkpoint: "form_filled" },
  ])("replays an exact answer request after the Worker reaches $label", async ({ status, checkpoint }) => {
    mocks.findFirst.mockResolvedValueOnce(task({ status, checkpoint, confirmedAnswers: { Location: "Dublin" }, fillTurnId: "turn_resumed" }))
    mocks.queueApplicationFill.mockResolvedValueOnce({ taskId: "turn_resumed", turnId: "turn_resumed", disposition: "duplicate" })
    const { PATCH } = await import("./route")
    const response = await PATCH(patchRequest("answer_and_resume", { Location: "Dublin" }) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ resumed: true, duplicate: true, turnId: "turn_resumed" })
    expect(mocks.queueApplicationFill).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_1", applicationTaskId: "task_1", sessionId: "session_1", resumeAfterUserInput: true,
    }))
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it("rejects changed answers when replaying after the browser has claimed the resumed Turn", async () => {
    mocks.findFirst.mockResolvedValueOnce(task({ status: "filling", checkpoint: "browser_active", confirmedAnswers: { Location: "Dublin" }, fillTurnId: "turn_resumed" }))
    const { PATCH } = await import("./route")
    const response = await PATCH(patchRequest("answer_and_resume", { Location: "Cork" }) as never)

    expect(response.status).toBe(409)
    expect(mocks.queueApplicationFill).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it("denies answer replay when submitted sanitized answers differ from persisted answers", async () => {
    mocks.findFirst.mockResolvedValueOnce(task({ status: "filling", checkpoint: "taskgraph_fill_queued", confirmedAnswers: { Location: "Dublin" }, fillTurnId: "turn_resumed" }))
    const { PATCH } = await import("./route")
    const response = await PATCH(patchRequest("answer_and_resume", { Location: "Cork" }) as never)

    expect(response.status).toBe(409)
    expect(mocks.queueApplicationFill).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it("returns duplicate after a lost answer-write race only for the same bound resumed Turn", async () => {
    mocks.findFirst
      .mockResolvedValueOnce(task())
      .mockResolvedValueOnce(task({ status: "filling", checkpoint: "taskgraph_fill_queued", confirmedAnswers: { Location: "Dublin" }, fillTurnId: "turn_resumed" }))
    mocks.updateMany.mockResolvedValueOnce({ count: 0 })
    mocks.queueApplicationFill.mockResolvedValueOnce({ taskId: "turn_resumed", turnId: "turn_resumed", disposition: "duplicate" })
    const { PATCH } = await import("./route")
    const response = await PATCH(patchRequest("answer_and_resume", { Location: "Dublin" }) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ duplicate: true, turnId: "turn_resumed" })
    expect(mocks.eventCreate).not.toHaveBeenCalled()
    expect(mocks.queueApplicationFill).toHaveBeenCalledOnce()
  })

  it("lets an exact concurrent answer retry continue through the same resume command", async () => {
    mocks.findFirst
      .mockResolvedValueOnce(task())
      .mockResolvedValueOnce(task({ confirmedAnswers: { Location: "Dublin" } }))
    mocks.updateMany.mockResolvedValueOnce({ count: 0 })
    mocks.queueApplicationFill.mockResolvedValueOnce({ taskId: "turn_resumed", turnId: "turn_resumed", disposition: "started" })
    const { PATCH } = await import("./route")

    const response = await PATCH(patchRequest("answer_and_resume", { Location: "Dublin" }) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ resumed: true, turnId: "turn_resumed", disposition: "started" })
    expect(mocks.updateMany.mock.calls[0]?.[0].where).toHaveProperty("confirmedAnswers.equals")
    expect(mocks.eventCreate).not.toHaveBeenCalled()
    expect(mocks.queueApplicationFill).toHaveBeenCalledOnce()
  })

  it("rejects a conflicting answer after another concurrent request saved its value", async () => {
    mocks.findFirst
      .mockResolvedValueOnce(task())
      .mockResolvedValueOnce(task({ confirmedAnswers: { Location: "Dublin" } }))
    mocks.updateMany.mockResolvedValueOnce({ count: 0 })
    const { PATCH } = await import("./route")

    const response = await PATCH(patchRequest("answer_and_resume", { Location: "Cork" }) as never)

    expect(response.status).toBe(409)
    expect(mocks.eventCreate).not.toHaveBeenCalled()
    expect(mocks.queueApplicationFill).not.toHaveBeenCalled()
  })

  it("rejects a losing answer-write race when submitted answers differ from persisted values", async () => {
    mocks.findFirst
      .mockResolvedValueOnce(task())
      .mockResolvedValueOnce(task({ status: "filling", checkpoint: "taskgraph_fill_queued", confirmedAnswers: { Location: "Dublin" }, fillTurnId: "turn_resumed" }))
    mocks.updateMany.mockResolvedValueOnce({ count: 0 })
    const { PATCH } = await import("./route")
    const response = await PATCH(patchRequest("answer_and_resume", { Location: "Cork" }) as never)

    expect(response.status).toBe(409)
    expect(mocks.eventCreate).not.toHaveBeenCalled()
    expect(mocks.queueApplicationFill).not.toHaveBeenCalled()
  })

  it("keeps the legacy answer-and-resume route when TaskGraph routing is disabled", async () => {
    mocks.applicationFillTaskGraphEnabled.mockReturnValue(false)
    mocks.findFirst.mockResolvedValueOnce(task({ fillTurnId: null, fillTurnSessionId: null, fillTurnUserId: null }))
    const { PATCH } = await import("./route")
    const response = await PATCH(patchRequest("answer_and_resume", { Location: "Dublin" }) as never)

    expect(response.status).toBe(200)
    expect(mocks.taskUpdate).toHaveBeenCalledWith({ where: { id: "task_1" }, data: { confirmedAnswers: { Location: "Dublin" } } })
    expect(mocks.queueApplicationFill).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_1", jobId: "job_1", applicationTaskId: "task_1", resumeAfterUserInput: true,
    }))
    expect(mocks.queueApplicationFill.mock.calls[0]?.[0]).not.toHaveProperty("sessionId")
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })

  it("does not send a persisted TaskGraph fill through legacy answer handling when routing is disabled", async () => {
    mocks.applicationFillTaskGraphEnabled.mockReturnValue(false)
    mocks.findFirst.mockResolvedValueOnce(task({ fillTurnId: "turn_bound" }))
    const { PATCH } = await import("./route")

    const response = await PATCH(patchRequest("answer_and_resume", { Location: "Dublin" }) as never)

    expect(response.status).toBe(409)
    expect(mocks.taskUpdate).not.toHaveBeenCalled()
    expect(mocks.updateMany).not.toHaveBeenCalled()
    expect(mocks.eventCreate).not.toHaveBeenCalled()
    expect(mocks.queueApplicationFill).not.toHaveBeenCalled()
  })
})
