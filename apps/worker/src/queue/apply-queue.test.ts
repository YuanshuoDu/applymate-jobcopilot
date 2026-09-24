import { describe, it, expect, vi, beforeEach } from "vitest";

const mockProcessor = vi.fn();
const mockUpsertFormPattern = vi.fn().mockResolvedValue(undefined);
const mockIncrementBudget = vi.fn().mockResolvedValue(undefined);
const mockInsertApplyResult = vi.fn().mockResolvedValue(1);
const mockCompleteFillForReview = vi.fn().mockResolvedValue(undefined);
const mockFinishApplicationTask = vi.fn().mockResolvedValue(undefined);
const mockHarnessRun = vi.fn();
const mockWithCloakContext = vi.fn();
const mockIsUserActive = vi.fn().mockResolvedValue(true);
const mockSubmitContext = vi.fn();
const mockMarkSubmissionRequestStarted = vi.fn().mockResolvedValue(true);
const mockProviderSubmitClick = vi.fn();
const mockPageRequest = vi.hoisted(() => ({ handler: undefined as ((request: { method(): string; isNavigationRequest(): boolean }) => void) | undefined }));
const mockTurnState = vi.hoisted(() => ({ sessionStatus: "running", turnStatus: "in_progress", interrupted: false }));
const mockPoolQuery = vi.hoisted(() => vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }));
const mockTurnClient = vi.hoisted(() => ({
  query: vi.fn(async (sql: string) => {
    if (sql.includes('FROM "agent_sessions"')) return { rows: [{ status: mockTurnState.sessionStatus }], rowCount: 1 };
    if (sql.includes('FROM "agent_turns"')) return { rows: [{ status: mockTurnState.turnStatus }], rowCount: 1 };
    if (sql.includes('FROM "agent_events"')) return { rows: [{ stopped: mockTurnState.interrupted }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }),
  release: vi.fn(),
}));
const mockPage = vi.hoisted(() => ({
  goto: vi.fn().mockResolvedValue(undefined),
  url: vi.fn().mockReturnValue("https://example.com/jobs/123/apply"),
  close: vi.fn().mockResolvedValue(undefined),
  on: vi.fn((event: string, handler: (request: { method(): string; isNavigationRequest(): boolean }) => void) => {
    if (event === "request") mockPageRequest.handler = handler;
  }),
}));
const approvalMocks = vi.hoisted(() => ({ inspectSubmission: vi.fn() }));
const submitToolMocks = vi.hoisted(() => ({
  create: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(() => ({
    ping: vi.fn().mockResolvedValue("PONG"),
    disconnect: vi.fn(),
  })),
}));

vi.mock("bullmq", () => {
  const mockWorker = {
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    isRunning: vi.fn().mockReturnValue(true),
  };
  const mockWorkerCtor = vi.fn().mockImplementation((_name, processor) => {
    mockProcessor.mockImplementation(processor);
    return mockWorker;
  });
  const mockQueueCtor = vi.fn().mockReturnValue({
    add: vi.fn().mockResolvedValue({ id: "test-job-1" }),
    isPaused: vi.fn().mockResolvedValue(false),
  });
  return {
    Worker: mockWorkerCtor,
    Queue: mockQueueCtor,
  };
});

vi.mock("../cloak/pool.js", () => ({
  withCloakContext: mockWithCloakContext.mockImplementation(
    async (_userId: string, fn: (page: unknown) => Promise<void>) => {
      await fn(mockPage);
    }
  ),
  closeAllSlots: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../db/apply-results.js", () => ({
  insertApplyResult: mockInsertApplyResult,
  getPool: vi.fn().mockReturnValue({
    query: mockPoolQuery,
    connect: vi.fn().mockResolvedValue(mockTurnClient),
  }),
}));

vi.mock("../runtime/approval/pg-store.js", () => ({
  createPgApprovalStore: vi.fn(() => ({ inspectSubmission: approvalMocks.inspectSubmission })),
}));

vi.mock("../rate-limit.js", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("../cloak/captcha.js", () => ({
  detectCaptcha: vi.fn().mockResolvedValue(false),
}));

vi.mock("../db/application-task-state.js", () => ({
  claimApplicationTask: vi.fn().mockResolvedValue(true),
  applicationTaskStillActive: vi.fn().mockResolvedValue(true),
  completeFillForReview: mockCompleteFillForReview,
  finishApplicationTask: mockFinishApplicationTask,
  isUserActive: mockIsUserActive,
  markSubmissionRequestStarted: mockMarkSubmissionRequestStarted,
  needsUserTakeover: vi.fn().mockReturnValue(false),
  USER_TAKEOVER_CHECKPOINT: "user_takeover",
}));

vi.mock("../db/budget.js", () => ({
  checkBudget: vi.fn().mockResolvedValue({ allowed: true, used: 0, limit: 100 }),
  incrementBudget: mockIncrementBudget,
}));

vi.mock("../db/form-patterns.js", () => ({
  findFormPattern: vi.fn().mockResolvedValue(null),
  recordPatternFailure: vi.fn().mockResolvedValue(undefined),
  upsertFormPattern: mockUpsertFormPattern,
}));

vi.mock("../db/load-task-context.js", () => ({
  loadTaskContext: vi.fn().mockResolvedValue({
    applyUrl: "https://example.com/jobs/123/apply",
    persona: { fullName: "Jane Doe" },
    coverLetterText: "",
    jobTitle: "Engineer",
    jobCompany: "Example",
    jobKeywords: "TypeScript",
    resumeTempPath: null,
  }),
}));

vi.mock("../flows/index.js", () => ({
  detectFlow: vi.fn().mockReturnValue(null),
}));

vi.mock("../flows/greenhouse-flow.js", () => ({ runGreenhouseFlow: vi.fn() }));
vi.mock("../flows/workday-flow.js", () => ({ runWorkdayFlow: vi.fn() }));
vi.mock("../flows/lever-flow.js", () => ({ runLeverFlow: vi.fn() }));
vi.mock("../flows/personio-flow.js", () => ({ runPersonioFlow: vi.fn() }));
vi.mock("../patterns/confidence.js", () => ({ shouldUsePattern: vi.fn().mockReturnValue(false) }));
vi.mock("../patterns/replay.js", () => ({ replayPattern: vi.fn() }));
vi.mock("../notifications/create-notification.js", () => ({ createNotification: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../notifications/notify-apply-result.js", () => ({ notifyApplyResult: vi.fn().mockResolvedValue(undefined) }));

vi.mock("../harness/agent-harness.js", () => ({
  AgentHarness: vi.fn().mockImplementation(() => ({
    run: mockHarnessRun,
  })),
}));
vi.mock("../runtime/tools/application-submit-tool.js", () => ({
  createPgApplicationSubmitTool: submitToolMocks.create,
}));

describe("apply-queue (unit — mocked)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsUserActive.mockResolvedValue(true);
    mockMarkSubmissionRequestStarted.mockReset().mockImplementation(async () =>
      !mockTurnState.interrupted && !["interrupted", "cancelled", "completed", "failed"].includes(mockTurnState.turnStatus)
    );
    mockProviderSubmitClick.mockReset();
    mockPageRequest.handler = undefined;
    submitToolMocks.create.mockReset();
    submitToolMocks.execute.mockReset();
    mockPoolQuery.mockResolvedValue({ rowCount: 1, rows: [] });
    mockTurnState.sessionStatus = "running";
    mockTurnState.turnStatus = "in_progress";
    mockTurnState.interrupted = false;
    mockTurnClient.query.mockClear();
    mockTurnClient.release.mockClear();
    mockPage.goto.mockClear();
    mockPage.close.mockClear();
    mockPage.on.mockClear();
    approvalMocks.inspectSubmission.mockResolvedValue({
      type: "submit_application",
      status: "approved",
      scope: {
        userId: "user-1", sessionId: "agent-session-1", turnId: "agent-turn-1", jobId: "job-1",
        toolCallId: "application-submit:application-task-1", action: "submit_application",
      },
      payload: { applicationTaskId: "application-task-1", jobId: "job-1" },
    });
    mockHarnessRun.mockImplementation(async (_page: unknown, task: { allowSubmit?: boolean; beforeSubmit?: () => Promise<boolean> }) => {
      if (task.allowSubmit !== false && task.beforeSubmit) {
        if (!await task.beforeSubmit()) return { status: "submission_blocked", error: "Submission guard denied.", durationMs: 123 };
        mockProviderSubmitClick();
        mockPageRequest.handler?.({ method: () => "POST", isNavigationRequest: () => false });
      }
      return task.allowSubmit === false
        ? { status: "manual", error: "Form filled and ready for user review.", durationMs: 123, reviewReady: true }
        : { status: "submitted", error: null, durationMs: 123, fieldMappings: { "#name": "fullName" } };
    });
  });

  it("creates a worker on the apply-tasks queue", async () => {
    const mod = await import("./apply-queue.js");
    expect(mod.QUEUE_NAME).toBe("apply-tasks");
    expect(mod.applyWorker).toBeDefined();
  }, 15_000);

  it("can enqueue a task", async () => {
    const mod = await import("./apply-queue.js");
    const job = await mod.applyQueue.add("test", {
      applicationTaskId: "application-task-1",
      operation: "submit",
      jobId: "job-1",
      userId: "user-1",
      applyUrl: "https://example.com/jobs/1",
      personaId: "persona-1",
      resumePath: "/resume.pdf",
      dryRun: true,
    });
    expect(job.id).toBe("test-job-1");
  });

  it("writes form pattern mappings after successful AI fallback", async () => {
    submitToolMocks.create.mockImplementation(({ submit }: { submit: (input: unknown) => Promise<unknown> }) => ({
      execute: async () => {
        await submit({ target: {}, artifact: {}, context: {}, beforeSubmit: async () => true });
        return { status: "submitted", confirmationId: "application:application-task-1", postSubmitUrl: null, errorCode: null, output: null };
      },
    }));
    await import("./apply-queue.js");

    await mockProcessor({
      data: {
        applicationTaskId: "application-task-1",
        operation: "submit",
        jobId: "job-1",
        userId: "user-1",
        applyUrl: "https://example.com/jobs/123/apply",
        personaId: "persona-1",
        resumePath: "/resume.pdf",
        dryRun: false,
        receiptId: "approval-1", constraintHash: "c".repeat(64),
      },
    });

    expect(mockIncrementBudget).toHaveBeenCalledWith("user-1");
    expect(mockUpsertFormPattern).toHaveBeenCalledWith({
      userId: "user-1",
      atsHost: "example.com",
      urlPattern: "jobs/123/",
      fieldMapping: { "#name": "fullName" },
    });
    expect(mockInsertApplyResult).toHaveBeenCalledWith(expect.objectContaining({
      status: "submitted",
      flowUsed: "application.submit",
    }));
  });

  it("routes a receipt-backed submit through application.submit before the browser flow", async () => {
    submitToolMocks.execute.mockResolvedValue({
      status: "submitted", confirmationId: "application:application-task-1", postSubmitUrl: "https://example.com/confirmation", errorCode: null, output: null,
    });
    submitToolMocks.create.mockImplementation(({ submit }: { submit: (input: unknown) => Promise<unknown> }) => ({
      execute: async (context: { sessionId: string; turnId: string }) => {
        mockSubmitContext(context);
        await submit({ target: {}, artifact: {}, context: {}, beforeSubmit: async () => true });
        return submitToolMocks.execute();
      },
    }));

    await import("./apply-queue.js");
    await mockProcessor({
      data: {
        applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1",
        applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
        receiptId: "approval-1", constraintHash: "c".repeat(64),
      },
    });

    expect(submitToolMocks.create).toHaveBeenCalledWith(expect.objectContaining({ pool: expect.anything(), submit: expect.any(Function) }));
    expect(mockSubmitContext).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "agent-session-1", turnId: "agent-turn-1" }));
    expect(mockMarkSubmissionRequestStarted).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-1", sessionId: "agent-session-1", turnId: "agent-turn-1",
      applicationTaskId: "application-task-1", jobId: "job-1",
    });
    expect(mockProviderSubmitClick).toHaveBeenCalledOnce();
    expect(mockHarnessRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ allowSubmit: true }));
    expect(mockInsertApplyResult).toHaveBeenCalledWith(expect.objectContaining({ status: "submitted", flowUsed: "application.submit" }));
  });

  it("cancels an approved submission when Stop wins before the ATS request starts", async () => {
    submitToolMocks.create.mockImplementation(({ submit }: { submit: (input: unknown) => Promise<unknown> }) => ({
      execute: async () => {
        try {
          await submit({ target: {}, artifact: {}, context: {}, beforeSubmit: async () => true });
          return { status: "submitted", confirmationId: "application:application-task-1", postSubmitUrl: null, errorCode: null, output: null };
        } catch {
          return { status: "failed", confirmationId: null, postSubmitUrl: null, errorCode: "browser_412", output: null };
        }
      },
    }));
    mockHarnessRun.mockImplementation(async (_page: unknown, task: { beforeSubmit?: () => Promise<boolean> }) => {
      mockTurnState.turnStatus = "interrupted";
      mockTurnState.interrupted = true;
      const allowed = task.beforeSubmit ? await task.beforeSubmit() : false;
      if (allowed) {
        mockProviderSubmitClick();
        mockPageRequest.handler?.({ method: () => "POST", isNavigationRequest: () => false });
      }
      return { status: allowed ? "submitted" : "submission_blocked", error: null, durationMs: 123 };
    });

    await import("./apply-queue.js");
    await mockProcessor({
      data: {
        applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1",
        applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
        receiptId: "approval-1", constraintHash: "c".repeat(64),
      },
    });

    expect(mockMarkSubmissionRequestStarted).not.toHaveBeenCalled();
    expect(mockProviderSubmitClick).not.toHaveBeenCalled();
    expect(mockInsertApplyResult).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", error: "Agent turn was stopped before the application submission request started." }));
    expect(mockFinishApplicationTask).toHaveBeenCalledWith(expect.anything(), "application-task-1", "failed", "turn_stopped_before_submit", expect.stringContaining("stopped before"));
    expect(mockPage.close).toHaveBeenCalled();
  });

  it("attempts best-effort browser interruption after an approved ATS request starts", async () => {
    submitToolMocks.create.mockImplementation(({ submit }: { submit: (input: unknown) => Promise<unknown> }) => ({
      execute: async () => {
        try {
          await submit({ target: {}, artifact: {}, context: {}, beforeSubmit: async () => true });
          return { status: "submitted", confirmationId: "application:application-task-1", postSubmitUrl: null, errorCode: null, output: null };
        } catch (error) {
          return { status: "failed", confirmationId: null, postSubmitUrl: null, errorCode: (error as { code?: string }).code ?? "browser_manual", output: null };
        }
      },
    }));
    mockHarnessRun.mockImplementation(async (_page: unknown, task: { beforeSubmit?: () => Promise<boolean> }) => {
      const allowed = task.beforeSubmit ? await task.beforeSubmit() : false;
      if (!allowed) return { status: "submission_blocked", error: "Submission guard denied.", durationMs: 123 };
      mockProviderSubmitClick();
      mockPageRequest.handler?.({ method: () => "POST", isNavigationRequest: () => false });
      await new Promise((resolve) => setTimeout(resolve, 5));
      mockTurnState.turnStatus = "interrupted";
      mockTurnState.interrupted = true;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { status: "manual", error: "Submission outcome is unconfirmed after Stop.", durationMs: 123 };
    });

    await import("./apply-queue.js");
    await mockProcessor({
      data: {
        applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1",
        applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
        receiptId: "approval-1", constraintHash: "c".repeat(64),
      },
    });

    expect(mockPage.close).toHaveBeenCalled();
    expect(mockMarkSubmissionRequestStarted).toHaveBeenCalledOnce();
    expect(mockProviderSubmitClick).toHaveBeenCalledOnce();
    expect(mockInsertApplyResult).toHaveBeenCalledWith(expect.objectContaining({
      status: "manual",
      error: expect.not.stringMatching(/withdraw/i),
    }));
  });

  it("fills without submission, then creates the durable final-review checkpoint", async () => {
    await import("./apply-queue.js");
    await mockProcessor({
      data: {
        applicationTaskId: "application-task-1", operation: "fill", jobId: "job-1", userId: "user-1",
        applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
      },
    });
    expect(mockCompleteFillForReview).toHaveBeenCalledWith(expect.anything(), "application-task-1", "user-1", "job-1");
    expect(mockInsertApplyResult).toHaveBeenCalledWith(expect.objectContaining({ status: "manual", error: expect.stringContaining("ready for user review") }));
  });

  it("marks suspended queued tasks failed without opening a browser", async () => {
    mockIsUserActive.mockResolvedValue(false);
    await import("./apply-queue.js");

    await mockProcessor({
      data: {
        applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1",
        applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
      },
    });

    expect(mockWithCloakContext).not.toHaveBeenCalled();
  });
});
