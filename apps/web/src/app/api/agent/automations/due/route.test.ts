import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  automationFindMany: vi.fn(),
  automationUpdateMany: vi.fn(),
  automationUpdate: vi.fn(),
  sessionCreate: vi.fn(),
  sessionFindFirst: vi.fn(),
  sessionDeleteMany: vi.fn(),
  sessionUpdate: vi.fn(),
  sessionUpdateMany: vi.fn(),
  transcriptCreate: vi.fn(),
  enqueueAgentRun: vi.fn(),
  executionFindFirst: vi.fn(),
  executionUpdate: vi.fn(),
  ensureExecution: vi.fn(),
  hasEffectiveEntitlement: vi.fn(),
  turnFindFirst: vi.fn(),
  turnCreate: vi.fn(),
}))

vi.mock("@/lib/agent-run-queue-client", () => ({ enqueueAgentRun: mocks.enqueueAgentRun }))
vi.mock("@/lib/agent/execution-control", () => ({ ensureAgentExecution: mocks.ensureExecution }))
vi.mock("@/lib/entitlements", () => ({ hasEffectiveEntitlement: mocks.hasEffectiveEntitlement }))

vi.mock("@/lib/api-helpers", () => ({
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

vi.mock("@/lib/db", () => ({
  db: {
    agentAutomation: {
      findMany: mocks.automationFindMany,
      updateMany: mocks.automationUpdateMany,
      update: mocks.automationUpdate,
    },
    agentSession: { create: mocks.sessionCreate, findFirst: mocks.sessionFindFirst, deleteMany: mocks.sessionDeleteMany, update: mocks.sessionUpdate, updateMany: mocks.sessionUpdateMany },
    agentExecution: { findFirst: mocks.executionFindFirst, update: mocks.executionUpdate },
    agentTranscriptEvent: { create: mocks.transcriptCreate },
    agentTurn: { findFirst: mocks.turnFindFirst, create: mocks.turnCreate },
  },
}))

function postRequest(headers?: HeadersInit) {
  return new Request("http://localhost/api/agent/automations/due", { method: "POST", headers })
}

function getRequest(headers?: HeadersInit) {
  return new Request("http://localhost/api/agent/automations/due", { method: "GET", headers })
}

describe("agent automation due scheduler API", () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    vi.stubEnv("AGENT_AUTOMATION_CRON_SECRET", "")
    mocks.automationFindMany.mockResolvedValue([
      {
        id: "automation_1",
        userId: "user_1",
        name: "Weekday Berlin SWE Scout",
        cron: "0 9 * * 1-5",
        timezone: "Europe/Berlin",
        triggerType: "weekdays",
        targetRoles: ["SWE"],
        targetLocations: ["Berlin"],
        minScore: 85,
        dailyCap: 8,
        requireApproval: true,
        autoApply: true,
        sessionId: null,
      },
    ])
    mocks.sessionCreate.mockResolvedValue({ id: "session_1" })
    mocks.sessionFindFirst.mockResolvedValue(null)
    mocks.sessionDeleteMany.mockResolvedValue({ count: 1 })
    mocks.sessionUpdateMany.mockResolvedValue({ count: 1 })
    mocks.transcriptCreate.mockResolvedValue({ id: "event_1" })
    mocks.enqueueAgentRun.mockResolvedValue("task_1")
    mocks.automationUpdateMany.mockResolvedValue({ count: 1 })
    mocks.automationUpdate.mockResolvedValue({})
    mocks.sessionUpdate.mockResolvedValue({})
    mocks.ensureExecution.mockResolvedValue({ id: "execution_1" })
    mocks.executionUpdate.mockResolvedValue({})
    mocks.hasEffectiveEntitlement.mockResolvedValue(true)
    mocks.turnFindFirst.mockResolvedValue(null)
    mocks.turnCreate.mockResolvedValue({ id: "turn_1" })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("starts due enabled automations as AgentSessions", async () => {
    const { POST } = await import("./route")

    const res = await POST(postRequest() as never)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      started: [{ automationId: "automation_1", sessionId: "session_1", taskId: "task_1" }],
    })
    expect(mocks.automationFindMany).toHaveBeenCalledWith({
      where: {
        enabled: true,
        nextRunAt: { lte: expect.any(Date) },
        user: { accountStatus: "active" },
      },
      orderBy: { nextRunAt: "asc" },
      take: 20,
    })
    expect(mocks.sessionCreate).toHaveBeenCalledWith({
      data: {
        userId: "user_1",
        goal: "Run automation: Weekday Berlin SWE Scout",
        source: "automation",
        status: "running",
        memorySummary: "Automation picked up by scheduler.",
      },
    })
    expect(mocks.transcriptCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionId: "session_1",
        type: "automation_started",
        body: "Started scheduled automation: Weekday Berlin SWE Scout",
        data: {
          automationId: "automation_1",
          automation: {
            name: "Weekday Berlin SWE Scout",
            triggerType: "weekdays",
            targetRoles: ["SWE"],
            targetLocations: ["Berlin"],
            minScore: 85,
            dailyCap: 8,
            requireApproval: true,
            autoApply: true,
          },
        },
      }),
    })
    expect(mocks.automationUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "automation_1",
        userId: "user_1",
        enabled: true,
        nextRunAt: { lte: expect.any(Date) },
        user: { accountStatus: "active" },
      },
      data: { lastRunAt: expect.any(Date), nextRunAt: expect.any(Date) },
    })
    expect(mocks.enqueueAgentRun).toHaveBeenCalledWith({ userId: "user_1", sessionId: "session_1", turnId: "turn_1", executionId: "execution_1" })
    expect(mocks.turnCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        input: {
          goal: "Run automation: Weekday Berlin SWE Scout",
          scheduledAutomationSnapshot: {
            schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1",
            targetRoles: ["SWE"],
            targetLocations: ["Berlin"],
            minScore: 85,
            dailyCap: 8,
            requireApproval: true,
            autoApply: true,
          },
        },
      }),
    }))
  }, 15_000)

  it("skips session creation when another scheduler already claimed the automation", async () => {
    mocks.automationUpdateMany.mockResolvedValueOnce({ count: 0 })
    const { POST } = await import("./route")

    const res = await POST(postRequest() as never)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ started: [] })
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
    expect(mocks.transcriptCreate).not.toHaveBeenCalled()
  })

  it("keeps a due automation in one session and skips overlapping execution", async () => {
    mocks.automationFindMany.mockResolvedValueOnce([{
      id: "automation_1", userId: "user_1", name: "Weekday Berlin SWE Scout", cron: "0 9 * * 1-5",
      timezone: "Europe/Berlin", triggerType: "weekdays", targetRoles: ["SWE"], targetLocations: ["Berlin"],
      minScore: 85, dailyCap: 8, requireApproval: true, autoApply: true, sessionId: "session_1",
    }])
    mocks.executionFindFirst.mockResolvedValueOnce({ status: "queued" })
    const { POST } = await import("./route")

    const res = await POST(postRequest() as never)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ started: [] })
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled()
    expect(mocks.automationUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { lastRunAt: expect.any(Date), nextRunAt: expect.any(Date) },
    }))
  })

  it("dispatches a runtime-paused linked session", async () => {
    mocks.automationFindMany.mockResolvedValueOnce([{
      id: "automation_1", userId: "user_1", name: "Weekday Berlin SWE Scout", cron: "0 9 * * 1-5",
      timezone: "Europe/Berlin", triggerType: "weekdays", targetRoles: ["SWE"], targetLocations: ["Berlin"],
      minScore: 85, dailyCap: 8, requireApproval: true, autoApply: true, sessionId: "session_1",
    }])
    mocks.sessionFindFirst.mockResolvedValue({ id: "session_1", status: "paused" })
    const { POST } = await import("./route")

    const res = await POST(postRequest() as never)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ started: [{ sessionId: "session_1", taskId: "task_1" }] })
    expect(mocks.sessionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "session_1", userId: "user_1" },
      data: expect.objectContaining({ status: "running" }),
    }))
    expect(mocks.enqueueAgentRun).toHaveBeenCalled()
  })

  it("requires the configured cron secret", async () => {
    vi.stubEnv("AGENT_AUTOMATION_CRON_SECRET", "cron-secret")
    const { POST } = await import("./route")

    const rejected = await POST(postRequest() as never)
    const accepted = await POST(postRequest({ authorization: "Bearer cron-secret" }) as never)

    expect(rejected.status).toBe(401)
    expect(accepted.status).toBe(200)
  })

  it("accepts Vercel CRON_SECRET as a fallback secret", async () => {
    vi.stubEnv("AGENT_AUTOMATION_CRON_SECRET", "")
    vi.stubEnv("CRON_SECRET", "vercel-cron-secret")
    const { POST } = await import("./route")

    const res = await POST(postRequest({ "x-agent-cron-secret": "vercel-cron-secret" }) as never)

    expect(res.status).toBe(200)
  })

  it("supports Vercel Cron GET requests with bearer CRON_SECRET", async () => {
    vi.stubEnv("CRON_SECRET", "vercel-cron-secret")
    const { GET } = await import("./route")

    const res = await GET(getRequest({ authorization: "Bearer vercel-cron-secret" }) as never)

    expect(res.status).toBe(200)
    expect(mocks.sessionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        source: "automation",
        status: "running",
      }),
    })
  })

  it("records a failed session and makes the automation due again when queueing fails", async () => {
    mocks.enqueueAgentRun.mockRejectedValueOnce(new Error("Redis unavailable"))
    const { POST } = await import("./route")

    await expect(POST(postRequest() as never)).rejects.toThrow("Redis unavailable")
    expect(mocks.sessionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "session_1" }, data: expect.objectContaining({ status: "failed" }),
    }))
    expect(mocks.automationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "automation_1" }, data: { nextRunAt: expect.any(Date) },
    }))
  })

  it("does not create a session for an automation owned by a suspended user", async () => {
    mocks.automationFindMany.mockResolvedValueOnce([])
    const { POST } = await import("./route")

    const res = await POST(postRequest() as never)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ started: [] })
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
  })

  it("skips a raced non-automation Turn and makes the automation due again", async () => {
    mocks.turnFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    mocks.turnCreate.mockRejectedValueOnce({ code: "P2002" })
    const { POST } = await import("./route")

    const res = await POST(postRequest() as never)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ started: [] })
    expect(mocks.ensureExecution).not.toHaveBeenCalled()
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled()
    expect(mocks.automationUpdate).toHaveBeenCalledWith({
      where: { id: "automation_1", userId: "user_1" },
      data: { nextRunAt: expect.any(Date) },
    })
    expect(mocks.turnFindFirst).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ userId: "user_1", sessionId: "session_1", source: "automation" }),
    }))
  })

  it.each([null, "session_1"] as const)("defers malformed persisted config before session/Turn side effects (%s)", async (sessionId) => {
    mocks.automationFindMany.mockResolvedValueOnce([{
      id: "automation_1", userId: "user_1", name: "Weekday Berlin SWE Scout", cron: "0 9 * * 1-5",
      timezone: "Europe/Berlin", triggerType: "weekdays", targetRoles: "SWE", targetLocations: ["Berlin"],
      minScore: 85, dailyCap: 8, requireApproval: true, autoApply: true, sessionId,
    }])
    const { POST } = await import("./route")

    const res = await POST(postRequest() as never)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      started: [],
      failedAutomations: [{ automationId: "automation_1", code: "INVALID_SCHEDULED_AUTOMATION_SNAPSHOT" }],
    })

    expect(mocks.turnCreate).not.toHaveBeenCalled()
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled()
    expect(mocks.automationUpdateMany).toHaveBeenCalledTimes(1)
    expect(mocks.automationUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "automation_1",
        userId: "user_1",
        enabled: true,
        nextRunAt: { lte: expect.any(Date) },
        user: { accountStatus: "active" },
      },
      data: { nextRunAt: expect.any(Date) },
    })
    expect(mocks.automationUpdate).not.toHaveBeenCalled()
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
    expect(mocks.sessionFindFirst).not.toHaveBeenCalled()
    expect(mocks.sessionUpdateMany).not.toHaveBeenCalled()
    expect(mocks.turnFindFirst).toHaveBeenCalledTimes(sessionId ? 1 : 0)
    if (sessionId) {
      expect(mocks.turnFindFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ sessionId, userId: "user_1", source: "automation" }),
      }))
    }
  })

  it("continues dispatching valid automations after reporting a malformed row", async () => {
    mocks.automationFindMany.mockResolvedValueOnce([
      {
        id: "automation_bad", userId: "user_bad", name: "Malformed automation", cron: null,
        timezone: "UTC", triggerType: "manual", targetRoles: "SWE", targetLocations: [],
        minScore: 85, dailyCap: 8, requireApproval: true, autoApply: true, sessionId: null,
      },
      {
        id: "automation_good", userId: "user_2", name: "Valid automation", cron: null,
        timezone: "UTC", triggerType: "manual", targetRoles: ["SWE"], targetLocations: ["Berlin"],
        minScore: 85, dailyCap: 8, requireApproval: true, autoApply: true, sessionId: null,
      },
    ])
    const { POST } = await import("./route")

    const res = await POST(postRequest() as never)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      started: [{ automationId: "automation_good", sessionId: "session_1", taskId: "task_1" }],
      failedAutomations: [{ automationId: "automation_bad", code: "INVALID_SCHEDULED_AUTOMATION_SNAPSHOT" }],
    })
    expect(mocks.automationUpdateMany.mock.calls.map(([args]) => args.where.id)).toEqual(["automation_bad", "automation_good", "automation_good"])
    expect(mocks.sessionCreate).toHaveBeenCalledTimes(1)
    expect(mocks.sessionCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "user_2" }) })
    expect(mocks.turnFindFirst).toHaveBeenCalledTimes(1)
    expect(mocks.turnCreate).toHaveBeenCalledTimes(1)
    expect(mocks.enqueueAgentRun).toHaveBeenCalledTimes(1)
    expect(mocks.enqueueAgentRun).toHaveBeenCalledWith({ userId: "user_2", sessionId: "session_1", turnId: "turn_1", executionId: "execution_1" })
  })

  it("reuses an active automation Turn without validating edited persisted config", async () => {
    mocks.automationFindMany.mockResolvedValueOnce([{
      id: "automation_1", userId: "user_1", name: "Weekday Berlin SWE Scout", cron: "0 9 * * 1-5",
      timezone: "Europe/Berlin", triggerType: "weekdays", targetRoles: "edited-invalid-value", targetLocations: ["Berlin"],
      minScore: 85, dailyCap: 8, requireApproval: true, autoApply: true, sessionId: "session_1",
    }])
    mocks.sessionFindFirst.mockResolvedValueOnce({ id: "session_1" })
    mocks.turnFindFirst.mockResolvedValue({ id: "turn_active" })
    const { POST } = await import("./route")

    const res = await POST(postRequest() as never)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      started: [{ automationId: "automation_1", sessionId: "session_1", taskId: "task_1" }],
    })
    expect(mocks.turnFindFirst).toHaveBeenNthCalledWith(1, {
      where: {
        sessionId: "session_1",
        userId: "user_1",
        source: "automation",
        status: { in: ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    })
    expect(mocks.turnFindFirst).toHaveBeenCalledTimes(1)
    expect(mocks.turnCreate).not.toHaveBeenCalled()
    expect(mocks.enqueueAgentRun).toHaveBeenCalledWith({ userId: "user_1", sessionId: "session_1", turnId: "turn_active", executionId: "execution_1" })
  })

  it.each([
    ["malformed", true, 20],
    ["non-entitled malformed", false, 0],
  ] as const)("backs off the first 20 %s rows so the next poll can select a later valid automation", async (_scenario, badRowsEntitled, expectedFailures) => {
    type SchedulerAutomationRow = {
      id: string
      userId: string
      name: string
      enabled: boolean
      cron: string | null
      timezone: string
      triggerType: string
      targetRoles: string[] | string
      targetLocations: string[]
      minScore: number
      dailyCap: number
      requireApproval: boolean
      autoApply: boolean
      sessionId: string | null
      nextRunAt: Date | null
      lastRunAt: Date | null
    }
    type FindDueArgs = { where: { nextRunAt: { lte: Date } }; take: number }
    type UpdateDueArgs = {
      where: {
        id: string
        userId: string
        enabled: true
        nextRunAt: { lte: Date }
        user: { accountStatus: "active" }
      }
      data: { nextRunAt: Date | null; lastRunAt?: Date }
    }

    const dueAt = Date.now() - 60_000
    const badRows: SchedulerAutomationRow[] = Array.from({ length: 20 }, (_, index) => ({
      id: `automation_bad_${index}`,
      userId: `user_bad_${index}`,
      name: `Malformed automation ${index}`,
      enabled: true,
      cron: null,
      timezone: "UTC",
      triggerType: "manual",
      targetRoles: "SWE",
      targetLocations: ["Berlin"],
      minScore: 85,
      dailyCap: 8,
      requireApproval: true,
      autoApply: true,
      sessionId: null,
      nextRunAt: new Date(dueAt + index),
      lastRunAt: null,
    }))
    const validRow: SchedulerAutomationRow = {
      id: "automation_valid_21",
      userId: "user_valid_21",
      name: "Valid automation after malformed rows",
      enabled: true,
      cron: null,
      timezone: "UTC",
      triggerType: "manual",
      targetRoles: ["SWE"],
      targetLocations: ["Berlin"],
      minScore: 85,
      dailyCap: 8,
      requireApproval: true,
      autoApply: true,
      sessionId: "session_valid_21",
      nextRunAt: new Date(dueAt + 20),
      lastRunAt: null,
    }
    const rows = [...badRows, validRow]
    mocks.hasEffectiveEntitlement.mockImplementation(async (userId: string) => badRowsEntitled || userId === validRow.userId)

    mocks.automationFindMany.mockImplementation(async ({ where, take }: FindDueArgs) => rows
      .filter(row => row.enabled && row.nextRunAt !== null && row.nextRunAt.getTime() <= where.nextRunAt.lte.getTime())
      .sort((left, right) => (left.nextRunAt?.getTime() ?? Infinity) - (right.nextRunAt?.getTime() ?? Infinity))
      .slice(0, take))
    mocks.automationUpdateMany.mockImplementation(async ({ where, data }: UpdateDueArgs) => {
      const row = rows.find(candidate => candidate.id === where.id && candidate.userId === where.userId)
      if (!row || !row.enabled || row.nextRunAt === null || row.nextRunAt.getTime() > where.nextRunAt.lte.getTime()) {
        return { count: 0 }
      }
      row.nextRunAt = data.nextRunAt
      row.lastRunAt = data.lastRunAt ?? row.lastRunAt
      return { count: 1 }
    })
    mocks.sessionFindFirst.mockResolvedValueOnce({ id: validRow.sessionId, status: "paused" })

    const { POST } = await import("./route")
    const firstResponse = await POST(postRequest() as never)
    const firstBody = await firstResponse.json() as { checkedAt: string; started: unknown[]; failedAutomations: { automationId: string }[] }

    expect(firstBody.started).toEqual([])
    expect(firstBody.failedAutomations).toHaveLength(expectedFailures)
    expect(mocks.automationFindMany).toHaveBeenCalledTimes(1)
    expect(mocks.automationUpdateMany).toHaveBeenCalledTimes(20)
    expect(mocks.automationUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: badRows[0].id,
        userId: badRows[0].userId,
        enabled: true,
        nextRunAt: { lte: expect.any(Date) },
        user: { accountStatus: "active" },
      }),
      data: { nextRunAt: expect.any(Date) },
    }))
    const firstCheckedAt = new Date(firstBody.checkedAt).getTime()
    expect(badRows.every(row => row.nextRunAt !== null && row.nextRunAt.getTime() > firstCheckedAt + 4 * 60_000)).toBe(true)
    expect(badRows.every(row => row.enabled && row.lastRunAt === null)).toBe(true)

    const secondResponse = await POST(postRequest() as never)
    const secondBody = await secondResponse.json()

    expect(secondBody).toMatchObject({
      started: [{ automationId: validRow.id, sessionId: validRow.sessionId }],
      failedAutomations: [],
    })
    expect(mocks.automationFindMany).toHaveBeenCalledTimes(2)
    expect(mocks.automationFindMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ take: 20 }))
    expect(mocks.enqueueAgentRun).toHaveBeenCalledTimes(1)

    if (!badRowsEntitled) {
      // Simulate the retry time becoming due, then restore entitlement.
      for (const row of badRows) row.nextRunAt = new Date(Date.now() - 60_000)
      mocks.hasEffectiveEntitlement.mockResolvedValue(true)

      const retryResponse = await POST(postRequest() as never)
      const retryBody = await retryResponse.json()

      expect(retryBody.failedAutomations).toHaveLength(20)
      expect(mocks.automationFindMany).toHaveBeenCalledTimes(3)
      expect(mocks.turnCreate).toHaveBeenCalledTimes(1)
    }
  })
})
