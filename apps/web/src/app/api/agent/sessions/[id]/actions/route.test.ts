import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  sessionFindFirst: vi.fn(),
  sessionUpdate: vi.fn(),
  approvalFindFirst: vi.fn(),
  approvalUpdateMany: vi.fn(),
  approvalCreate: vi.fn(),
  agentTurnUpdate: vi.fn(),
  resolveLegacyApproval: vi.fn(),
  validateLegacyReceipt: vi.fn(),
  consumeLegacyReceipt: vi.fn(),
  issueLegacyReceipt: vi.fn(),
  clientReceipt: vi.fn(),
  ensureV2Turn: vi.fn(),
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
  isFeatureAllowed: vi.fn(),
  resolveAiAccess: vi.fn(),
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
    agentTurn: { update: mocks.agentTurnUpdate, findFirst: vi.fn() },
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
vi.mock("@/lib/entitlements", () => ({ isFeatureAllowed: mocks.isFeatureAllowed, resolveAiAccess: mocks.resolveAiAccess }))
vi.mock("@/lib/agent/resume-tailoring", () => ({ tailorResumeForAgent: mocks.tailorResumeForAgent }))
vi.mock("@/lib/apply-queue-client", () => ({ enqueueApplyTask: mocks.enqueueApplyTask }))
vi.mock("@/lib/agent/approval/legacy-receipt", () => ({
  clientReceipt: mocks.clientReceipt,
  consumeLegacyReceipt: mocks.consumeLegacyReceipt,
  issueLegacyReceipt: mocks.issueLegacyReceipt,
  resolveLegacyApproval: mocks.resolveLegacyApproval,
  validateLegacyReceipt: mocks.validateLegacyReceipt,
}))
vi.mock("@/lib/agent/session/v2-turn", () => ({ ensureV2Turn: mocks.ensureV2Turn }))
vi.mock("@/lib/agent/policy/legacy", () => ({ requireLegacyPolicy: vi.fn() }))

function postRequest(body: unknown) {
  return new Request("http://localhost/api/agent/sessions/session_1/actions", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

function approvalRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval_1",
    type: "apply_jobs",
    payload: { applicationTaskId: "task_1", jobId: "job_1" },
    turnId: "turn_1",
    toolCallId: "call_1",
    jobId: "job_1",
    revision: 0,
    expiresAt: new Date(Date.now() + 60_000),
    resourceHash: "a".repeat(64),
    materialHash: "b".repeat(64),
    answersHash: "c".repeat(64),
    ...overrides,
  }
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
    mocks.agentTurnUpdate.mockReset()
    mocks.resolveLegacyApproval.mockReset()
    mocks.validateLegacyReceipt.mockReset()
    mocks.consumeLegacyReceipt.mockReset()
    mocks.issueLegacyReceipt.mockReset()
    mocks.clientReceipt.mockReset()
    mocks.ensureV2Turn.mockReset()
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
    mocks.approvalFindFirst.mockResolvedValue(approvalRecord())
    mocks.approvalUpdateMany.mockResolvedValue({ count: 1 })
    mocks.approvalCreate.mockResolvedValue({ id: 'approval_review', type: 'confirm_tailored_resume', title: 'Confirm tailored resume', body: 'Review it', impact: {}, payload: {}, status: 'pending' })
    mocks.agentTurnUpdate.mockResolvedValue({})
    mocks.resolveLegacyApproval.mockResolvedValue(undefined)
    mocks.validateLegacyReceipt.mockResolvedValue({})
    mocks.consumeLegacyReceipt.mockResolvedValue({ approvalId: "approval_1", reservationId: null, consumedAt: new Date() })
    mocks.issueLegacyReceipt.mockResolvedValue({
      approval: { id: "approval_review", type: "confirm_tailored_resume", title: "Final resume review", body: "Review it" },
      nonce: "nonce_1",
    })
    mocks.clientReceipt.mockImplementation((result: { approval: object; nonce: string }) => ({ ...result.approval, receiptNonce: result.nonce }))
    mocks.ensureV2Turn.mockResolvedValue({ sessionId: "session_1", turnId: "turn_1", revision: 0 })
    mocks.loadUserAiConfig.mockResolvedValue({ provider: 'openai', model: 'test' })
    mocks.tailorResumeForAgent.mockResolvedValue({ id: 'resume_tailored', name: 'Tailored for N26', jobId: 'job_1', company: 'N26', role: 'Backend Engineer', reused: false })
    mocks.enqueueApplyTask.mockResolvedValue('apply_task_1')
    mocks.isFeatureAllowed.mockReset()
    mocks.resolveAiAccess.mockReset()
    mocks.isFeatureAllowed.mockResolvedValue(true)
    mocks.resolveAiAccess.mockResolvedValue('allowed')
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
    mocks.approvalFindFirst.mockResolvedValueOnce(approvalRecord({
      id: "automation_approval",
      type: "automation_mutation",
      payload: { draft: { name: "Weekday Berlin SWE Scout" } },
    }))
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
      approvalId: "automation_approval",
      receiptNonce: "nonce_1",
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
            autoApply: true,
            cron: "0 9 * * 1-5",
            dailyCap: 8,
            minScore: 85,
            name: "Weekday Berlin SWE Scout",
            requireApproval: true,
            targetLocations: ["Berlin"],
            targetRoles: ["Software Engineer"],
            timezone: "Europe/Berlin",
            triggerType: "weekdays",
          },
          mode: "created_new",
        },
        durationMs: null,
      },
    })
  })

  it("updates an existing same-name automation from a transcript draft action", async () => {
    mocks.approvalFindFirst.mockResolvedValueOnce(approvalRecord({
      id: "automation_approval",
      type: "automation_mutation",
      payload: { draft: { name: "Weekday Berlin SWE Scout" } },
    }))
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
      approvalId: "automation_approval",
      receiptNonce: "nonce_1",
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
      receiptNonce: "nonce_1",
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
    expect(mocks.resolveLegacyApproval).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      approval: expect.objectContaining({ id: "approval_1" }),
      decision: "approved",
    }))
    expect(mocks.consumeLegacyReceipt).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      approvalId: "approval_1",
      nonce: "nonce_1",
    }))
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
    mocks.resolveLegacyApproval.mockRejectedValueOnce(new Error("Approval is no longer pending"))
    const { POST } = await import("./route")

    const res = await POST(postRequest({
      type: "approval_response",
      approvalId: "approval_1",
      decision: "approved",
      receiptNonce: "nonce_1",
      body: "Approved application submission",
    }) as never, ctx)

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: "Approval is no longer pending" })
    expect(mocks.transcriptCreate).not.toHaveBeenCalled()
  })

  it('turns approved Writer tailoring into a resume artifact and a separate Reviewer gate', async () => {
    mocks.approvalFindFirst.mockResolvedValueOnce(approvalRecord({ type: 'tailor_resume', payload: { resumeId: 'resume_1', jobId: 'job_1' } }))
    mocks.transcriptCreate
      .mockResolvedValueOnce({ id: 'event_tailored', sessionId: 'session_1', taskId: null, type: 'resume_tailored', speaker: 'Writer', title: 'Tailored resume ready', body: 'Ready', data: {}, durationMs: null, createdAt: new Date('2026-06-18T10:01:00Z') })
      .mockResolvedValueOnce({ id: 'event_review', sessionId: 'session_1', taskId: null, type: 'approval_request', speaker: 'Reviewer', title: 'Final resume review', body: 'Review it', data: {}, durationMs: null, createdAt: new Date('2026-06-18T10:02:00Z') })
    const { POST } = await import('./route')

    const res = await POST(postRequest({ type: 'approval_response', approvalId: 'approval_writer', decision: 'approved', receiptNonce: 'nonce_1' }) as never, ctx)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ events: [{ type: 'resume_tailored' }, { type: 'approval_request' }] })
    expect(mocks.tailorResumeForAgent).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user_1', resumeId: 'resume_1', jobId: 'job_1' }))
    expect(mocks.issueLegacyReceipt).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'confirm_tailored_resume', sessionId: 'session_1' }))
    expect(mocks.sessionUpdate).toHaveBeenCalledWith({ where: { id: 'session_1' }, data: { status: 'waiting_for_user', completedAt: null } })
  })

  it('does not tailor a resume when AI credits are disabled', async () => {
    mocks.resolveAiAccess.mockResolvedValueOnce('disabled')
    mocks.tailorResumeForAgent.mockClear()
    mocks.approvalFindFirst.mockResolvedValueOnce(approvalRecord({ type: 'tailor_resume', payload: { resumeId: 'resume_1', jobId: 'job_1' } }))
    const { POST } = await import('./route')

    const res = await POST(postRequest({ type: 'approval_response', approvalId: 'approval_writer', decision: 'approved', receiptNonce: 'nonce_1' }) as never, ctx)

    expect(res.status).toBe(403)
    expect(mocks.tailorResumeForAgent).not.toHaveBeenCalled()
  })

  it('does not tailor a resume when the tailored-resume entitlement is disabled', async () => {
    mocks.isFeatureAllowed.mockResolvedValueOnce(false)
    mocks.tailorResumeForAgent.mockClear()
    mocks.approvalFindFirst.mockResolvedValueOnce(approvalRecord({ type: 'tailor_resume', payload: { resumeId: 'resume_1', jobId: 'job_1' } }))
    const { POST } = await import('./route')

    const res = await POST(postRequest({ type: 'approval_response', approvalId: 'approval_writer', decision: 'approved', receiptNonce: 'nonce_1' }) as never, ctx)

    expect(res.status).toBe(403)
    expect(mocks.resolveAiAccess).not.toHaveBeenCalled()
    expect(mocks.tailorResumeForAgent).not.toHaveBeenCalled()
  })

  it('does not tailor a resume when monthly AI credits are exhausted', async () => {
    mocks.isFeatureAllowed.mockResolvedValueOnce(true)
    mocks.resolveAiAccess.mockResolvedValueOnce('exhausted')
    mocks.tailorResumeForAgent.mockClear()
    mocks.approvalFindFirst.mockResolvedValueOnce(approvalRecord({ type: 'tailor_resume', payload: { resumeId: 'resume_1', jobId: 'job_1' } }))
    const { POST } = await import('./route')

    const res = await POST(postRequest({ type: 'approval_response', approvalId: 'approval_writer', decision: 'approved', receiptNonce: 'nonce_1' }) as never, ctx)

    expect(res.status).toBe(429)
    expect(mocks.tailorResumeForAgent).not.toHaveBeenCalled()
  })

  it('prepares the assisted application only after the Reviewer confirmation binds the final resume', async () => {
    mocks.approvalFindFirst.mockResolvedValueOnce(approvalRecord({ type: 'confirm_tailored_resume', payload: { resumeId: 'resume_tailored', jobId: 'job_1' } }))
    mocks.resumeFindFirst.mockResolvedValueOnce({ id: 'resume_tailored', name: 'Tailored for N26' })
    mocks.jobFindFirst.mockResolvedValueOnce({ id: 'job_1', company: 'N26', role: 'Backend Engineer', url: 'https://jobs.example/apply', status: 'saved' })
    mocks.jobUpdate.mockResolvedValue({})
    mocks.transcriptCreate.mockResolvedValueOnce({ id: 'event_ready', sessionId: 'session_1', taskId: null, type: 'resume_finalized', speaker: 'Reviewer', title: 'Application pack ready', body: 'Ready', data: {}, durationMs: null, createdAt: new Date('2026-06-18T10:03:00Z') })
    const { POST } = await import('./route')

    const res = await POST(postRequest({ type: 'approval_response', approvalId: 'approval_reviewer', decision: 'approved', receiptNonce: 'nonce_1' }) as never, ctx)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ event: { type: 'resume_finalized', title: 'Application pack ready' } })
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled()
    expect(mocks.jobUpdate).toHaveBeenCalledWith({ where: { id: 'job_1' }, data: expect.objectContaining({
      finalResumeId: 'resume_tailored', status: 'saved', workflowState: 'ready_to_apply', analysisNote: expect.stringContaining('extension'),
    }) })
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
