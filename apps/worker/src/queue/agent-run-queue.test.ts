import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handler: undefined as undefined | ((job: { data: unknown; id?: string; attemptsMade?: number; opts?: { attempts?: number } }) => Promise<unknown>),
  canonical: vi.fn(),
  producer: { enqueue: vi.fn(), close: vi.fn() },
  createProducer: vi.fn(),
  workerClose: vi.fn(),
  workerRun: vi.fn(),
  workerOptions: undefined as Record<string, unknown> | undefined,
  queueCloses: [] as Array<ReturnType<typeof vi.fn>>,
  dispatchPending: vi.fn(),
  reconcilePublished: vi.fn(),
  executionQuery: vi.fn(),
  failLegacyTurnResume: vi.fn(),
  failStaleUnnamespacedLegacyResume: vi.fn(),
}));
const pinnedFetch = vi.hoisted(() => vi.fn((input: string | URL, init?: unknown) => globalThis.fetch(String(input), init as RequestInit)));

vi.mock("@jobcopilot/shared", async () => {
  const actual = await vi.importActual<typeof import("@jobcopilot/shared")>("@jobcopilot/shared");
  return { ...actual, pinnedFetch };
});

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => {
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.queueCloses.push(close);
    return { add: vi.fn(), close };
  }),
  Worker: vi.fn().mockImplementation((_name, handler, options) => {
    mocks.handler = handler;
    mocks.workerOptions = options;
    return { close: mocks.workerClose, run: mocks.workerRun };
  }),
}));
vi.mock("ioredis", () => ({ Redis: vi.fn().mockImplementation(() => ({ disconnect: vi.fn() })) }));
vi.mock("./agent-run-turn-executor.js", () => ({ runCanonicalAgentTurn: mocks.canonical }));
vi.mock("./agent-run-canonical-dispatch.js", () => ({ createAgentRunCanonicalProducer: mocks.createProducer }));
vi.mock("./agent-execution-dispatch-recovery.js", () => ({
  AGENT_EXECUTION_DISPATCH_POLL_MS: 1_000,
  dispatchPendingAgentExecutionOutbox: mocks.dispatchPending,
}));
vi.mock("./agent-execution-dispatch-published-recovery.js", () => ({
  reconcilePublishedAgentExecutionDispatches: mocks.reconcilePublished,
}));
vi.mock("./agent-run-legacy-terminal-failure.js", async () => {
  const actual = await vi.importActual<typeof import("./agent-run-legacy-terminal-failure.js")>("./agent-run-legacy-terminal-failure.js");
  return {
    ...actual,
    failTurnScopedLegacyResume: mocks.failLegacyTurnResume,
    failStaleUnnamespacedLegacyResume: mocks.failStaleUnnamespacedLegacyResume,
  };
});
vi.mock("../db/apply-results.js", () => ({ getPool: () => ({ query: mocks.executionQuery }) }));

describe("agent-run queue", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    mocks.handler = undefined;
    mocks.canonical.mockReset();
    mocks.producer.enqueue.mockReset();
    mocks.producer.close.mockReset();
    mocks.createProducer.mockReset().mockReturnValue(mocks.producer);
    mocks.workerClose.mockReset().mockResolvedValue(undefined);
    mocks.workerRun.mockReset().mockResolvedValue(undefined);
    mocks.workerOptions = undefined;
    mocks.queueCloses.length = 0;
    mocks.dispatchPending.mockReset().mockResolvedValue(0);
    mocks.reconcilePublished.mockReset().mockResolvedValue(0);
    mocks.executionQuery.mockReset().mockResolvedValue({ rowCount: 1 });
    mocks.failLegacyTurnResume.mockReset().mockResolvedValue(false);
    mocks.failStaleUnnamespacedLegacyResume.mockReset().mockResolvedValue(false);
    vi.stubEnv("AGENT_WEB_URL", "https://app.applymate.test/");
    vi.stubEnv("AGENT_WORKER_SECRET", "worker-secret");
    vi.stubEnv("ENABLE_AGENT_CANONICAL_AUTOMATION", "0");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "completed" }))));
  });

  it("calls the authenticated internal pipeline endpoint for a scheduled session", async () => {
    await import("./agent-run-queue.js");
    await mocks.handler?.({ data: { userId: "user_1", sessionId: "session_1" } });

    expect(fetch).toHaveBeenCalledWith("https://app.applymate.test/api/internal/agent-run", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "x-agent-worker-secret": "worker-secret" }),
      body: JSON.stringify({ userId: "user_1", sessionId: "session_1" }),
    }));
  }, 15_000);

  it("forwards exact legacy question, Turn, Bull job, and pre-claim attempt identities", async () => {
    await import("./agent-run-queue.js");
    await mocks.handler?.({
      id: "dispatch-job-7",
      data: {
        userId: "user_1", sessionId: "session_1", executionId: "execution_1", attemptCount: 7,
        questionId: "agent-question:turn_7:legacy:q7", legacyTurnId: "turn_7",
      },
    });

    const request = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(request.body))).toEqual({
      userId: "user_1", sessionId: "session_1", executionId: "execution_1",
      questionId: "agent-question:turn_7:legacy:q7", legacyTurnId: "turn_7",
      expectedAttemptCount: 7, workerTaskId: "dispatch-job-7",
    })
  })

  it("rejects a task when the worker URL is not configured", async () => {
    vi.stubEnv("AGENT_WEB_URL", "");
    await import("./agent-run-queue.js");
    await expect(mocks.handler?.({ data: { userId: "user_1", sessionId: "session_1" } })).rejects.toThrow("AGENT_WEB_URL");
  });

  it("does not retry a run rejected after account suspension or entitlement revocation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Account unavailable" }), { status: 403 })));
    await import("./agent-run-queue.js");

    await expect(mocks.handler?.({
      id: "dispatch-job-1", attemptsMade: 0, opts: { attempts: 3 },
      data: { userId: "user_1", sessionId: "session_1", executionId: "execution_1", attemptCount: 6 },
    })).resolves.toEqual({
      status: "skipped", reason: "authorization-revoked",
    });
    const [sql, values] = mocks.executionQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('SET "status" = \'failed\', "error" = $5, "completedAt" = CURRENT_TIMESTAMP');
    expect(sql).toContain('"workerTaskId" = $4 AND "status" = \'queued\' AND "attemptCount" = $6');
    expect(values).toEqual(["execution_1", "user_1", "session_1", "dispatch-job-1", expect.any(String), 6]);
  });

  it("uses the exact Turn failure helper for a rejected legacy answer dispatch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 })));
    await import("./agent-run-queue.js");

    await expect(mocks.handler?.({
      id: "dispatch-job-7", attemptsMade: 0, opts: { attempts: 3 },
      data: {
        userId: "user_1", sessionId: "session_1", executionId: "execution_1", attemptCount: 7,
        questionId: "agent-question:turn_7:legacy:q7", legacyTurnId: "turn_7",
      },
    })).resolves.toMatchObject({ status: "skipped" });

    expect(mocks.failLegacyTurnResume).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "user_1", sessionId: "session_1", executionId: "execution_1", attemptCount: 7,
      workerTaskId: "dispatch-job-7", questionId: "agent-question:turn_7:legacy:q7",
      legacyTurnId: "turn_7", reason: "authorization_revoked",
      staleRunning: { staleBefore: expect.any(Date) },
    }));
    expect(mocks.executionQuery).not.toHaveBeenCalled();
  });

  it("terminalizes the exact stale-running unnamespaced resume after authorization is revoked", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 })));
    mocks.executionQuery.mockResolvedValueOnce({ rowCount: 0 });
    mocks.failStaleUnnamespacedLegacyResume.mockResolvedValueOnce(true);
    await import("./agent-run-queue.js");

    await expect(mocks.handler?.({
      id: "dispatch-job-9", attemptsMade: 0, opts: { attempts: 3 },
      data: {
        userId: "user_1", sessionId: "session_1", executionId: "execution_9", attemptCount: 6,
        questionId: "legacy-question-9",
      },
    })).resolves.toEqual({ status: "skipped", reason: "authorization-revoked" });

    expect(mocks.executionQuery).toHaveBeenCalledOnce();
    expect(mocks.failStaleUnnamespacedLegacyResume).toHaveBeenCalledWith(expect.anything(), {
      userId: "user_1", sessionId: "session_1", executionId: "execution_9", attemptCount: 6,
      workerTaskId: "dispatch-job-9", questionId: "legacy-question-9", reason: "authorization_revoked",
      staleBefore: expect.any(Date),
    });
    expect(mocks.failLegacyTurnResume).not.toHaveBeenCalled();
  });

  it("preserves the authorization marker if stale-running terminalization fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 })));
    mocks.executionQuery.mockResolvedValueOnce({ rowCount: 0 });
    mocks.failStaleUnnamespacedLegacyResume.mockRejectedValueOnce(new Error("database unavailable"));
    await import("./agent-run-queue.js");

    await expect(mocks.handler?.({
      id: "dispatch-job-9", attemptsMade: 2, opts: { attempts: 3 },
      data: {
        userId: "user_1", sessionId: "session_1", executionId: "execution_9", attemptCount: 6,
        questionId: "legacy-question-9",
      },
    })).rejects.toThrow("legacy_resume_terminalization_failed:authorization_revoked");
  });

  it("preserves authorization reason when 403 terminalization fails on the final attempt", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 })));
    mocks.failLegacyTurnResume.mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(true);
    await import("./agent-run-queue.js");

    await expect(mocks.handler?.({
      id: "dispatch-job-7", attemptsMade: 2, opts: { attempts: 3 },
      data: {
        userId: "user_1", sessionId: "session_1", executionId: "execution_1", attemptCount: 7,
        questionId: "agent-question:turn_7:legacy:q7", legacyTurnId: "turn_7",
      },
    })).rejects.toThrow("legacy_resume_terminalization_failed:authorization_revoked");

    expect(mocks.failLegacyTurnResume).toHaveBeenCalledTimes(2);
    expect(mocks.failLegacyTurnResume).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({ reason: "authorization_revoked" }));
    expect(mocks.failLegacyTurnResume).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ reason: "authorization_revoked" }));
    expect(mocks.executionQuery).not.toHaveBeenCalled();
  });

  it("marks final retry terminalization failure with the retry-exhausted marker", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
    mocks.failLegacyTurnResume.mockRejectedValueOnce(new Error("database unavailable"));
    await import("./agent-run-queue.js");

    await expect(mocks.handler?.({
      id: "dispatch-job-7", attemptsMade: 2, opts: { attempts: 3 },
      data: {
        userId: "user_1", sessionId: "session_1", executionId: "execution_1", attemptCount: 7,
        questionId: "agent-question:turn_7:legacy:q7", legacyTurnId: "turn_7",
      },
    })).rejects.toThrow("legacy_resume_terminalization_failed:retry_exhausted");

    expect(mocks.failLegacyTurnResume).toHaveBeenCalledOnce();
    expect(mocks.failLegacyTurnResume).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reason: "retry_exhausted" }));
  });

  it("does not retry an exact legacy Turn after Web commits a terminal 429 preflight", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("credits exhausted", { status: 429 })));
    await import("./agent-run-queue.js");

    await expect(mocks.handler?.({
      id: "dispatch-job-7", attemptsMade: 0, opts: { attempts: 3 },
      data: {
        userId: "user_1", sessionId: "session_1", executionId: "execution_1", attemptCount: 7,
        questionId: "agent-question:turn_7:legacy:q7", legacyTurnId: "turn_7",
      },
    })).resolves.toEqual({ status: "skipped", reason: "dispatch-preflight-rejected" });
    expect(mocks.failLegacyTurnResume).not.toHaveBeenCalled();
    expect(mocks.executionQuery).not.toHaveBeenCalled();
  });

  it("closes only the exact legacy Turn after final HTTP/network dispatch failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
    await import("./agent-run-queue.js");
    const task = {
      id: "dispatch-job-7", attemptsMade: 2, opts: { attempts: 3 },
      data: {
        userId: "user_1", sessionId: "session_1", executionId: "execution_1", attemptCount: 7,
        questionId: "agent-question:turn_7:legacy:q7", legacyTurnId: "turn_7",
      },
    };

    await expect(mocks.handler?.(task)).rejects.toThrow("Agent run endpoint returned 503");
    expect(mocks.failLegacyTurnResume).toHaveBeenCalledWith(expect.anything(), {
      userId: "user_1", sessionId: "session_1", executionId: "execution_1", attemptCount: 7,
      workerTaskId: "dispatch-job-7", questionId: "agent-question:turn_7:legacy:q7",
      legacyTurnId: "turn_7", reason: "retry_exhausted",
    });
    expect(mocks.executionQuery).not.toHaveBeenCalled();
  });

  it("terminalizes the exact legacy Turn after the final network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket reset")));
    await import("./agent-run-queue.js");

    await expect(mocks.handler?.({
      id: "dispatch-job-7", attemptsMade: 2, opts: { attempts: 3 },
      data: {
        userId: "user_1", sessionId: "session_1", executionId: "execution_1", attemptCount: 7,
        questionId: "agent-question:turn_7:legacy:q7", legacyTurnId: "turn_7",
      },
    })).rejects.toThrow("socket reset");
    expect(mocks.failLegacyTurnResume).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      executionId: "execution_1", attemptCount: 7, workerTaskId: "dispatch-job-7",
      questionId: "agent-question:turn_7:legacy:q7", legacyTurnId: "turn_7", reason: "retry_exhausted",
    }));
    expect(mocks.executionQuery).not.toHaveBeenCalled();
  });

  it.each([
    ["429", () => vi.fn().mockResolvedValue(new Response("busy", { status: 429 }))],
    ["5xx", () => vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }))],
    ["network", () => vi.fn().mockRejectedValue(new Error("socket reset"))],
  ])("marks only the final %s failure on the exact queued execution", async (_case, makeFetch) => {
    vi.stubGlobal("fetch", makeFetch());
    await import("./agent-run-queue.js");
    const task = {
      id: "dispatch-job-2", data: { userId: "user_1", sessionId: "session_1", executionId: "execution_2", attemptCount: 3 },
      opts: { attempts: 3 },
    };

    await expect(mocks.handler?.({ ...task, attemptsMade: 1 })).rejects.toThrow();
    expect(mocks.executionQuery).not.toHaveBeenCalled();
    await expect(mocks.handler?.({ ...task, attemptsMade: 2 })).rejects.toThrow();
    expect(mocks.executionQuery).toHaveBeenCalledOnce();
    const [sql, values] = mocks.executionQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('"workerTaskId" = $4 AND "status" = \'queued\' AND "attemptCount" = $6');
    expect(values.slice(0, 4)).toEqual(["execution_2", "user_1", "session_1", "dispatch-job-2"]);
    expect(values[5]).toBe(3);
  });

  it("uses the existing pipeline adapter as an explicit gate-off rollback", async () => {
    mocks.canonical.mockResolvedValue({ status: "completed", summary: "pipeline complete" });
    await import("./agent-run-queue.js");

    await expect(mocks.handler?.({ data: { userId: "user_1", sessionId: "session_1", turnId: "turn_1", executionId: "execution_1" } }))
      .resolves.toEqual({ status: "completed", summary: "pipeline complete" });
    expect(mocks.canonical).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ turnId: "turn_1", executionId: "execution_1" }) }),
      expect.anything(),
    );
    expect(mocks.producer.enqueue).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("routes a Turn-bound task to agent-turns when the exact server gate is enabled", async () => {
    vi.stubEnv("ENABLE_AGENT_CANONICAL_AUTOMATION", "1");
    await import("./agent-run-queue.js");

    await expect(mocks.handler?.({ data: { userId: "user_1", sessionId: "session_1", turnId: "turn_1", executionId: "untrusted" } }))
      .resolves.toEqual({ status: "routed", queue: "agent-turns", turnId: "turn_1" });
    expect(mocks.producer.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.producer.enqueue).toHaveBeenCalledWith({ sessionId: "session_1", turnId: "turn_1" });
    expect(mocks.producer.enqueue.mock.calls[0]?.[0]).not.toHaveProperty("executionId");
    expect(mocks.canonical).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the agent-run router stopped until startup explicitly opens it", async () => {
    const module = await import("./agent-run-queue.js");

    expect(mocks.workerOptions).toMatchObject({ autorun: false });
    expect(mocks.workerRun).not.toHaveBeenCalled();
    module.startAgentRunWorker();
    module.startAgentRunWorker();

    expect(mocks.workerRun).toHaveBeenCalledOnce();
    expect(mocks.dispatchPending).toHaveBeenCalledOnce();
    expect(mocks.reconcilePublished).toHaveBeenCalledOnce();
    await module.closeAgentRunResources();
  });

  it("runs both dispatch scanners without overlap and waits for both at shutdown", async () => {
    vi.useFakeTimers();
    let releasePending!: () => void;
    let releasePublished!: () => void;
    mocks.dispatchPending.mockReturnValueOnce(new Promise<void>(resolve => { releasePending = resolve; }));
    mocks.reconcilePublished.mockReturnValueOnce(new Promise<void>(resolve => { releasePublished = resolve; }));
    const module = await import("./agent-run-queue.js");
    module.startAgentRunWorker();
    await Promise.resolve();

    expect(mocks.dispatchPending).toHaveBeenCalledOnce();
    expect(mocks.reconcilePublished).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.dispatchPending).toHaveBeenCalledOnce();
    expect(mocks.reconcilePublished).toHaveBeenCalledOnce();

    let closed = false;
    const closing = module.closeAgentRunResources().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    releasePending();
    await Promise.resolve();
    expect(closed).toBe(false);
    releasePublished();
    await closing;
    expect(closed).toBe(true);
  });

  it("isolates a failed pending scan so the published scanner still runs", async () => {
    mocks.dispatchPending.mockRejectedValueOnce(new Error("pending scan failed"));
    const module = await import("./agent-run-queue.js");
    module.startAgentRunWorker();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.dispatchPending).toHaveBeenCalledOnce();
    expect(mocks.reconcilePublished).toHaveBeenCalledOnce();
    await module.closeAgentRunResources();
  });

  it("routes a Turn-bound task when canonical automation is enabled", async () => {
    vi.stubEnv("ENABLE_AGENT_CANONICAL_AUTOMATION", "1");
    await import("./agent-run-queue.js");

    await expect(mocks.handler?.({ data: { userId: "user_1", sessionId: "session_1", turnId: "turn_1" } }))
      .resolves.toEqual({ status: "routed", queue: "agent-turns", turnId: "turn_1" });
    expect(mocks.producer.enqueue).toHaveBeenCalledWith({ sessionId: "session_1", turnId: "turn_1" });
    expect(mocks.canonical).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("propagates canonical enqueue failures for BullMQ retry", async () => {
    vi.stubEnv("ENABLE_AGENT_CANONICAL_AUTOMATION", "1");
    mocks.producer.enqueue.mockRejectedValue(new Error("outbox unavailable"));
    await import("./agent-run-queue.js");

    await expect(mocks.handler?.({ data: { userId: "user_1", sessionId: "session_1", turnId: "turn_1" } }))
      .rejects.toThrow("outbox unavailable");
    expect(mocks.canonical).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("closes the canonical producer and legacy resources during shutdown", async () => {
    vi.useFakeTimers();
    const module = await import("./agent-run-queue.js");
    module.startAgentRunWorker();

    await module.closeAgentRunResources();

    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.workerClose).toHaveBeenCalledTimes(1);
    expect(mocks.producer.close).toHaveBeenCalledTimes(1);
    expect(mocks.queueCloses).toHaveLength(1);
    expect(mocks.queueCloses.every(close => close.mock.calls.length === 1)).toBe(true);
    vi.useRealTimers();
  });
});
