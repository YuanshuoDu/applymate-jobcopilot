import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  automationFindFirst: vi.fn(),
  automationUpdateMany: vi.fn(),
  sessionCreate: vi.fn(),
  sessionFindFirst: vi.fn(),
  sessionDeleteMany: vi.fn(),
  sessionUpdate: vi.fn(),
  sessionUpdateMany: vi.fn(),
  executionFindFirst: vi.fn(),
  transcriptCreate: vi.fn(),
  executionUpdate: vi.fn(),
  ensureExecution: vi.fn(),
  enqueueAgentRun: vi.fn(),
  startRecovery: vi.fn(),
  runtimeFeatureEnabled: vi.fn(),
  createDualWrite: vi.fn(),
  turnFindFirst: vi.fn(),
  turnCreate: vi.fn(),
  hasEffectiveEntitlement: vi.fn(),
}))

vi.mock("@/lib/agent/execution-control", () => ({ ensureAgentExecution: mocks.ensureExecution }))
vi.mock("@/lib/agent-run-queue-client", () => ({ enqueueAgentRun: mocks.enqueueAgentRun }))
vi.mock("@/lib/entitlements", () => ({ hasEffectiveEntitlement: mocks.hasEffectiveEntitlement }))
vi.mock("@/lib/runtime-feature-flags", () => ({ isRuntimeAgentHarnessFeatureEnabled: mocks.runtimeFeatureEnabled }))
vi.mock("@/lib/agent/session/dual-write", () => ({ createDualWriteSession: mocks.createDualWrite }))
vi.mock("@/lib/agent/material-drift-recovery", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent/material-drift-recovery")>("@/lib/agent/material-drift-recovery")
  return { ...actual, startMaterialDriftRecovery: mocks.startRecovery }
})

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (val: unknown) => val instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

vi.mock("@/lib/db", () => ({
  db: {
    agentAutomation: {
      findFirst: mocks.automationFindFirst,
      updateMany: mocks.automationUpdateMany,
    },
    agentSession: { create: mocks.sessionCreate, findFirst: mocks.sessionFindFirst, deleteMany: mocks.sessionDeleteMany, update: mocks.sessionUpdate, updateMany: mocks.sessionUpdateMany },
    agentExecution: { findFirst: mocks.executionFindFirst, update: mocks.executionUpdate },
    agentTranscriptEvent: { create: mocks.transcriptCreate },
    agentTurn: { findFirst: mocks.turnFindFirst, create: mocks.turnCreate },
  },
}))

type RouteCtx = { params: Promise<{ id: string }> }

function postRequest(body?: unknown) {
  return new Request("http://localhost/api/agent/automations/automation_1/run", {
    method: "POST",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  })
}

function ctx(id = "automation_1"): RouteCtx {
  return { params: Promise.resolve({ id }) }
}

function recoveryAutomation() {
  return { id: "automation_1", name: "Weekday Berlin SWE Scout", enabled: true, cron: "0 9 * * 1-5",
    timezone: "Europe/Berlin", triggerType: "weekdays", targetRoles: ["SWE"], targetLocations: ["Berlin"],
    minScore: 85, dailyCap: 8, requireApproval: true, autoApply: false, sessionId: "session_1" }
}

function recoverySession() {
  return { id: "session_1", goal: "Run automation: Weekday Berlin SWE Scout", status: "running", source: "automation",
    memorySummary: "Automation queued for execution.", qualityScore: null, currentTaskId: null,
    createdAt: new Date("2026-06-18T08:00:00Z"), updatedAt: new Date("2026-06-18T08:00:00Z"), completedAt: null,
    eventSequence: BigInt(1), userId: "user_1", internalAccessToken: "server-only" }
}

function expectedSessionResponse() {
  return { id: "session_1", goal: "Run automation: Weekday Berlin SWE Scout", status: "running", source: "automation",
    memorySummary: "Automation queued for execution.", qualityScore: null, currentTaskId: null,
    createdAt: "2026-06-18T08:00:00.000Z", updatedAt: "2026-06-18T08:00:00.000Z", completedAt: null }
}

function createdRecovery(session = recoverySession()) {
  return { kind: "created", automation: recoveryAutomation(), session, turnId: "turn_recovery", executionId: "execution_1",
    dispatchId: "dispatch_1", turnStatus: "queued", snapshot: { schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1",
      targetRoles: ["SWE"], targetLocations: ["Berlin"], minScore: 85, dailyCap: 8, requireApproval: true, autoApply: false } }
}

function existingRecovery(turnStatus = "queued", session = recoverySession()) {
  return { kind: "already_started", automation: recoveryAutomation(), session, turnId: "turn_recovery", executionId: "execution_1",
    dispatchId: "dispatch_1", turnStatus }
}

describe("agent automation run API", () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.hasEffectiveEntitlement.mockResolvedValue(true)
    mocks.runtimeFeatureEnabled.mockResolvedValue(false)
    mocks.automationFindFirst.mockResolvedValue({
      id: "automation_1",
      name: "Weekday Berlin SWE Scout",
      enabled: true,
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
    })
    mocks.sessionCreate.mockResolvedValue({
      id: "session_1",
      goal: "Run automation: Weekday Berlin SWE Scout",
      status: "running",
      source: "automation",
      memorySummary: "Automation queued for execution.",
      qualityScore: null,
      currentTaskId: null,
      createdAt: new Date("2026-06-18T08:00:00Z"),
      updatedAt: new Date("2026-06-18T08:00:00Z"),
      completedAt: null,
      eventSequence: BigInt(1),
      userId: "user_1",
      internalAccessToken: "server-only",
    })
    mocks.sessionFindFirst.mockResolvedValue(null)
    mocks.sessionDeleteMany.mockResolvedValue({ count: 1 })
    mocks.sessionUpdateMany.mockResolvedValue({ count: 1 })
    mocks.transcriptCreate.mockResolvedValue({
      id: "event_1",
      sessionId: "session_1",
      type: "automation_started",
      speaker: "Orchestrator",
      title: "Automation started",
      body: "Started automation: Weekday Berlin SWE Scout",
      data: { automationId: "automation_1" },
      durationMs: null,
      createdAt: new Date("2026-06-18T08:00:00Z"),
    })
    mocks.automationUpdateMany.mockResolvedValue({ count: 1 })
    mocks.ensureExecution.mockResolvedValue({ id: "execution_1" })
    mocks.enqueueAgentRun.mockResolvedValue("task_1")
    mocks.startRecovery.mockResolvedValue(null)
    mocks.turnFindFirst.mockResolvedValue(null)
    mocks.turnCreate.mockResolvedValue({ id: "turn_1" })
    mocks.executionUpdate.mockResolvedValue({})
  })

  it("persists owner settings for an owned run and ignores request criteria", async () => {
    const { POST } = await import("./route")

    const res = await POST(postRequest({
      automationId: "attacker_automation",
      targetRoles: ["Chief Executive Officer"],
      targetLocations: ["Anywhere"],
      minScore: 0,
      dailyCap: 50,
      requireApproval: false,
      autoApply: false,
      scheduledAutomationSnapshot: { schemaVersion: "forged", targetRoles: ["attacker"] },
      materialDriftRecovery: { schemaVersion: "forged", turnId: "attacker_turn", sourceMarker: { reason: "valid" } },
    }) as never, ctx())

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toMatchObject({
      session: { id: "session_1", source: "automation" },
      event: { id: "event_1", type: "automation_started" },
    })
    expect(body.session).toEqual(expectedSessionResponse())
    expect(body.session).not.toHaveProperty("userId")
    expect(body.session).not.toHaveProperty("eventSequence")
    expect(body.session).not.toHaveProperty("internalAccessToken")
    expect(mocks.automationFindFirst).toHaveBeenCalledWith({
      where: { id: "automation_1", userId: "user_1" },
    })
    expect(mocks.sessionCreate).toHaveBeenCalledWith({
      data: {
        userId: "user_1",
        goal: "Run automation: Weekday Berlin SWE Scout",
        source: "automation",
        status: "running",
        memorySummary: "Automation queued for execution.",
      },
    })
    expect(mocks.transcriptCreate).toHaveBeenCalledWith({
      data: {
        sessionId: "session_1",
        taskId: null,
        type: "automation_started",
        speaker: "Orchestrator",
        title: "Automation started",
        body: "Started automation: Weekday Berlin SWE Scout",
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
        durationMs: null,
      },
    })
    expect(mocks.automationUpdateMany).toHaveBeenCalledWith({
      where: { id: "automation_1", userId: "user_1", enabled: true },
      data: { lastRunAt: expect.any(Date), nextRunAt: expect.any(Date) },
    })
    expect(mocks.enqueueAgentRun).toHaveBeenCalledWith({ userId: "user_1", sessionId: "session_1", turnId: "turn_1", executionId: "execution_1" })
    expect(mocks.turnCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        input: {
          goal: "Run automation: Weekday Berlin SWE Scout",
          automationRunMode: "manual",
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
  })

  it("returns 404 for a missing or unowned automation", async () => {
    mocks.automationFindFirst.mockResolvedValueOnce(null)
    const { POST } = await import("./route")

    const res = await POST(postRequest() as never, ctx())

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: "Automation not found" })
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
  })

  it.each([
    ["empty roles", { targetRoles: [] }],
    ["out-of-range score", { minScore: 101 }],
    ["invalid daily cap", { dailyCap: 0 }],
    ["non-boolean approval setting", { requireApproval: "yes" }],
  ])("rejects %s saved settings before any run mutation", async (_label, invalidFields) => {
    mocks.automationFindFirst.mockResolvedValueOnce({
      id: "automation_1",
      name: "Weekday Berlin SWE Scout",
      enabled: true,
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
      ...invalidFields,
    })
    const { POST } = await import("./route")

    const res = await POST(postRequest({ targetRoles: ["valid request data"] }) as never, ctx())

    expect(res.status).toBe(400)
    expect(mocks.automationUpdateMany).not.toHaveBeenCalled()
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
    expect(mocks.sessionUpdate).not.toHaveBeenCalled()
    expect(mocks.sessionUpdateMany).not.toHaveBeenCalled()
    expect(mocks.turnFindFirst).not.toHaveBeenCalled()
    expect(mocks.turnCreate).not.toHaveBeenCalled()
    expect(mocks.transcriptCreate).not.toHaveBeenCalled()
    expect(mocks.ensureExecution).not.toHaveBeenCalled()
    expect(mocks.executionUpdate).not.toHaveBeenCalled()
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled()
  })

  it("reuses the canonical session for a later automation run", async () => {
    const existing = {
      id: "session_1",
      goal: "Run automation: Weekday Berlin SWE Scout",
      status: "failed",
      source: "automation",
      memorySummary: "Dispatch failed",
      qualityScore: null,
      currentTaskId: null,
      createdAt: new Date("2026-06-18T08:00:00Z"),
      updatedAt: new Date("2026-06-18T08:05:00Z"),
      completedAt: new Date("2026-06-18T08:05:00Z"),
    }
    mocks.automationFindFirst.mockResolvedValueOnce({
      id: "automation_1",
      name: "Weekday Berlin SWE Scout",
      enabled: true,
      cron: "0 9 * * 1-5",
      timezone: "Europe/Berlin",
      triggerType: "weekdays",
      targetRoles: ["SWE"],
      targetLocations: ["Berlin"],
      minScore: 85,
      dailyCap: 8,
      requireApproval: true,
      autoApply: true,
      sessionId: "session_1",
    })
    mocks.sessionFindFirst.mockResolvedValue(existing)
    mocks.transcriptCreate.mockResolvedValueOnce({
      id: "event_2", sessionId: "session_1", type: "automation_started", speaker: "Orchestrator",
      title: "Automation started", body: "Started automation: Weekday Berlin SWE Scout", data: {}, durationMs: null,
      createdAt: new Date("2026-06-18T09:00:00Z"),
    })
    const { POST } = await import("./route")

    const res = await POST(postRequest() as never, ctx())

    expect(res.status).toBe(201)
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
    expect(mocks.sessionUpdateMany).toHaveBeenCalledWith({
      where: { id: "session_1", userId: "user_1" },
      data: { status: "running", completedAt: null, memorySummary: "Automation queued for execution." },
    })
    expect(mocks.ensureExecution).toHaveBeenCalledWith({
      userId: "user_1", sessionId: "session_1", autonomous: true, restartForRun: true,
    })
  })

  it("uses the transaction-created recovery Turn without resetting or redispatching it", async () => {
    const existing = recoverySession()
    mocks.automationFindFirst.mockResolvedValueOnce({
      id: "automation_1", name: "Weekday Berlin SWE Scout", enabled: true, cron: "0 9 * * 1-5",
      timezone: "Europe/Berlin", triggerType: "weekdays", targetRoles: ["SWE"], targetLocations: ["Berlin"],
      minScore: 85, dailyCap: 8, requireApproval: true, autoApply: false, sessionId: "session_1",
    })
    mocks.sessionFindFirst.mockResolvedValue(existing)
    mocks.executionFindFirst.mockResolvedValue({ status: "paused" })
    mocks.startRecovery.mockResolvedValue({ kind: "created", automation: {
      id: "automation_1", name: "Weekday Berlin SWE Scout", enabled: true, cron: "0 9 * * 1-5",
      timezone: "Europe/Berlin", triggerType: "weekdays", targetRoles: ["SWE"], targetLocations: ["Berlin"],
      minScore: 85, dailyCap: 8, requireApproval: true, autoApply: false, sessionId: "session_1",
    }, session: existing, turnId: "turn_recovery", executionId: "execution_1", dispatchId: "dispatch_1",
    snapshot: { schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1", targetRoles: ["SWE"],
      targetLocations: ["Berlin"], minScore: 85, dailyCap: 8, requireApproval: true, autoApply: false } })
    const { POST } = await import("./route")

    const res = await POST(postRequest({ materialDriftRecovery: { turnId: "forged" } }) as never, ctx())

    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body).toMatchObject({ executionId: "execution_1", turnId: "turn_recovery",
      dispatchId: "dispatch_1", turnStatus: "queued" })
    expect(body.session).toEqual(expectedSessionResponse())
    expect(body.session).not.toHaveProperty("userId")
    expect(body.session).not.toHaveProperty("eventSequence")
    expect(body.session).not.toHaveProperty("internalAccessToken")
    expect(mocks.startRecovery).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      automationId: "automation_1", userId: "user_1", sessionId: "session_1", now: expect.any(Date),
    }))
    expect(mocks.ensureExecution).not.toHaveBeenCalled()
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled()
    expect(mocks.executionUpdate).not.toHaveBeenCalled()
    expect(mocks.sessionUpdateMany).not.toHaveBeenCalled()
    expect(mocks.turnCreate).not.toHaveBeenCalled()
    expect(mocks.executionFindFirst).not.toHaveBeenCalled()
  })

  it("replays the committed Turn and outbox when Run Now is repeated", async () => {
    mocks.automationFindFirst.mockResolvedValue(recoveryAutomation())
    mocks.startRecovery.mockResolvedValueOnce(createdRecovery()).mockResolvedValueOnce(existingRecovery("in_progress"))
    mocks.transcriptCreate.mockRejectedValueOnce(new Error("event store unavailable"))
    const { POST } = await import("./route")

    const first = await POST(postRequest() as never, ctx())
    const second = await POST(postRequest() as never, ctx())

    expect(first.status).toBe(202)
    const firstBody = await first.json()
    expect(firstBody).toMatchObject({ turnId: "turn_recovery", dispatchId: "dispatch_1", turnStatus: "queued", event: null })
    expect(firstBody.session).toEqual(expectedSessionResponse())
    expect(firstBody.session).not.toHaveProperty("userId")
    expect(firstBody.session).not.toHaveProperty("eventSequence")
    expect(second.status).toBe(202)
    const secondBody = await second.json()
    expect(secondBody).toMatchObject({ turnId: "turn_recovery", dispatchId: "dispatch_1", turnStatus: "in_progress" })
    expect(secondBody.session).toEqual(expectedSessionResponse())
    expect(secondBody.session).not.toHaveProperty("userId")
    expect(secondBody.session).not.toHaveProperty("eventSequence")
    expect(mocks.startRecovery).toHaveBeenCalledTimes(2)
    expect(mocks.transcriptCreate).toHaveBeenCalledOnce()
    expect(mocks.ensureExecution).not.toHaveBeenCalled()
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled()
    expect(mocks.executionUpdate).not.toHaveBeenCalled()
    expect(mocks.turnCreate).not.toHaveBeenCalled()
  })

  it("returns queued recovery success if the post-commit dual-write session fails", async () => {
    mocks.automationFindFirst.mockResolvedValue(recoveryAutomation())
    mocks.startRecovery.mockResolvedValueOnce(createdRecovery())
    mocks.runtimeFeatureEnabled.mockResolvedValue(true)
    mocks.createDualWrite.mockRejectedValueOnce(new Error("dual-write unavailable"))
    const { POST } = await import("./route")

    const res = await POST(postRequest() as never, ctx())

    expect(res.status).toBe(202)
    await expect(res.json()).resolves.toMatchObject({ turnId: "turn_recovery", dispatchId: "dispatch_1", turnStatus: "queued", event: null })
    expect(mocks.transcriptCreate).not.toHaveBeenCalled()
    expect(mocks.ensureExecution).not.toHaveBeenCalled()
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled()
  })

  it("fails closed instead of starting a generic run for unverifiable drift evidence", async () => {
    mocks.automationFindFirst.mockResolvedValue(recoveryAutomation())
    mocks.executionFindFirst.mockResolvedValueOnce({ status: "paused" })
    mocks.startRecovery.mockResolvedValueOnce({ kind: "rejected" })
    const { POST } = await import("./route")

    const res = await POST(postRequest() as never, ctx())

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: "Automation recovery could not be verified" })
    expect(mocks.executionFindFirst).not.toHaveBeenCalled()
    expect(mocks.automationUpdateMany).not.toHaveBeenCalled()
    expect(mocks.ensureExecution).not.toHaveBeenCalled()
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled()
  })

  it("keeps paused ordinary Run Now blocked when no recovery lineage is verified", async () => {
    mocks.automationFindFirst.mockResolvedValue(recoveryAutomation())
    mocks.executionFindFirst.mockResolvedValueOnce({ status: "paused" })
    const { POST } = await import("./route")

    const res = await POST(postRequest() as never, ctx())

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: "Automation is already running" })
    expect(mocks.startRecovery).toHaveBeenCalledOnce()
    expect(mocks.automationUpdateMany).not.toHaveBeenCalled()
    expect(mocks.ensureExecution).not.toHaveBeenCalled()
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled()
  })

  it("starts a fresh ordinary Turn after recovery is completed", async () => {
    mocks.automationFindFirst.mockResolvedValue(recoveryAutomation())
    mocks.executionFindFirst.mockResolvedValueOnce({ status: "completed" })
    mocks.sessionFindFirst.mockResolvedValue(recoverySession())
    mocks.turnFindFirst.mockResolvedValue(null)
    const { POST } = await import("./route")

    const res = await POST(postRequest() as never, ctx())

    expect(res.status).toBe(201)
    expect(mocks.ensureExecution).toHaveBeenCalledWith({ userId: "user_1", sessionId: "session_1", autonomous: true, restartForRun: true })
    expect(mocks.enqueueAgentRun).toHaveBeenCalledWith({ userId: "user_1", sessionId: "session_1", turnId: "turn_1", executionId: "execution_1" })
    expect(mocks.turnCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ input: expect.objectContaining({ goal: "Run automation: Weekday Berlin SWE Scout", automationRunMode: "manual" }) }),
    }))
    expect(mocks.turnCreate.mock.calls[0]?.[0]?.data.input).not.toHaveProperty("materialDriftRecovery")
    expect(mocks.executionUpdate).toHaveBeenCalled()
  })

  it("does not queue a second run while the canonical execution is active", async () => {
    mocks.automationFindFirst.mockResolvedValueOnce({
      id: "automation_1", name: "Weekday Berlin SWE Scout", enabled: true, cron: null,
      timezone: "Europe/Berlin", triggerType: "manual", targetRoles: ["SWE"], targetLocations: [],
      minScore: 85, dailyCap: 8, requireApproval: true, autoApply: true, sessionId: "session_1",
    })
    mocks.executionFindFirst.mockResolvedValueOnce({ status: "running" })
    const { POST } = await import("./route")

    const res = await POST(postRequest() as never, ctx())

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: "Automation is already running" })
    expect(mocks.automationUpdateMany).not.toHaveBeenCalled()
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled()
  })

  it("returns 409 without starting a paused automation", async () => {
    mocks.automationFindFirst.mockResolvedValueOnce({
      id: "automation_1",
      name: "Paused Scout",
      enabled: false,
      cron: "0 9 * * 1-5",
      timezone: "Europe/Berlin",
      triggerType: "weekdays",
      targetRoles: ["SWE"],
      targetLocations: ["Berlin"],
      minScore: 85,
      dailyCap: 8,
      requireApproval: true,
      autoApply: true,
    })
    const { POST } = await import("./route")

    const res = await POST(postRequest() as never, ctx())

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: "Automation is paused" })
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
    expect(mocks.transcriptCreate).not.toHaveBeenCalled()
    expect(mocks.automationUpdateMany).not.toHaveBeenCalled()
  })

  it("does not start a session if the automation is paused before claim", async () => {
    mocks.automationUpdateMany.mockResolvedValueOnce({ count: 0 })
    const { POST } = await import("./route")

    const res = await POST(postRequest() as never, ctx())

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: "Automation is paused" })
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
    expect(mocks.transcriptCreate).not.toHaveBeenCalled()
  })

  it("returns 409 and does not queue when a raced Turn is not automation-owned", async () => {
    mocks.turnFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    mocks.turnCreate.mockRejectedValueOnce({ code: "P2002" })
    const { POST } = await import("./route")

    const res = await POST(postRequest() as never, ctx())

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining("active Turn that cannot be reused") })
    expect(mocks.ensureExecution).not.toHaveBeenCalled()
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled()
    expect(mocks.turnFindFirst).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ userId: "user_1", sessionId: "session_1", source: "automation" }),
    }))
  })
})
