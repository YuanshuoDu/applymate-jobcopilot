import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(), sessionFindFirst: vi.fn(), turnFindFirst: vi.fn(), executionFindFirst: vi.fn(), runAgentPipeline: vi.fn(),
  failLegacyTurnBeforeRun: vi.fn(), isStaleExactWorkerAttempt: vi.fn(),
  isFeatureAllowed: vi.fn(), resolveAiAccess: vi.fn(), hasEffectiveEntitlement: vi.fn(), loadUserAiConfig: vi.fn(),
}))

vi.mock("@/lib/db", () => ({ db: { user: { findUnique: mocks.userFindUnique }, agentSession: { findFirst: mocks.sessionFindFirst }, agentTurn: { findFirst: mocks.turnFindFirst }, agentExecution: { findFirst: mocks.executionFindFirst } } }))
vi.mock("@/lib/agent/run-service", () => ({ runAgentPipeline: mocks.runAgentPipeline }))
vi.mock("@/lib/agent/execution-control", () => ({
  failLegacyTurnBeforeRun: mocks.failLegacyTurnBeforeRun,
  isStaleExactWorkerAttempt: mocks.isStaleExactWorkerAttempt,
}))
vi.mock("@/lib/entitlements", () => ({ isFeatureAllowed: mocks.isFeatureAllowed, resolveAiAccess: mocks.resolveAiAccess, hasEffectiveEntitlement: mocks.hasEffectiveEntitlement }))
vi.mock("@/lib/model-router", () => ({ APPLYMATE_BACKING: {}, loadUserAiConfig: mocks.loadUserAiConfig, resolveConfig: vi.fn(() => ({ provider: "minimax", model: "default", apiKey: "key" })) }))
vi.mock("@/lib/api-helpers", () => ({ ok: (value: unknown) => Response.json(value), err: (message: string, status: number) => Response.json({ error: message }, { status }) }))

describe("internal agent-run compatibility route", () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    vi.stubEnv("AGENT_WORKER_SECRET", "secret")
    mocks.userFindUnique.mockResolvedValue({ accountStatus: "active" })
    mocks.sessionFindFirst.mockResolvedValue({ id: "session_1" })
    mocks.turnFindFirst.mockResolvedValue({ id: "turn_1", userId: "user_1", sessionId: "session_1", status: "in_progress" })
    mocks.executionFindFirst.mockResolvedValue({ id: "execution_1", userId: "user_1", sessionId: "session_1", state: { autonomous: true } })
    mocks.isFeatureAllowed.mockResolvedValue(true)
    mocks.resolveAiAccess.mockResolvedValue("enabled")
    mocks.hasEffectiveEntitlement.mockResolvedValue(true)
    mocks.loadUserAiConfig.mockResolvedValue({ resolvedKey: { provider: "minimax", model: "test", apiKey: "key" } })
    mocks.runAgentPipeline.mockResolvedValue({ processed: 1, failed: 0 })
    mocks.failLegacyTurnBeforeRun.mockResolvedValue(true)
    mocks.isStaleExactWorkerAttempt.mockReturnValue(false)
  })

  it("passes canonical Turn and execution identity to the legacy-compatible handler", async () => {
    const { POST } = await import("./route")
    const request = new Request("http://localhost/api/internal/agent-run", {
      method: "POST", headers: { "x-agent-worker-secret": "secret", "content-type": "application/json" },
      body: JSON.stringify({ userId: "user_1", sessionId: "session_1", turnId: "turn_1", executionId: "execution_1" }),
    })

    const response = await POST(request as never)
    expect(response.status).toBe(200)
    expect(mocks.turnFindFirst).toHaveBeenCalledWith({
      where: { id: "turn_1", sessionId: "session_1", userId: "user_1" },
      select: { id: true, status: true, userId: true, sessionId: true },
    })
    expect(mocks.executionFindFirst).toHaveBeenCalledWith({
      where: { id: "execution_1", userId: "user_1", sessionId: "session_1" },
      select: { id: true, state: true, userId: true, sessionId: true },
    })
    expect(mocks.runAgentPipeline).toHaveBeenCalledWith(expect.objectContaining({ userId: "user_1", sessionId: "session_1", turnId: "turn_1", executionId: "execution_1", autonomous: true, source: "automation" }))
  })

  it("forwards exact legacy Turn, question, worker task, and expected attempt identities", async () => {
    mocks.executionFindFirst.mockResolvedValueOnce({
      id: "execution_1", userId: "user_1", sessionId: "session_1", state: { autonomous: true },
      status: "queued", attemptCount: 7, workerTaskId: "dispatch-job-7",
      updatedAt: new Date("2026-09-26T12:00:00.000Z"),
    })
    const { POST } = await import("./route")
    const request = new Request("http://localhost/api/internal/agent-run", {
      method: "POST", headers: { "x-agent-worker-secret": "secret", "content-type": "application/json" },
      body: JSON.stringify({
        userId: "user_1", sessionId: "session_1", executionId: "execution_1",
        workerTaskId: "dispatch-job-7", expectedAttemptCount: 7,
        legacyTurnId: "turn_7", questionId: "agent-question:turn_7:legacy:q7",
      }),
    })

    const response = await POST(request as never)
    expect(response.status).toBe(200)
    expect(mocks.runAgentPipeline).toHaveBeenCalledWith(expect.objectContaining({
      executionId: "execution_1", workerTaskId: "dispatch-job-7", expectedAttemptCount: 7,
      legacyTurnId: "turn_7", questionId: "agent-question:turn_7:legacy:q7",
    }))
    expect(mocks.runAgentPipeline.mock.calls[0]?.[0].turnId).toBeUndefined()
  })

  it("fails closed when an execution dispatch omits the worker task or attempt token", async () => {
    const { POST } = await import("./route")
    const request = new Request("http://localhost/api/internal/agent-run", {
      method: "POST", headers: { "x-agent-worker-secret": "secret", "content-type": "application/json" },
      body: JSON.stringify({ userId: "user_1", sessionId: "session_1", executionId: "execution_1", questionId: "q1" }),
    })

    const response = await POST(request as never)
    expect(response.status).toBe(400)
    expect(mocks.runAgentPipeline).not.toHaveBeenCalled()
  })

  it.each([
    ["numeric string", "7"],
    ["negative count", -1],
    ["fractional count", 1.5],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects an invalid expectedAttemptCount (%s) before database access", async (_label, expectedAttemptCount) => {
    const { POST } = await import("./route")
    const request = new Request("http://localhost/api/internal/agent-run", {
      method: "POST", headers: { "x-agent-worker-secret": "secret", "content-type": "application/json" },
      body: JSON.stringify({
        userId: "user_1", sessionId: "session_1", executionId: "execution_1",
        workerTaskId: "dispatch-job-7", expectedAttemptCount, questionId: "question_1",
      }),
    })

    const response = await POST(request as never)
    expect(response.status).toBe(400)
    expect(mocks.userFindUnique).not.toHaveBeenCalled()
    expect(mocks.runAgentPipeline).not.toHaveBeenCalled()
  })

  it("requires the exact legacy Turn for a Turn-namespaced question", async () => {
    const { POST } = await import("./route")
    const request = new Request("http://localhost/api/internal/agent-run", {
      method: "POST", headers: { "x-agent-worker-secret": "secret", "content-type": "application/json" },
      body: JSON.stringify({
        userId: "user_1", sessionId: "session_1", executionId: "execution_1",
        workerTaskId: "dispatch-job-7", expectedAttemptCount: 7,
        questionId: "agent-question:turn_7:legacy:q7",
      }),
    })

    const response = await POST(request as never)
    expect(response.status).toBe(400)
    expect(mocks.runAgentPipeline).not.toHaveBeenCalled()
  })

  it("terminalizes only the exact answered legacy Turn on a terminal entitlement rejection", async () => {
    mocks.isFeatureAllowed.mockResolvedValueOnce(false)
    const { POST } = await import("./route")
    const request = new Request("http://localhost/api/internal/agent-run", {
      method: "POST", headers: { "x-agent-worker-secret": "secret", "content-type": "application/json" },
      body: JSON.stringify({
        userId: "user_1", sessionId: "session_1", executionId: "execution_1",
        workerTaskId: "dispatch-job-7", expectedAttemptCount: 7,
        legacyTurnId: "turn_7", questionId: "agent-question:turn_7:legacy:q7",
      }),
    })

    const response = await POST(request as never)
    expect(response.status).toBe(403)
    expect(mocks.failLegacyTurnBeforeRun).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_1", sessionId: "session_1", executionId: "execution_1",
      workerTaskId: "dispatch-job-7", expectedAttemptCount: 7,
      turnId: "turn_7", questionId: "agent-question:turn_7:legacy:q7",
    }))
    expect(mocks.runAgentPipeline).not.toHaveBeenCalled()
  })

  it("records a terminal 429 for the exact legacy Turn when AI access is exhausted", async () => {
    mocks.resolveAiAccess.mockResolvedValueOnce("exhausted")
    const { POST } = await import("./route")
    const request = new Request("http://localhost/api/internal/agent-run", {
      method: "POST", headers: { "x-agent-worker-secret": "secret", "content-type": "application/json" },
      body: JSON.stringify({
        userId: "user_1", sessionId: "session_1", executionId: "execution_1",
        workerTaskId: "dispatch-job-7", expectedAttemptCount: 7,
        legacyTurnId: "turn_7", questionId: "agent-question:turn_7:legacy:q7",
      }),
    })

    const response = await POST(request as never)
    expect(response.status).toBe(429)
    expect(mocks.failLegacyTurnBeforeRun).toHaveBeenCalledWith(expect.objectContaining({
      turnId: "turn_7", questionId: "agent-question:turn_7:legacy:q7",
      workerTaskId: "dispatch-job-7", expectedAttemptCount: 7,
    }))
  })

  it("rejects a stale task identity before asking the pipeline to claim it", async () => {
    mocks.executionFindFirst.mockResolvedValueOnce({
      id: "execution_1", userId: "user_1", sessionId: "session_1", state: null,
      status: "queued", attemptCount: 8, workerTaskId: "new-dispatch-job",
    })
    const { POST } = await import("./route")
    const request = new Request("http://localhost/api/internal/agent-run", {
      method: "POST", headers: { "x-agent-worker-secret": "secret", "content-type": "application/json" },
      body: JSON.stringify({
        userId: "user_1", sessionId: "session_1", executionId: "execution_1",
        workerTaskId: "old-dispatch-job", expectedAttemptCount: 7,
        questionId: "question_1",
      }),
    })

    const response = await POST(request as never)
    expect(response.status).toBe(409)
    expect(mocks.runAgentPipeline).not.toHaveBeenCalled()
  })

  it("allows the same exact task to reach atomic stale-running claim recovery", async () => {
    const updatedAt = new Date(Date.now() - 60_000)
    mocks.executionFindFirst.mockResolvedValueOnce({
      id: "execution_1", userId: "user_1", sessionId: "session_1", state: { autonomous: true },
      status: "running", attemptCount: 8, workerTaskId: "dispatch-job-7", updatedAt,
    })
    mocks.isStaleExactWorkerAttempt.mockReturnValueOnce(true)
    const { POST } = await import("./route")
    const request = new Request("http://localhost/api/internal/agent-run", {
      method: "POST", headers: { "x-agent-worker-secret": "secret", "content-type": "application/json" },
      body: JSON.stringify({
        userId: "user_1", sessionId: "session_1", executionId: "execution_1",
        workerTaskId: "dispatch-job-7", expectedAttemptCount: 7,
        legacyTurnId: "turn_7", questionId: "agent-question:turn_7:legacy:q7",
      }),
    })

    const response = await POST(request as never)
    expect(response.status).toBe(200)
    expect(mocks.isStaleExactWorkerAttempt).toHaveBeenCalledWith(expect.objectContaining({
      status: "running", attemptCount: 8, workerTaskId: "dispatch-job-7", updatedAt,
    }), 7, "dispatch-job-7")
    expect(mocks.runAgentPipeline).toHaveBeenCalledWith(expect.objectContaining({
      expectedAttemptCount: 7, workerTaskId: "dispatch-job-7", legacyTurnId: "turn_7",
    }))
  })

  it("allows the same exact task to recover after more than one stale claim", async () => {
    const updatedAt = new Date(Date.now() - 60_000)
    mocks.executionFindFirst.mockResolvedValueOnce({
      id: "execution_1", userId: "user_1", sessionId: "session_1", state: { autonomous: true },
      status: "running", attemptCount: 10, workerTaskId: "dispatch-job-7", updatedAt,
    })
    mocks.isStaleExactWorkerAttempt.mockReturnValueOnce(true)
    const { POST } = await import("./route")
    const request = new Request("http://localhost/api/internal/agent-run", {
      method: "POST", headers: { "x-agent-worker-secret": "secret", "content-type": "application/json" },
      body: JSON.stringify({
        userId: "user_1", sessionId: "session_1", executionId: "execution_1",
        workerTaskId: "dispatch-job-7", expectedAttemptCount: 7,
        legacyTurnId: "turn_7", questionId: "agent-question:turn_7:legacy:q7",
      }),
    })

    const response = await POST(request as never)
    expect(response.status).toBe(200)
    expect(mocks.isStaleExactWorkerAttempt).toHaveBeenCalledWith(expect.objectContaining({
      status: "running", attemptCount: 10, workerTaskId: "dispatch-job-7", updatedAt,
    }), 7, "dispatch-job-7")
    expect(mocks.runAgentPipeline).toHaveBeenCalledWith(expect.objectContaining({
      expectedAttemptCount: 7, workerTaskId: "dispatch-job-7", legacyTurnId: "turn_7",
    }))
  })

  it("rejects a canonical request when the session is not owned by the user", async () => {
    mocks.sessionFindFirst.mockResolvedValueOnce(null)
    const { POST } = await import("./route")
    const request = new Request("http://localhost/api/internal/agent-run", {
      method: "POST", headers: { "x-agent-worker-secret": "secret", "content-type": "application/json" },
      body: JSON.stringify({ userId: "forged_user", sessionId: "session_1", turnId: "turn_1" }),
    })

    const response = await POST(request as never)
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "canonical_identity_mismatch" } })
    expect(mocks.turnFindFirst).not.toHaveBeenCalled()
    expect(mocks.runAgentPipeline).not.toHaveBeenCalled()
  })

  it("rejects a canonical request when the Turn is not owned by the identity", async () => {
    mocks.turnFindFirst.mockResolvedValueOnce({ id: "turn_1", userId: "other_user", sessionId: "other_session", status: "in_progress" })
    const { POST } = await import("./route")
    const request = new Request("http://localhost/api/internal/agent-run", {
      method: "POST", headers: { "x-agent-worker-secret": "secret", "content-type": "application/json" },
      body: JSON.stringify({ userId: "user_1", sessionId: "session_1", turnId: "forged_turn" }),
    })

    const response = await POST(request as never)
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "canonical_turn_not_owned" } })
    expect(mocks.runAgentPipeline).not.toHaveBeenCalled()
  })

  it("rejects a canonical request when the Turn is terminal", async () => {
    mocks.turnFindFirst.mockResolvedValueOnce({ id: "turn_1", userId: "user_1", sessionId: "session_1", status: "completed" })
    const { POST } = await import("./route")
    const request = new Request("http://localhost/api/internal/agent-run", {
      method: "POST", headers: { "x-agent-worker-secret": "secret", "content-type": "application/json" },
      body: JSON.stringify({ userId: "user_1", sessionId: "session_1", turnId: "turn_1" }),
    })

    const response = await POST(request as never)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "canonical_turn_not_active" } })
    expect(mocks.runAgentPipeline).not.toHaveBeenCalled()
  })

  it("rejects a canonical request when the execution is not owned by the identity", async () => {
    mocks.executionFindFirst.mockResolvedValueOnce({ id: "execution_1", userId: "other_user", sessionId: "other_session", state: { autonomous: true } })
    const { POST } = await import("./route")
    const request = new Request("http://localhost/api/internal/agent-run", {
      method: "POST", headers: { "x-agent-worker-secret": "secret", "content-type": "application/json" },
      body: JSON.stringify({ userId: "user_1", sessionId: "session_1", turnId: "turn_1", executionId: "forged_execution" }),
    })

    const response = await POST(request as never)
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "canonical_execution_not_owned" } })
    expect(mocks.runAgentPipeline).not.toHaveBeenCalled()
  })

  it("rejects a canonical request with missing identity before touching the pipeline", async () => {
    const { POST } = await import("./route")
    const request = new Request("http://localhost/api/internal/agent-run", {
      method: "POST", headers: { "x-agent-worker-secret": "secret", "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "session_1", turnId: "turn_1" }),
    })

    const response = await POST(request as never)
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "canonical_identity_required" } })
    expect(mocks.userFindUnique).not.toHaveBeenCalled()
    expect(mocks.runAgentPipeline).not.toHaveBeenCalled()
  })
})
