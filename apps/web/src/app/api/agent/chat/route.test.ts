import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  prepareAiRoute: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  sessionFindFirst: vi.fn(),
  sessionCreate: vi.fn(),
  sessionUpdate: vi.fn(),
  transcriptCreate: vi.fn(),
  transcriptFindMany: vi.fn(),
  approvalCreate: vi.fn(),
  taskCreate: vi.fn(),
  taskUpdate: vi.fn(),
  createChatPlan: vi.fn(),
  runChatWorker: vi.fn(),
  synthesizeChatResult: vi.fn(),
  scoutResultMatchesRequest: vi.fn(),
  correctedScoutPlan: vi.fn(),
  requestsFullWorkflow: vi.fn(),
  requestedMinMatchScore: vi.fn(),
}))

vi.mock("@/lib/api-helpers", () => {
  return {
    prepareAiRoute: mocks.prepareAiRoute,
    sseResponse: (body: (emit: (event: string, data: unknown) => void) => Promise<void>) => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        async start(controller) {
          const emit = (event: string, data: unknown) => {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
          }
          await body(emit)
          controller.close()
        },
      })
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } })
    },
    isErrorResponse: (val: unknown) => val instanceof Response,
    err: (message: string, status = 400) => Response.json({ error: message }, { status }),
  }
})

vi.mock("@/lib/db", () => ({
  db: {
    agentConfig: { findUnique: mocks.findUnique },
    job: { findMany: mocks.findMany },
    resume: { findFirst: mocks.findFirst },
    activity: { findFirst: mocks.findFirst },
    agentSession: {
      findFirst: mocks.sessionFindFirst,
      create: mocks.sessionCreate,
      update: mocks.sessionUpdate,
    },
    agentTranscriptEvent: { create: mocks.transcriptCreate, findMany: mocks.transcriptFindMany },
    agentApproval: { create: mocks.approvalCreate },
    subAgentTask: { create: mocks.taskCreate, update: mocks.taskUpdate },
  },
}))

vi.mock("@/lib/model-router", () => ({
  MODEL_CATALOGUE: [
    { provider: "test", model: "m1", label: "Default" },
    { provider: "openai", model: "gpt-test", label: "GPT Test" },
  ],
}))

vi.mock('./chat-orchestrator', () => ({
  createChatPlan: mocks.createChatPlan,
  runChatWorker: mocks.runChatWorker,
  synthesizeChatResult: mocks.synthesizeChatResult,
  scoutResultMatchesRequest: mocks.scoutResultMatchesRequest,
  correctedScoutPlan: mocks.correctedScoutPlan,
  requestsFullWorkflow: mocks.requestsFullWorkflow,
  requestedMinMatchScore: mocks.requestedMinMatchScore,
}))

function postRequest(body: unknown) {
  return new Request("http://localhost/api/agent/chat", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

async function readSse(res: Response) {
  return await res.text()
}

function expectResponse(res: Response | undefined): Response {
  if (!res) throw new Error("Expected route response")
  return res
}

describe("agent chat API session recording", () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.prepareAiRoute.mockResolvedValue({ userId: "user_1", cfg: { provider: "test", model: "m1" } })
    mocks.findUnique.mockResolvedValue(null)
    mocks.findMany.mockResolvedValue([])
    mocks.findFirst.mockResolvedValue(null)
    mocks.sessionCreate.mockResolvedValue({
      id: "session_1",
      goal: "Find Berlin jobs",
      status: "running",
      source: "chat",
      memorySummary: "",
      qualityScore: null,
      currentTaskId: null,
      createdAt: new Date("2026-06-18T08:00:00Z"),
      updatedAt: new Date("2026-06-18T08:00:00Z"),
      completedAt: null,
    })
    mocks.transcriptCreate.mockResolvedValue({})
    mocks.transcriptFindMany.mockResolvedValue([])
    mocks.sessionUpdate.mockResolvedValue({})
    mocks.approvalCreate.mockResolvedValue({ id: "approval_1" })
    mocks.taskCreate.mockResolvedValue({ id: 'task_1' })
    mocks.taskUpdate.mockResolvedValue({})
    mocks.createChatPlan.mockResolvedValue({ role: 'scout', goal: 'Find jobs', targetRoles: ['Engineer'], targetLocations: ['Berlin'] })
    mocks.runChatWorker.mockResolvedValue({ role: 'scout', summary: 'Found 1 live job.', result: { jobs: [{ company: 'N26', role: 'Engineer', score: null }] }, confidence: 0.9 })
    mocks.synthesizeChatResult.mockResolvedValue('Here is the structured result.')
    mocks.scoutResultMatchesRequest.mockReturnValue(true)
    mocks.correctedScoutPlan.mockImplementation((_message, plan) => plan)
    mocks.requestsFullWorkflow.mockReturnValue(false)
    mocks.requestedMinMatchScore.mockReturnValue(null)
  })

  it("creates a chat session and records user and assistant transcript events", async () => {
    const { POST } = await import("./route")

    const res = expectResponse(await POST(postRequest({ messages: [{ role: "user", content: "Find Berlin jobs" }] }) as never))
    const text = await readSse(res)

    expect(res.status).toBe(200)
    expect(text).toContain("event: session")
    expect(text).toContain("\"sessionId\":\"session_1\"")
    expect(text).toContain('Here is the structured result.')
    expect(mocks.sessionCreate).toHaveBeenCalledWith({
      data: {
        userId: "user_1",
        goal: "Find Berlin jobs",
        source: "chat",
        status: "running",
        memorySummary: "",
      },
    })
    expect(mocks.transcriptCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        sessionId: "session_1",
        type: "user_message",
        speaker: "You",
        body: "Find Berlin jobs",
      }),
    }))
    expect(mocks.transcriptCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        sessionId: "session_1",
        type: "orchestrator_plan",
        speaker: "Orchestrator",
        body: 'Here is the structured result.',
      }),
    }))
    expect(mocks.sessionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "session_1" },
      data: expect.objectContaining({
        status: "completed",
        completedAt: expect.any(Date),
      }),
    }))
  })

  it("reuses an owned session when sessionId is provided", async () => {
    mocks.sessionFindFirst.mockResolvedValueOnce({ id: "session_existing" })
    const { POST } = await import("./route")

    const res = expectResponse(await POST(postRequest({
      sessionId: "session_existing",
      messages: [{ role: "user", content: "Continue" }],
    }) as never))

    expect(res.status).toBe(200)
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
    expect(mocks.sessionFindFirst).toHaveBeenCalledWith({
      where: { id: "session_existing", userId: "user_1" },
      select: { id: true },
    })
  })

  it("creates a single-role plan before dispatching the subagent", async () => {
    mocks.sessionFindFirst.mockResolvedValueOnce({ id: "session_existing" })
    mocks.transcriptFindMany.mockResolvedValueOnce([
      { type: "orchestrator_plan", title: "Response", body: "Previous answer" },
      { type: "user_message", title: "Message", body: "Previous question" },
    ])
    const { POST } = await import("./route")

    await readSse(expectResponse(await POST(postRequest({
      sessionId: "session_existing",
      messages: [{ role: "user", content: "Continue" }],
    }) as never)))

    expect(mocks.createChatPlan).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user_1',
      message: 'Continue',
      model: { provider: 'test', model: 'm1' },
    }))
    expect(mocks.runChatWorker).toHaveBeenCalledTimes(1)
  })

  it("uses a valid composer model override for the chat call", async () => {
    const { POST } = await import("./route")

    const res = expectResponse(await POST(postRequest({
      model: "openai::gpt-test",
      messages: [{ role: "user", content: "Use GPT" }],
    }) as never))

    expect(res.status).toBe(200)
    expect(mocks.createChatPlan).toHaveBeenCalledWith(expect.objectContaining({
      model: { provider: 'openai', model: 'gpt-test' },
    }))
  })

  it("does not emit or record unsupported action commands from model output", async () => {
    mocks.synthesizeChatResult.mockResolvedValueOnce('I can help.\nACTION:delete_everything')
    const { POST } = await import("./route")

    const res = expectResponse(await POST(postRequest({
      messages: [{ role: "user", content: "Do something risky" }],
    }) as never))
    const text = await readSse(res)

    expect(res.status).toBe(200)
    expect(text).not.toContain("event: action")
    expect(mocks.transcriptCreate).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        title: "Action",
      }),
    }))
  })

  it("emits a transcript error event when final synthesis fails", async () => {
    mocks.synthesizeChatResult.mockRejectedValueOnce(new Error('No API key for provider "anthropic".'))
    const { POST } = await import("./route")

    const res = expectResponse(await POST(postRequest({
      messages: [{ role: "user", content: "Explain workspace" }],
    }) as never))
    const text = await readSse(res)

    expect(res.status).toBe(200)
    expect(text).toContain("event: error")
    expect(text).toContain("No API key")
    expect(mocks.transcriptCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        sessionId: "session_1",
        type: "error",
        speaker: "System",
        title: "Chat failed",
        body: 'No API key for provider "anthropic".',
      }),
    }))
    expect(mocks.sessionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "session_1" },
      data: expect.objectContaining({
        status: "failed",
      }),
    }))
  })

  it("emits and records an automation draft block when the user asks to create automation", async () => {
    const { POST } = await import("./route")

    const res = expectResponse(await POST(postRequest({
      messages: [{ role: "user", content: "每天 9 点帮我找 Berlin SWE，85 分以上创建自动化" }],
    }) as never))
    const text = await readSse(res)

    expect(res.status).toBe(200)
    expect(text).toContain("event: block")
    expect(text).toContain("\"type\":\"automation_draft\"")
    expect(text).toContain("\"targetLocations\":[\"Berlin\"]")
    expect(text).toContain("\"minScore\":85")
    expect(mocks.transcriptCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        sessionId: "session_1",
        type: "automation_draft",
        speaker: "Orchestrator",
        title: "Automation draft",
        data: expect.objectContaining({
          draft: expect.objectContaining({
            name: "Berlin SWE automation",
            triggerType: "daily",
            targetRoles: ["SWE"],
            targetLocations: ["Berlin"],
            minScore: 85,
            requireApproval: true,
          }),
        }),
      }),
    }))
    expect(mocks.sessionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "session_1" },
      data: expect.objectContaining({
        status: "waiting_for_user",
        completedAt: null,
      }),
    }))
  })

  it('starts the full pipeline without dispatching a single specialist', async () => {
    mocks.requestsFullWorkflow.mockReturnValueOnce(true)
    mocks.requestedMinMatchScore.mockReturnValueOnce(65)
    const { POST } = await import('./route')

    const text = await readSse(expectResponse(await POST(postRequest({
      messages: [{ role: 'user', content: '开始完整工作流' }],
    }) as never)))

    expect(text).toContain('event: action')
    expect(text).toContain('"type":"start_run","minMatchScore":65')
    expect(text).toContain('Full workflow')
    expect(mocks.createChatPlan).not.toHaveBeenCalled()
    expect(mocks.runChatWorker).not.toHaveBeenCalled()
  })

  it("emits and records an approval request block for sensitive apply actions", async () => {
    mocks.findMany.mockResolvedValueOnce([
      { id: "job_1", company: "N26", role: "SWE", score: 94, status: "review" },
      { id: "job_2", company: "Spotify", role: "Backend Engineer", score: 88, status: "review" },
    ])
    const { POST } = await import("./route")

    const res = expectResponse(await POST(postRequest({
      messages: [{ role: "user", content: "批准投递 2 个职位" }],
    }) as never))
    const text = await readSse(res)

    expect(res.status).toBe(200)
    expect(text).toContain("event: block")
    expect(text).toContain("\"type\":\"approval_request\"")
    expect(text).toContain("\"id\":\"approval_1\"")
    expect(mocks.approvalCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionId: "session_1",
        userId: "user_1",
        type: "apply_jobs",
        status: "pending",
        title: "Approval required",
        impact: expect.objectContaining({
          applications: 2,
          coverLetters: 2,
          linkedinActions: false,
        }),
      }),
    })
    expect(mocks.transcriptCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        sessionId: "session_1",
        type: "approval_request",
        speaker: "Executor",
        data: expect.objectContaining({
          approval: expect.objectContaining({ id: "approval_1", type: "apply_jobs" }),
        }),
      }),
    }))
  })

  it("rejects a sessionId that is not owned by the user", async () => {
    mocks.sessionFindFirst.mockResolvedValueOnce(null)
    const { POST } = await import("./route")

    const res = expectResponse(await POST(postRequest({
      sessionId: "other_session",
      messages: [{ role: "user", content: "Continue" }],
    }) as never))

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: "Session not found" })
    expect(mocks.createChatPlan).not.toHaveBeenCalled()
  })
})
