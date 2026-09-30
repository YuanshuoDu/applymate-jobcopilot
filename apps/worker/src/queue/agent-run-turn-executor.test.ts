import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TurnEngineToolExecutor } from "../runtime/turns/turn-engine-types.js"

const mocks = vi.hoisted(() => ({
  runTurnJob: vi.fn().mockResolvedValue({ status: "completed", summary: "pipeline complete" }),
  createStore: vi.fn().mockReturnValue({}),
  pinnedFetch: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
  toolInput: undefined as unknown,
  turnOptions: undefined as { validateToolArguments?: (toolName: string, input: unknown) => boolean | string } | undefined,
}))

vi.mock("../runtime/turns/turn-queue.js", () => ({ runTurnJob: mocks.runTurnJob }))
vi.mock("../runtime/turns/turn-engine-store.js", () => ({ createPgTurnEngineStore: mocks.createStore }))
vi.mock("@jobcopilot/shared", () => ({ pinnedFetch: mocks.pinnedFetch }))
vi.mock("../runtime/subagents/root-task-store.js", () => ({
  createPgRootTaskStore: vi.fn(() => ({
    ensure: vi.fn().mockResolvedValue({ id: "root-1" }),
    checkCompletion: vi.fn().mockResolvedValue({ ok: true }),
    finish: vi.fn().mockResolvedValue(undefined),
  })),
}))
vi.mock("../runtime/turns/turn-engine.js", () => ({
  TurnEngine: vi.fn().mockImplementation((options: { executeTool: TurnEngineToolExecutor; validateToolArguments?: (toolName: string, input: unknown) => boolean | string }) => {
    mocks.turnOptions = options
    return {
      run: async () => {
        const toolResult = await options.executeTool({
          scope: { userId: "runtime-user" }, sessionId: "runtime-session", turnId: "runtime-turn", stepId: "step-1",
          signal: new AbortController().signal, capabilities: ["read"],
          call: { id: "call-1", toolName: "pipeline.run", toolVersion: "1", input: mocks.toolInput },
        })
        return { status: toolResult.status, summary: "pipeline complete", errorCode: toolResult.errorCode }
      },
    }
  }),
}))

import { runCanonicalAgentTurn } from "./agent-run-turn-executor.js"

type RuntimeExecute = { execute(input: { lease: unknown; signal: AbortSignal }): Promise<unknown> }

async function executePipelineCall(input: unknown): Promise<unknown> {
  mocks.toolInput = input
  await runCanonicalAgentTurn({
    data: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", executionId: "execution-1" }, attemptsMade: 0,
  }, {} as never)
  const invocation = mocks.runTurnJob.mock.calls[mocks.runTurnJob.mock.calls.length - 1]
  if (!invocation) throw new Error("runTurnJob was not invoked")
  const runtime = invocation[1] as unknown as RuntimeExecute
  return runtime.execute({ lease: {}, signal: new AbortController().signal })
}

function requestBody(): Record<string, unknown> {
  const request = mocks.pinnedFetch.mock.calls[0]?.[1] as RequestInit | undefined
  if (!request || typeof request.body !== "string") throw new Error("pipeline request body was not captured")
  return JSON.parse(request.body) as Record<string, unknown>
}

describe("runCanonicalAgentTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv("AGENT_WEB_URL", "https://applymate.example")
    vi.stubEnv("AGENT_WORKER_SECRET", "secret")
    mocks.pinnedFetch.mockResolvedValue(new Response(JSON.stringify({ status: "completed", report: { processed: 1 } }), { status: 200 }))
  })

  afterEach(() => vi.unstubAllEnvs())

  it("derives the legacy lease owner from turnId instead of executionId", async () => {
    await runCanonicalAgentTurn({
      data: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", executionId: "attacker-chosen" },
      attemptsMade: 3,
    }, {} as never)

    expect(mocks.runTurnJob).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { turnId: "turn-1", sessionId: "session-1", ownerId: "agent-run:turn-1" },
        attemptsMade: 3,
      }),
      expect.any(Object),
    )
  })

  it.each(["userId", "sessionId", "turnId", "executionId"])("keeps server-owned %s when tool input forges it", async key => {
    await executePipelineCall({ mode: "start", [key]: "attacker-chosen" })

    expect(requestBody()).toEqual({
      mode: "start", userId: "user-1", sessionId: "session-1", turnId: "turn-1", executionId: "execution-1",
    })
  })

  it("preserves normal pipeline tool input alongside server-owned identity", async () => {
    await executePipelineCall({ mode: "start" })

    expect(requestBody()).toEqual({
      mode: "start", userId: "user-1", sessionId: "session-1", turnId: "turn-1", executionId: "execution-1",
    })
  })

  it("fails closed without making a request for malformed tool input", async () => {
    await expect(executePipelineCall(["malformed"])).resolves.toMatchObject({ status: "failed", errorCode: "invalid_tool_input" })
    expect(mocks.pinnedFetch).not.toHaveBeenCalled()
  })

  it("binds a strict pipeline.run argument validator", async () => {
    await executePipelineCall({ mode: "start" })
    const validate = mocks.turnOptions?.validateToolArguments
    expect(validate).toBeTypeOf("function")
    expect(validate?.("pipeline.run", { mode: "resume" })).toBe(true)
    expect(validate?.("pipeline.run", {})).toBe(true)
    expect(validate?.("pipeline.run", { mode: "pause" })).not.toBe(true)
    expect(validate?.("pipeline.run", { mode: 1 })).not.toBe(true)
    expect(validate?.("pipeline.run", { mode: "start", extra: true })).not.toBe(true)
    expect(validate?.("other.tool", { mode: "start" })).not.toBe(true)
  })

  it("quarantines a legacy 200 failure with no report", async () => {
    mocks.pinnedFetch.mockResolvedValue(new Response(JSON.stringify({ status: "failed", report: null }), { status: 200 }))

    await expect(executePipelineCall({ mode: "resume" })).resolves.toMatchObject({
      status: "failed", errorCode: "legacy_wait_unsupported",
    })
  })

  it.each([
    { status: "waiting_for_user", message: "candidate answer required" },
    { status: "failed", error: { name: "AgentPauseError", message: "writer paused" } },
  ])("quarantines legacy wait marker: %j", async body => {
    mocks.pinnedFetch.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))

    await expect(executePipelineCall({ mode: "resume" })).resolves.toMatchObject({
      status: "failed", errorCode: "legacy_wait_unsupported",
    })
  })

  it("keeps an explicit non-wait pipeline failure failed", async () => {
    mocks.pinnedFetch.mockResolvedValue(new Response(JSON.stringify({ status: "failed", errorCode: "provider_unavailable" }), { status: 200 }))

    await expect(executePipelineCall({ mode: "resume" })).resolves.toMatchObject({
      status: "failed", errorCode: "provider_unavailable",
    })
  })

  it("preserves the existing HTTP failure fence", async () => {
    mocks.pinnedFetch.mockResolvedValue(new Response(JSON.stringify({ error: "upstream unavailable" }), { status: 503 }))

    await expect(executePipelineCall({ mode: "resume" })).resolves.toMatchObject({
      status: "failed", errorCode: "pipeline_http_503",
    })
  })

  it("accepts a completed report from the legacy-compatible route", async () => {
    mocks.pinnedFetch.mockResolvedValue(new Response(JSON.stringify({ status: "completed", report: { processed: 1 } }), { status: 200 }))

    await expect(executePipelineCall({ mode: "resume" })).resolves.toMatchObject({ status: "completed", errorCode: null })
  })

  it("fails closed for a malformed successful response", async () => {
    mocks.pinnedFetch.mockResolvedValue(new Response("not-json", { status: 200 }))

    await expect(executePipelineCall({ mode: "resume" })).resolves.toMatchObject({
      status: "failed", errorCode: "pipeline_malformed_response",
    })
  })

  it("preserves the turn identity fence", async () => {
    await expect(runCanonicalAgentTurn({
      data: { userId: "user-1", sessionId: "session-1" }, attemptsMade: 0,
    }, {} as never)).rejects.toThrow("Canonical agent run requires turnId")
  })
})
