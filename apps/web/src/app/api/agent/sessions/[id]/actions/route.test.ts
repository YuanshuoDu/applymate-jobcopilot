import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  sessionFindFirst: vi.fn(),
  sessionUpdate: vi.fn(),
  approvalFindFirst: vi.fn(),
  approvalUpdateMany: vi.fn(),
  approvalCreate: vi.fn(),
  automationFindFirst: vi.fn(),
  automationCreate: vi.fn(),
  automationUpdate: vi.fn(),
  transcriptCreate: vi.fn(),
  resumeFindFirst: vi.fn(),
  jobFindFirst: vi.fn(),
  jobUpdate: vi.fn(),
  tailorResumeForAgent: vi.fn(),
  loadUserAiConfig: vi.fn(),
  enqueueApplyTask: vi.fn(),
}))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (val: unknown) => val instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

vi.mock("@/lib/db", () => ({
  db: {
    agentSession: { findFirst: mocks.sessionFindFirst, update: mocks.sessionUpdate },
    agentApproval: { findFirst: mocks.approvalFindFirst, updateMany: mocks.approvalUpdateMany, create: mocks.approvalCreate },
    agentAutomation: {
      findFirst: mocks.automationFindFirst,
      create: mocks.automationCreate,
      update: mocks.automationUpdate,
    },
    agentTranscriptEvent: { create: mocks.transcriptCreate },
    resume: { findFirst: mocks.resumeFindFirst },
    job: { findFirst: mocks.jobFindFirst, update: mocks.jobUpdate },
  },
}))

vi.mock("@/lib/model-router", () => ({ loadUserAiConfig: mocks.loadUserAiConfig }))
vi.mock("@/lib/agent/resume-tailoring", () => ({ tailorResumeForAgent: mocks.tailorResumeForAgent }))
vi.mock("@/lib/apply-queue-client", () => ({ enqueueApplyTask: mocks.enqueueApplyTask }))

function postRequest(body: unknown) {
  return new Request("http://localhost/api/agent/sessions/session_1/actions", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

const ctx = { params: Promise.resolve({ id: "session_1" }) }

describe("agent session actions API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.sessionFindFirst.mockReset()
    mocks.sessionUpdate.mockReset()
    mocks.approvalFindFirst.mockReset()
    mocks.approvalUpdateMany.mockReset()
    mocks.approvalCreate.mockReset()
    mocks.automationFindFirst.mockReset()
    mocks.automationCreate.mockReset()
    mocks.automationUpdate.mockReset()
    mocks.transcriptCreate.mockReset()
    mocks.resumeFindFirst.mockReset()
    mocks.jobFindFirst.mockReset()
    mocks.jobUpdate.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.sessionFindFirst.mockResolvedValue({ id: "session_1" })
    mocks.sessionUpdate.mockResolvedValue({})
    mocks.approvalFindFirst.mockResolvedValue({ type: 'apply_jobs', payload: {} })
    mocks.approvalUpdateMany.mockResolvedValue({ count: 1 })
    mocks.approvalCreate.mockResolvedValue({ id: 'approval_review', type: 'confirm_tailored_resume', title: 'Confirm tailored resume', body: 'Review it', impact: {}, payload: {}, status: 'pending' })
    mocks.loadUserAiConfig.mockResolvedValue({ provider: 'openai', model: 'test' })
    mocks.tailorResumeForAgent.mockResolvedValue({ id: 'resume_tailored', name: 'Tailored for N26', jobId: 'job_1', company: 'N26', role: 'Backend Engineer', reused: false })
    mocks.enqueueApplyTask.mockResolvedValue('apply_task_1')
    mocks.automationFindFirst.mockResolvedValue(null)
    mocks.transcriptCreate.mockResolvedValue({
      id: "event_1",
      sessionId: "session_1",
      taskId: null,
      type: "approval_response",
      speaker: "You",
      title: "Approved",
      body: "Approved application submission",
      data: { decision: "approved" },
      durationMs: null,
      createdAt: new Date("2026-06-18T10:00:00Z"),
    })
  })

  it("creates an automation from a transcript draft action", async () => {
    mocks.automationCreate.mockResolvedValueOnce({
      id: "automation_1",
      name: "Weekday Berlin SWE Scout",
    })
    mocks.transcriptCreate.mockResolvedValueOnce({
      id: "event_2",
      sessionId: "session_1",
      taskId: null,
      type: "automation_created",
      speaker: "Orchestrator",
      title: "Automation created",
      body: "Created automation: Weekday Berlin SWE Scout",
      data: { automationId: "automation_1" },
      durationMs: null,
      createdAt: new Date("2026-06-18T10:05:00Z"),
    })
    const { POST } = await import("./route")

    const res = await POST(postRequest({
      type: "create_automation",
      draft: {
        name: "  Weekday Berlin SWE Scout  ",
        triggerType: "weekdays",
        cron: "0 9 * * 1-5",
        timezone: "Europe/Berlin",
        targetRoles: [" Software Engineer "],
        targetLocations: [" Berlin "],
        minScore: 85,
        dailyCap: 8,
        requireApproval: true,
        autoApply: true,
      },
    }) as never, ctx)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      event: {
        id: "event_2",
        type: "automation_created",
        createdAt: "2026-06-18T10:05:00.000Z",
      },
      automation: {
        id: "automation_1",
        name: "Weekday Berlin SWE Scout",
      },
    })
    expect(mocks.automationCreate).toHaveBeenCalledWith({
      data: {
        userId: "user_1",
        name: "Weekday Berlin SWE Scout",
        enabled: true,
        triggerType: "weekdays",
        cron: "0 9 * * 1-5",
        timezone: "Europe/Berlin",
        targetRoles: ["Software Engineer"],
        targetLocations: ["Berlin"],
        minScore: 85,
        dailyCap: 8,
        requireApproval: true,
        autoApply: true,
        createdBy: "agent",
        nextRunAt: expect.any(Date),
      },
    })
    expect(mocks.transcriptCreate).toHaveBeenCalledWith({
      data: {
        sessionId: "session_1",
        taskId: null,
        type: "automation_created",
        speaker: "Orchestrator",
        title: "Automation created",
        body: "Created automation: Weekday Berlin SWE Scout",
        data: {
          automationId: "automation_1",
          draft: {
            name: "Weekday Berlin SWE Scout",
            triggerType: "weekdays",
            cron: "0 9 * * 1-5",
            timezone: "Europe/Berlin",
            targetRoles: ["Software Engineer"],
            targetLocations: ["Berlin"],
            minScore: 85,
            dailyCap: 8,
            requireApproval: true,
            autoApply: true,
          },
          mode: "created_new",
        },
        durationMs: null,
      },
    })
  })

  it("updates an existing same-name automation from a transcript draft action", async () => {
    mocks.automationFindFirst.mockResolvedValueOnce({ id: "automation_1" })
    mocks.automationUpdate.mockResolvedValueOnce({
      id: "automation_1",
      name: "Weekday Berlin SWE Scout",
    })
    mocks.transcriptCreate.mockResolvedValueOnce({
      id: "event_3",
      sessionId: "session_1",
      taskId: null,
      type: "automation_updated",
      speaker: "Orchestrator",
      title: "Automation updated",
      body: "Updated automation: Weekday Berlin SWE Scout",
      data: { automationId: "automation_1", mode: "updated_existing" },
      durationMs: null,
      createdAt: new Date("2026-06-18T10:06:00Z"),
    })
    const { POST } = await import("./route")

    const res = await POST(postRequest({
      type: "create_automation",
      draft: {
        name: "Weekday Berlin SWE Scout",
        triggerType: "daily",
        cron: "0 8 * * *",
        timezone: "Europe/Berlin",
        targetRoles: ["SWE"],
        targetLocations: ["Berlin"],
        minScore: 90,
        dailyCap: 4,
        requireApproval: true,
        autoApply: false,
      },
    }) as never, ctx)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      event: { type: "automation_updated" },
      automation: { id: "automation_1" },
    })
    expect(mocks.automationCreate).not.toHaveBeenCalled()
    expect(mocks.automationUpdate).toHaveBeenCalledWith({
      where: { id: "automation_1" },
      data: expect.objectContaining({
        userId: "user_1",
        name: "Weekday Berlin SWE Scout",
        triggerType: "daily",
        minScore: 90,
        dailyCap: 4,
        createdBy: "agent",
      }),
    })
    expect(mocks.transcriptCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "automation_updated",
        title: "Automation updated",
        body: "Updated automation: Weekday Berlin SWE Scout",
        data: expect.objectContaining({
          automationId: "automation_1",
          mode: "updated_existing",
        }),
      }),
    })
  })

  it("records an approval response and updates the approval when approvalId is provided", async () => {
    const { POST } = await import("./route")

    const res = await POST(postRequest({
      type: "approval_response",
      approvalId: "approval_1",
      decision: "approved",
      body: "Approved application submission",
    }) as never, ctx)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      event: {
        id: "event_1",
        type: "approval_response",
        createdAt: "2026-06-18T10:00:00.000Z",
      },
    })
    expect(mocks.sessionFindFirst).toHaveBeenCalledWith({
      where: { id: "session_1", userId: "user_1" },
      select: { id: true },
    })
    expect(mocks.approvalUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "approval_1",
        sessionId: "session_1",
        userId: "user_1",
        status: "pending",
      },
      data: {
        status: "approved",
        decidedAt: expect.any(Date),
      },
    })
    expect(mocks.transcriptCreate).toHaveBeenCalledWith({
      data: {
        sessionId: "session_1",
        taskId: null,
        type: "approval_response",
        speaker: "You",
        title: "Approved",
        body: "Approved application submission",
        data: {
          approvalId: "approval_1",
          decision: "approved",
        },
        durationMs: null,
      },
    })
    expect(mocks.sessionUpdate).toHaveBeenCalledWith({
      where: { id: "session_1" },
      data: {
        status: "completed",
        completedAt: expect.any(Date),
      },
    })
  })

  it("rejects stale approval responses without writing transcript events", async () => {
    mocks.approvalUpdateMany.mockResolvedValueOnce({ count: 0 })
    const { POST } = await import("./route")

    const res = await POST(postRequest({
      type: "approval_response",
      approvalId: "approval_1",
      decision: "approved",
      body: "Approved application submission",
    }) as never, ctx)

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: "Approval is no longer pending" })
    expect(mocks.transcriptCreate).not.toHaveBeenCalled()
  })

  it('turns approved Writer tailoring into a resume artifact and a separate Reviewer gate', async () => {
    mocks.approvalFindFirst.mockResolvedValueOnce({ type: 'tailor_resume', payload: { resumeId: 'resume_1', jobId: 'job_1' } })
    mocks.transcriptCreate
      .mockResolvedValueOnce({ id: 'event_tailored', sessionId: 'session_1', taskId: null, type: 'resume_tailored', speaker: 'Writer', title: 'Tailored resume ready', body: 'Ready', data: {}, durationMs: null, createdAt: new Date('2026-06-18T10:01:00Z') })
      .mockResolvedValueOnce({ id: 'event_review', sessionId: 'session_1', taskId: null, type: 'approval_request', speaker: 'Reviewer', title: 'Final resume review', body: 'Review it', data: {}, durationMs: null, createdAt: new Date('2026-06-18T10:02:00Z') })
    const { POST } = await import('./route')

    const res = await POST(postRequest({ type: 'approval_response', approvalId: 'approval_writer', decision: 'approved' }) as never, ctx)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ events: [{ type: 'resume_tailored' }, { type: 'approval_request' }] })
    expect(mocks.tailorResumeForAgent).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user_1', resumeId: 'resume_1', jobId: 'job_1' }))
    expect(mocks.approvalCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'confirm_tailored_resume', sessionId: 'session_1' }) })
    expect(mocks.sessionUpdate).toHaveBeenCalledWith({ where: { id: 'session_1' }, data: { status: 'waiting_for_user', completedAt: null } })
  })

  it('queues Executor only after the Reviewer confirmation binds the final resume', async () => {
    mocks.approvalFindFirst.mockResolvedValueOnce({ type: 'confirm_tailored_resume', payload: { resumeId: 'resume_tailored', jobId: 'job_1' } })
    mocks.resumeFindFirst.mockResolvedValueOnce({ id: 'resume_tailored', name: 'Tailored for N26' })
    mocks.jobFindFirst.mockResolvedValueOnce({ id: 'job_1', company: 'N26', role: 'Backend Engineer', url: 'https://jobs.example/apply', status: 'review' })
    mocks.jobUpdate.mockResolvedValue({})
    mocks.transcriptCreate.mockResolvedValueOnce({ id: 'event_queued', sessionId: 'session_1', taskId: null, type: 'application_queued', speaker: 'Executor', title: 'Application queued', body: 'Queued', data: {}, durationMs: null, createdAt: new Date('2026-06-18T10:03:00Z') })
    const { POST } = await import('./route')

    const res = await POST(postRequest({ type: 'approval_response', approvalId: 'approval_reviewer', decision: 'approved' }) as never, ctx)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ event: { type: 'application_queued' } })
    expect(mocks.enqueueApplyTask).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job_1', userId: 'user_1', applyUrl: 'https://jobs.example/apply', dryRun: false }))
    expect(mocks.jobUpdate).toHaveBeenCalledWith({ where: { id: 'job_1' }, data: expect.objectContaining({ finalResumeId: 'resume_tailored', status: 'review' }) })
  })

  it("rejects unsupported action types", async () => {
    const { POST } = await import("./route")

    const res = await POST(postRequest({ type: "unknown" }) as never, ctx)

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: "Unsupported action type" })
  })

  it("returns 404 when the session is not owned by the user", async () => {
    mocks.sessionFindFirst.mockResolvedValueOnce(null)
    const { POST } = await import("./route")

    const res = await POST(postRequest({ type: "approval_response", decision: "rejected" }) as never, ctx)

    expect(res.status).toBe(404)
    expect(mocks.transcriptCreate).not.toHaveBeenCalled()
  })
})
