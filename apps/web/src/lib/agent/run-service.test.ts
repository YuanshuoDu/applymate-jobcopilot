import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentExecutionCancelledError } from "./execution-control";

const mocks = vi.hoisted(() => ({
  createHistory: vi.fn(),
  findUser: vi.fn(),
  createRecorder: vi.fn(),
  activate: vi.fn(),
  executionFindFirst: vi.fn(),
  executionFindUnique: vi.fn(),
  executionUpdateMany: vi.fn(),
  executionTransaction: vi.fn(),
  executionUpsert: vi.fn(),
  turnFindFirst: vi.fn(),
  findConfig: vi.fn(),
  findTranscript: vi.fn(),
  findResume: vi.fn(),
  finalize: vi.fn(),
  loadRoleConfigs: vi.fn(),
  record: vi.fn(),
  pause: vi.fn(),
  runPipeline: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    agentConfig: { findUnique: mocks.findConfig },
    agentRun: { create: mocks.createHistory },
    $transaction: mocks.executionTransaction,
    agentExecution: { findFirst: mocks.executionFindFirst, findUnique: mocks.executionFindUnique, updateMany: mocks.executionUpdateMany, upsert: mocks.executionUpsert },
    agentTranscriptEvent: { findFirst: mocks.findTranscript },
    agentTurn: { findFirst: mocks.turnFindFirst },
    resume: { findFirst: mocks.findResume },
    user: { findUnique: mocks.findUser },
  },
}));
vi.mock("@/lib/agent/pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/pipeline")>();
  return { ...actual, runPipeline: mocks.runPipeline };
});
vi.mock("@/lib/runtime-feature-flags", () => ({
  isRuntimeAgentHarnessFeatureEnabled: vi.fn(async () => false),
}));
vi.mock("@/lib/agent/session/run-recorder", () => ({
  createRunSessionRecorder: mocks.createRecorder,
}));
vi.mock("@/lib/agent/role-config", () => ({
  loadRoleConfigs: mocks.loadRoleConfigs,
  toRoleConfigMap: vi.fn(() => ({})),
}));
vi.mock("@/lib/agent/types", () => ({ resumeToText: vi.fn(() => "resume text") }));

const config = {
  id: "config_1", userId: "user_1", isRunning: false, dailyLimit: 10, minMatchScore: 70,
  autoApply: false, requireApproval: true, targetLocations: ["Dublin"], targetRoles: ["Engineer"],
  excludeCompanies: [], priorityCompanies: [], autoCoverLetter: false, coverTone: "professional",
  useTailoredCV: false, model: "MiniMax-M3",
};

describe("runAgentPipeline", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.createHistory.mockResolvedValue({});
    mocks.executionUpsert.mockResolvedValue({ id: "execution_1" });
    mocks.executionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.executionFindUnique.mockResolvedValue({ attemptCount: 1 });
    mocks.executionFindFirst.mockResolvedValue({ id: "execution_1", sessionId: "session_1", state: null });
    mocks.turnFindFirst.mockResolvedValue({ id: "turn_1" });
    mocks.executionTransaction.mockImplementation((work: (tx: unknown) => Promise<unknown>) => work({
      agentExecution: { updateMany: mocks.executionUpdateMany, findUnique: mocks.executionFindUnique },
    }));
    mocks.record.mockResolvedValue({});
    mocks.activate.mockResolvedValue(true);
    mocks.createRecorder.mockResolvedValue({ sessionId: "session_1", activate: mocks.activate, getTurnId: vi.fn(() => undefined), record: mocks.record, finalize: mocks.finalize, pause: mocks.pause });
    mocks.finalize.mockResolvedValue({});
    mocks.pause.mockResolvedValue({});
    mocks.findConfig.mockResolvedValue(config);
    mocks.findUser.mockResolvedValue({ accountStatus: "active" });
    mocks.findTranscript.mockResolvedValue({ data: {
      automation: { targetRoles: ["Backend Engineer"], targetLocations: ["Berlin"], minScore: 85,
        dailyCap: 4, requireApproval: false, autoApply: true },
    } });
    mocks.findResume.mockResolvedValue({
      id: "resume_1", name: "CV", content: {}, templateId: null, templateOptions: null,
      directionId: null, basicsDetached: false,
    });
    mocks.loadRoleConfigs.mockResolvedValue([]);
    mocks.runPipeline.mockResolvedValue({ processed: 1, queued: 1, applied: 0, pending: 0, skipped: 0, failed: 0, durationMs: 10 });
  });

  it("uses the saved automation snapshot but preserves the per-job authorization boundary", async () => {
    const { runAgentPipeline } = await import("./run-service");
    await runAgentPipeline({
      userId: "user_1", sessionId: "session_1", autonomous: false,
      aiConfig: { provider: "minimax", model: "MiniMax-M3", apiKey: "key" },
    });

    expect(mocks.runPipeline).toHaveBeenCalledWith(expect.objectContaining({
      autonomous: false,
      sessionId: "session_1",
      questionProjectionMode: "legacy",
      executionAttempt: { id: "execution_1", attemptCount: 1 },
      agentCfg: expect.objectContaining({
        targetRoles: ["Backend Engineer"], targetLocations: ["Berlin"], minMatchScore: 85,
        dailyLimit: 4, autoApply: true, requireApproval: false,
      }),
    }));
    expect(mocks.finalize).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
    expect(mocks.executionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ attemptCount: 1, status: "running" }),
    }));
    expect(mocks.createRecorder).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ deferActivation: true }));
    expect(mocks.executionUpdateMany).toHaveBeenCalledBefore(mocks.activate);
    expect(mocks.activate).toHaveBeenCalledWith(expect.objectContaining({
      executionAttempt: { id: "execution_1", attemptCount: 1 },
      assertCurrent: expect.any(Function),
    }));
  });

  it("marks questions canonical when a Turn is explicitly supplied", async () => {
    const { runAgentPipeline } = await import("./run-service")
    await runAgentPipeline({
      userId: "user_1", sessionId: "session_1", turnId: "turn_1", autonomous: false,
      aiConfig: { provider: "minimax", model: "MiniMax-M3", apiKey: "key" },
    })

    expect(mocks.runPipeline).toHaveBeenCalledWith(expect.objectContaining({
      questionProjectionMode: "canonical",
    }))
  })

  it("waits for transcript persistence before publishing pipeline events to SSE", async () => {
    let releaseWrite!: () => void;
    const pendingWrite = new Promise<void>(resolve => { releaseWrite = resolve });
    mocks.record.mockImplementationOnce(() => pendingWrite);
    mocks.runPipeline.mockImplementationOnce(async (rawContext: unknown) => {
      const context = rawContext as { emit: (event: string, data: unknown) => void };
      context.emit("stage_done", { stage: "scout" });
      return { processed: 1, queued: 1, applied: 0, pending: 0, skipped: 0, failed: 0, durationMs: 10 };
    });
    const publish = vi.fn();
    const { runAgentPipeline } = await import("./run-service");

    const run = runAgentPipeline({
      userId: "user_1", sessionId: "session_1", autonomous: false, emit: publish,
      aiConfig: { provider: "minimax", model: "MiniMax-M3", apiKey: "key" },
    });
    await vi.waitFor(() => expect(mocks.record).toHaveBeenCalledWith("stage_done", { stage: "scout" }));
    expect(publish).not.toHaveBeenCalled();

    releaseWrite();
    await expect(run).resolves.toMatchObject({ processed: 1 });
    expect(publish).toHaveBeenCalledWith("stage_done", { stage: "scout" });
  });

  it("withholds a legacy agent_question when its active attempt is cancelled during recording", async () => {
    const controller = new AbortController();
    mocks.record.mockImplementationOnce(async () => {
      controller.abort();
      throw new AgentExecutionCancelledError();
    });
    mocks.runPipeline.mockImplementationOnce(async (rawContext: unknown) => {
      const context = rawContext as { emit: (event: string, data: unknown) => void };
      context.emit("agent_question", { role: "analyst", questionId: "missing_description", question: "Continue?" });
      return { processed: 1, queued: 0, applied: 0, pending: 0, skipped: 0, failed: 0, durationMs: 10 };
    });
    const publish = vi.fn();
    const { runAgentPipeline } = await import("./run-service");

    await expect(runAgentPipeline({
      userId: "user_1", sessionId: "session_1", autonomous: false, signal: controller.signal, emit: publish,
      aiConfig: { provider: "minimax", model: "MiniMax-M3", apiKey: "key" },
    })).resolves.toBeNull();

    expect(mocks.record).toHaveBeenCalledWith("agent_question", expect.objectContaining({ questionId: "missing_description" }));
    expect(publish).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it("does not reopen or project an existing session when a completed execution cannot be claimed", async () => {
    mocks.executionUpdateMany.mockResolvedValue({ count: 0 });
    const { runAgentPipeline } = await import("./run-service");

    await expect(runAgentPipeline({
      userId: "user_1", sessionId: "session_1", executionId: "execution_1", autonomous: false,
      aiConfig: { provider: "minimax", model: "MiniMax-M3", apiKey: "key" },
    })).resolves.toBeNull();

    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it("binds a legacy resume to the exact Turn and dispatch task without enabling canonical projection", async () => {
    mocks.executionFindUnique.mockResolvedValueOnce({ attemptCount: 5 })
    mocks.createRecorder.mockResolvedValueOnce({
      sessionId: "session_1", activate: mocks.activate, getTurnId: vi.fn(() => "turn_1"),
      record: mocks.record, finalize: mocks.finalize, pause: mocks.pause,
    })
    const { runAgentPipeline } = await import("./run-service")
    const questionId = "agent-question:turn_1:legacy:q1"

    await expect(runAgentPipeline({
      userId: "user_1", sessionId: "session_1", executionId: "execution_1",
      legacyTurnId: "turn_1", questionId, workerTaskId: "dispatch-job-1", expectedAttemptCount: 4,
      autonomous: false, aiConfig: { provider: "minimax", model: "MiniMax-M3", apiKey: "key" },
    })).resolves.toMatchObject({ processed: 1 })

    expect(mocks.createRecorder).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      turnId: "turn_1", dualWrite: false, manageV2Lifecycle: true,
    }))
    expect(mocks.activate).toHaveBeenCalledWith(expect.objectContaining({ executionAttempt: { id: "execution_1", attemptCount: 5 } }))
    expect(mocks.executionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "execution_1", userId: "user_1", sessionId: "session_1",
        workerTaskId: "dispatch-job-1",
        OR: expect.arrayContaining([
          { status: "queued", attemptCount: 4 },
          expect.objectContaining({
            status: "running",
            attemptCount: { gte: 5, lt: Number.MAX_SAFE_INTEGER },
            updatedAt: { lt: expect.any(Date) },
          }),
        ]),
      }),
    }))
    expect(mocks.runPipeline).toHaveBeenCalledWith(expect.objectContaining({
      turnId: "turn_1", questionProjectionMode: "legacy", resumeQuestionId: questionId,
    }))
  })

  it("binds a default-off raw legacy question dispatch to its exact continuation provenance", async () => {
    const { runAgentPipeline } = await import("./run-service")

    await runAgentPipeline({
      userId: "user_1", sessionId: "session_1", executionId: "execution_1",
      questionId: "legacy_question_1", workerTaskId: "dispatch-job-raw", expectedAttemptCount: 4,
      autonomous: false, aiConfig: { provider: "minimax", model: "MiniMax-M3", apiKey: "key" },
    })

    expect(mocks.createRecorder).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      dualWrite: false, ensureTurn: true, legacyResumeQuestionId: "legacy_question_1",
    }))
    expect(mocks.runPipeline).toHaveBeenCalledWith(expect.objectContaining({
      questionProjectionMode: "legacy", resumeQuestionId: "legacy_question_1",
    }))
  })

  it("uses the recorder transaction for the execution/Turn/Session pause transition", async () => {
    mocks.createRecorder.mockResolvedValueOnce({
      sessionId: "session_1", activate: mocks.activate, getTurnId: vi.fn(() => "turn_1"),
      record: mocks.record, finalize: mocks.finalize, pause: mocks.pause,
    })
    const { AgentPauseError } = await import("./orchestrator")
    mocks.runPipeline.mockRejectedValueOnce(new AgentPauseError("question_1", "analyst"))
    const { runAgentPipeline } = await import("./run-service")

    await expect(runAgentPipeline({
      userId: "user_1", sessionId: "session_1", autonomous: false,
      aiConfig: { provider: "minimax", model: "MiniMax-M3", apiKey: "key" },
    })).resolves.toBeNull()

    expect(mocks.pause).toHaveBeenCalledWith(
      "Waiting for your answer at analyst.", "analyst",
      expect.objectContaining({
        turnId: "turn_1", terminalStatus: "running", executionTransitionTo: "waiting_for_user",
        executionAttempt: { id: "execution_1", userId: "user_1", attemptCount: 1 },
      }),
    )
    expect(mocks.executionUpdateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "waiting_for_user" }),
    }))
  })

  it("rejects a supplied execution/session mismatch before constructing the recorder", async () => {
    mocks.executionFindFirst.mockResolvedValueOnce(null);
    const { runAgentPipeline } = await import("./run-service");

    await expect(runAgentPipeline({
      userId: "user_1", sessionId: "other_session", executionId: "execution_1", autonomous: false,
      aiConfig: { provider: "minimax", model: "MiniMax-M3", apiKey: "key" },
    })).resolves.toBeNull();

    expect(mocks.executionFindFirst).toHaveBeenCalledWith({
      where: { id: "execution_1", userId: "user_1", sessionId: "other_session" },
    });
    expect(mocks.createRecorder).not.toHaveBeenCalled();
    expect(mocks.executionUpdateMany).not.toHaveBeenCalled();
  });

  it("derives the canonical session when an execution id is supplied without a session id", async () => {
    const { runAgentPipeline } = await import("./run-service");

    await expect(runAgentPipeline({
      userId: "user_1", executionId: "execution_1", autonomous: false,
      aiConfig: { provider: "minimax", model: "MiniMax-M3", apiKey: "key" },
    })).resolves.toMatchObject({ processed: 1 });

    expect(mocks.createRecorder).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sessionId: "session_1" }));
    expect(mocks.runPipeline).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session_1" }));
  });

  it("suppresses preflight error writes and finalization if the execution is reclaimed during config lookup", async () => {
    let attemptCurrent = true;
    let enteredConfigLookup!: () => void;
    let resolveConfig!: (value: null) => void;
    const configLookupStarted = new Promise<void>(resolve => { enteredConfigLookup = resolve; });
    const pendingConfig = new Promise<null>(resolve => { resolveConfig = resolve; });
    mocks.executionFindFirst.mockImplementation(async rawArgs => {
      const args = rawArgs as { where?: { status?: string } };
      if (args.where?.status === "running") return attemptCurrent ? { id: "execution_1" } : null;
      return { id: "execution_1", sessionId: "session_1", state: null };
    });
    mocks.findConfig.mockImplementation(() => {
      enteredConfigLookup();
      return pendingConfig;
    });
    const { runAgentPipeline } = await import("./run-service");

    const run = runAgentPipeline({
      userId: "user_1", sessionId: "session_1", autonomous: true,
      aiConfig: { provider: "minimax", model: "MiniMax-M3", apiKey: "key" },
    });
    await configLookupStarted;
    attemptCurrent = false;
    resolveConfig(null);
    await expect(run).resolves.toBeNull();

    expect(mocks.record).not.toHaveBeenCalledWith("error", expect.anything());
    expect(mocks.finalize).not.toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    expect(mocks.executionUpdateMany).toHaveBeenCalledOnce();
  });

  it("does not activate the recorder when the request signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { runAgentPipeline } = await import("./run-service");

    await expect(runAgentPipeline({
      userId: "user_1", sessionId: "session_1", autonomous: false, signal: controller.signal,
      aiConfig: { provider: "minimax", model: "MiniMax-M3", apiKey: "key" },
    })).resolves.toBeNull();

    expect(mocks.createRecorder).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.executionUpdateMany).not.toHaveBeenCalled();
  });

  it("records a failed session when the user has not configured the Agent", async () => {
    mocks.findConfig.mockResolvedValue(null);
    const { runAgentPipeline } = await import("./run-service");

    await expect(runAgentPipeline({
      userId: "user_1", autonomous: true,
      aiConfig: { provider: "minimax", model: "MiniMax-M3", apiKey: "key" },
    })).resolves.toBeNull();

    expect(mocks.record).toHaveBeenCalledWith("error", expect.objectContaining({ message: expect.stringContaining("not configured") }));
    expect(mocks.finalize).toHaveBeenCalledWith({ status: "failed", report: null });
  });

  it("stops a queued run when the account is no longer active", async () => {
    mocks.findUser.mockResolvedValue({ accountStatus: "suspended" })
    const { runAgentPipeline } = await import("./run-service")

    await expect(runAgentPipeline({
      userId: "user_1", autonomous: true,
      aiConfig: { provider: "minimax", model: "MiniMax-M3", apiKey: "key" },
    })).resolves.toBeNull()

    expect(mocks.runPipeline).not.toHaveBeenCalled()
    expect(mocks.executionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "failed", error: "Account is not active" }),
    }))
    expect(mocks.finalize).toHaveBeenCalledWith({ status: "failed", report: null })
  })

  it("fails closed when the current account state cannot be read", async () => {
    mocks.findUser.mockRejectedValue(new Error("database unavailable"))
    const { runAgentPipeline } = await import("./run-service")

    await expect(runAgentPipeline({
      userId: "user_1", autonomous: true,
      aiConfig: { provider: "minimax", model: "MiniMax-M3", apiKey: "key" },
    })).resolves.toBeNull()

    expect(mocks.runPipeline).not.toHaveBeenCalled()
    expect(mocks.finalize).toHaveBeenCalledWith({ status: "failed", report: null })
  })

  it("keeps a user-cancelled execution cancelled when the pipeline returns late", async () => {
    mocks.executionUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const { runAgentPipeline } = await import("./run-service");

    await expect(runAgentPipeline({
      userId: "user_1", autonomous: false,
      aiConfig: { provider: "minimax", model: "MiniMax-M3", apiKey: "key" },
    })).resolves.toBeNull();

    expect(mocks.finalize).not.toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });

  it("preserves a committed terminal result when the request signal aborts afterward", async () => {
    const controller = new AbortController()
    mocks.createRecorder.mockResolvedValueOnce({ sessionId: "session_1", activate: mocks.activate, getTurnId: vi.fn(() => "turn_1"), record: mocks.record, finalize: mocks.finalize, pause: mocks.pause })
    mocks.executionFindFirst.mockImplementation(async rawArgs => {
      const args = rawArgs as { where?: { status?: string } }
      if (args.where?.status === "completed") controller.abort()
      return { id: "execution_1" }
    })
    const { runAgentPipeline } = await import("./run-service")

    await expect(runAgentPipeline({
      userId: "user_1", sessionId: "session_1", turnId: "turn_1", autonomous: false, signal: controller.signal,
      aiConfig: { provider: "minimax", model: "MiniMax-M3", apiKey: "key" },
    })).resolves.toMatchObject({ processed: 1 })

    expect(mocks.turnFindFirst).toHaveBeenCalledWith({
      where: { id: "turn_1", userId: "user_1", sessionId: "session_1", status: { in: ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] } },
      select: { id: true },
    })
    expect(mocks.finalize).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }))
  })

  it("does not terminalize a committed result after Stop interrupts its exact Turn", async () => {
    const controller = new AbortController()
    mocks.createRecorder.mockResolvedValueOnce({ sessionId: "session_1", activate: mocks.activate, getTurnId: vi.fn(() => "turn_1"), record: mocks.record, finalize: mocks.finalize, pause: mocks.pause })
    mocks.executionFindFirst.mockImplementation(async rawArgs => {
      const args = rawArgs as { where?: { status?: string } }
      if (args.where?.status === "completed") controller.abort()
      return { id: "execution_1" }
    })
    mocks.turnFindFirst.mockResolvedValue(null)
    const { runAgentPipeline } = await import("./run-service")

    await expect(runAgentPipeline({
      userId: "user_1", sessionId: "session_1", turnId: "turn_1", autonomous: false, signal: controller.signal,
      aiConfig: { provider: "minimax", model: "MiniMax-M3", apiKey: "key" },
    })).resolves.toBeNull()

    expect(mocks.finalize).not.toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }))
  })

  it("keeps a completed run visible for review when application packages are pending", async () => {
    mocks.runPipeline.mockResolvedValue({ processed: 2, queued: 0, applied: 0, pending: 2, skipped: 0, failed: 0, durationMs: 10 });
    const { runAgentPipeline } = await import("./run-service");

    await expect(runAgentPipeline({
      userId: "user_1", autonomous: false,
      aiConfig: { provider: "minimax", model: "MiniMax-M3", apiKey: "key" },
    })).resolves.toMatchObject({ pending: 2 });

    expect(mocks.pause).toHaveBeenCalledWith(expect.stringContaining("2 application packages"), "reviewer");
    expect(mocks.finalize).not.toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });
});
