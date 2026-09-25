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
const mockPageRouting = vi.hoisted(() => ({
  matcher: undefined as ((url: { href: string }) => boolean) | undefined,
  handler: undefined as unknown,
  existingPages: [] as unknown[],
  otherTabPage: {},
  popupPage: {},
  mainFrame: { page: () => undefined } as { page: () => unknown },
  iframeFrame: { page: () => undefined } as { page: () => unknown },
  otherTabFrame: { page: () => undefined } as { page: () => unknown },
  popupFrame: { page: () => undefined } as { page: () => unknown },
}));
const mockContext = vi.hoisted(() => ({
  pages: vi.fn(() => mockPageRouting.existingPages),
  route: vi.fn(async (matcher: unknown, handler: unknown) => {
    mockPageRouting.matcher = matcher as (url: { href: string }) => boolean;
    mockPageRouting.handler = handler;
  }),
  unroute: vi.fn().mockResolvedValue(undefined),
}));
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
  context: vi.fn(() => mockContext),
  mainFrame: vi.fn(() => mockPageRouting.mainFrame),
  on: vi.fn((event: string, handler: (request: { method(): string; isNavigationRequest(): boolean }) => void) => {
    void event;
    void handler;
  }),
  evaluate: vi.fn().mockResolvedValue(false),
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

type MockRequestRoute = {
  request(): { url(): string; method(): string; frame(): { page(): unknown }; isNavigationRequest(): boolean };
  continue(): Promise<void>;
  abort(reason?: string): Promise<void>;
  fallback(): Promise<void>;
};

async function dispatchPageRequest(url: string, method: string, options: { continueError?: Error; frame?: "main" | "iframe" | "other-tab" | "popup" | "unknown"; navigation?: boolean } = {}): Promise<{
  continue: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  fallback: ReturnType<typeof vi.fn>;
} | null> {
  const matcher = mockPageRouting.matcher;
  if (matcher && !matcher(new URL(url))) return null;
  const requestFrame = options.frame === "iframe"
    ? mockPageRouting.iframeFrame
    : options.frame === "other-tab"
      ? mockPageRouting.otherTabFrame
      : options.frame === "popup"
        ? mockPageRouting.popupFrame
        : options.frame === "unknown"
          ? null
          : mockPageRouting.mainFrame;
  const route = {
    request: () => ({
      url: () => url,
      method: () => method,
      frame: () => {
        if (requestFrame === null) throw new Error("frame is unavailable");
        return requestFrame;
      },
      isNavigationRequest: () => options.navigation ?? false,
    }),
    continue: vi.fn(async () => {
      mockProviderSubmitClick();
      if (options.continueError) throw options.continueError;
    }),
    abort: vi.fn().mockResolvedValue(undefined),
    fallback: vi.fn().mockResolvedValue(undefined),
  };
  const handler = mockPageRouting.handler as ((value: MockRequestRoute) => Promise<void>) | undefined;
  if (handler) await handler(route);
  return route;
}

function configureMockBrowserSubmitTool(): void {
  submitToolMocks.create.mockImplementation(({ submit }: { submit: (input: unknown) => Promise<unknown> }) => ({
    execute: async () => {
      try {
        return await submit({ target: {}, artifact: {}, context: {}, beforeSubmit: async () => true });
      } catch (error) {
        const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code
          : "browser_failed";
        return {
          status: errorCode === "browser_manual" ? "manual" : "failed",
          confirmationId: null,
          postSubmitUrl: null,
          errorCode,
          output: null,
        };
      }
    },
  }));
}

describe("apply-queue (unit — mocked)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsUserActive.mockResolvedValue(true);
    mockMarkSubmissionRequestStarted.mockReset().mockImplementation(async () =>
      !mockTurnState.interrupted && !["interrupted", "cancelled", "completed", "failed"].includes(mockTurnState.turnStatus)
    );
    mockProviderSubmitClick.mockReset();
    mockPageRouting.matcher = undefined;
    mockPageRouting.handler = undefined;
    mockPageRouting.existingPages = [mockPage, mockPageRouting.otherTabPage];
    mockPageRouting.mainFrame.page = () => mockPage;
    mockPageRouting.iframeFrame.page = () => mockPage;
    mockPageRouting.otherTabFrame.page = () => mockPageRouting.otherTabPage;
    mockPageRouting.popupFrame.page = () => mockPageRouting.popupPage;
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
    mockPage.evaluate.mockClear().mockResolvedValue(false);
    mockPage.context.mockClear();
    mockContext.pages.mockClear();
    mockContext.route.mockClear();
    mockContext.unroute.mockClear();
    approvalMocks.inspectSubmission.mockResolvedValue({
      type: "submit_application",
      status: "approved",
      scope: {
        userId: "user-1", sessionId: "agent-session-1", turnId: "agent-turn-1", jobId: "job-1",
        toolCallId: "application-submit:application-task-1", action: "submit_application",
      },
      payload: { applicationTaskId: "application-task-1", jobId: "job-1" },
    });
    mockHarnessRun.mockImplementation(async (_page: unknown, task: { allowSubmit?: boolean; beforeSubmit?: (intent?: { url: string; method: string }) => Promise<boolean> }) => {
      if (task.allowSubmit !== false && task.beforeSubmit) {
        if (!await task.beforeSubmit({ url: "https://example.com/jobs/123/apply", method: "POST" })) {
          return { status: "submission_blocked", error: "Submission guard denied.", durationMs: 123 };
        }
        if (mockPageRouting.handler) await dispatchPageRequest("https://example.com/jobs/123/apply", "POST");
        else mockProviderSubmitClick();
        if (!mockProviderSubmitClick.mock.calls.length) {
          return { status: "manual", error: "Submission request was blocked before network continuation.", durationMs: 123 };
        }
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

  it("keeps generic AgentHarness submission disabled when no exact request intent is supplied", async () => {
    configureMockBrowserSubmitTool();
    mockHarnessRun.mockImplementation(async (_page: unknown, task: { beforeSubmit?: (intent?: { url: string; method: string }) => Promise<boolean> }) => {
      const allowed = task.beforeSubmit ? await task.beforeSubmit() : false;
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

    expect(mockHarnessRun).toHaveBeenCalledOnce();
    expect(mockProviderSubmitClick).not.toHaveBeenCalled();
    expect(mockContext.route).not.toHaveBeenCalled();
    expect(mockMarkSubmissionRequestStarted).not.toHaveBeenCalled();
  });

  it("fails a receiptless submit before browser or provider execution", async () => {
    await import("./apply-queue.js");

    await mockProcessor({
      data: {
        applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1",
        applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
      },
    });

    expect(mockWithCloakContext).not.toHaveBeenCalled();
    expect(submitToolMocks.create).not.toHaveBeenCalled();
    expect(mockHarnessRun).not.toHaveBeenCalled();
    expect(mockContext.route).not.toHaveBeenCalled();
    expect(mockProviderSubmitClick).not.toHaveBeenCalled();
    expect(mockMarkSubmissionRequestStarted).not.toHaveBeenCalled();
    expect(mockInsertApplyResult).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      error: "Canonical application submission requires both receiptId and constraintHash.",
    }));
    expect(mockFinishApplicationTask).toHaveBeenCalledWith(
      expect.anything(),
      "application-task-1",
      "failed",
      "worker_failed",
      "Canonical application submission requires both receiptId and constraintHash.",
    );
  });

  it("rejects a GET intent before guard approval, provider execution, or checkpoint", async () => {
    configureMockBrowserSubmitTool();
    let allowed: boolean | undefined;
    mockHarnessRun.mockImplementation(async (_page: unknown, task: { beforeSubmit?: (intent?: { url: string; method: string }) => Promise<boolean> }) => {
      allowed = task.beforeSubmit
        ? await task.beforeSubmit({ url: "https://example.com/jobs/123/apply", method: "GET" })
        : false;
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

    expect(allowed).toBe(false);
    expect(mockContext.route).not.toHaveBeenCalled();
    expect(mockProviderSubmitClick).not.toHaveBeenCalled();
    expect(mockMarkSubmissionRequestStarted).not.toHaveBeenCalled();
  });

  it("fails closed when a Service Worker controls the approved submission page", async () => {
    mockPage.evaluate.mockResolvedValue(true);
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
    mockHarnessRun.mockImplementation(async (_page: unknown, task: { beforeSubmit?: (intent?: { url: string; method: string }) => Promise<boolean> }) => {
      const allowed = task.beforeSubmit
        ? await task.beforeSubmit({ url: "https://example.com/jobs/123/apply", method: "POST" })
        : false;
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

    expect(mockPage.evaluate).toHaveBeenCalledOnce();
    expect(mockContext.route).not.toHaveBeenCalled();
    expect(mockMarkSubmissionRequestStarted).not.toHaveBeenCalled();
    expect(mockProviderSubmitClick).not.toHaveBeenCalled();
    expect(mockInsertApplyResult).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      error: "Agent turn state could not be verified, so the application was not submitted.",
    }));
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
    mockHarnessRun.mockImplementation(async (_page: unknown, task: { beforeSubmit?: (intent?: { url: string; method: string }) => Promise<boolean> }) => {
      const intent = { url: "https://example.com/jobs/123/apply", method: "POST" };
      const allowed = task.beforeSubmit ? await task.beforeSubmit(intent) : false;
      if (!allowed) return { status: "submission_blocked", error: null, durationMs: 123 };

      // Unrelated writes stay outside the URL matcher. An iframe or a tab
      // that existed before arming falls through even at the exact action URL.
      const telemetryRequest = await dispatchPageRequest("https://example.com/telemetry", "POST");
      expect(telemetryRequest?.abort).toHaveBeenCalledOnce();
      const safeRead = await dispatchPageRequest("https://example.com/assets/pixel", "GET");
      expect(safeRead?.fallback).toHaveBeenCalledOnce();
      const iframeRequest = await dispatchPageRequest(intent.url, intent.method, { frame: "iframe" });
      expect(iframeRequest?.fallback).toHaveBeenCalledOnce();
      const otherTabRequest = await dispatchPageRequest(intent.url, intent.method, { frame: "other-tab" });
      expect(otherTabRequest?.fallback).toHaveBeenCalledOnce();
      const unknownFrameRequest = await dispatchPageRequest(intent.url, intent.method, { frame: "unknown" });
      expect(unknownFrameRequest?.abort).toHaveBeenCalledOnce();
      const mutatedMethod = await dispatchPageRequest(intent.url, "GET", { frame: "main" });
      expect(mutatedMethod?.abort).toHaveBeenCalledOnce();
      const changedActionUrl = await dispatchPageRequest("https://example.com/jobs/123/alternate-action", "POST");
      expect(changedActionUrl?.abort).toHaveBeenCalledOnce();
      const changedNavigation = await dispatchPageRequest("https://example.com/jobs/123/new-target", "GET", { navigation: true });
      expect(changedNavigation?.abort).toHaveBeenCalledOnce();
      expect(mockMarkSubmissionRequestStarted).not.toHaveBeenCalled();

      // Stop wins while the actual ATS request is still paused before network.
      mockTurnState.turnStatus = "interrupted";
      mockTurnState.interrupted = true;
      const route = await dispatchPageRequest(intent.url, intent.method);
      expect(route?.abort).toHaveBeenCalledOnce();
      return { status: "manual", error: "Submission request was stopped.", durationMs: 123 };
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
    expect(mockPageRouting.matcher?.(new URL("https://example.com/telemetry"))).toBe(true);
    expect(mockContext.route).toHaveBeenCalledOnce();
    expect(mockInsertApplyResult).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", error: "Agent turn was stopped before the application submission request started." }));
    expect(mockFinishApplicationTask).toHaveBeenCalledWith(expect.anything(), "application-task-1", "failed", "turn_stopped_before_submit", expect.stringContaining("stopped before"));
    expect(mockPage.close).toHaveBeenCalled();
  });

  it("aborts popup first requests at the intent URL and a different URL", async () => {
    configureMockBrowserSubmitTool();
    let allowed: boolean | undefined;
    const popupRoutes: Array<NonNullable<Awaited<ReturnType<typeof dispatchPageRequest>>>> = [];
    mockHarnessRun.mockImplementation(async (_page: unknown, task: { beforeSubmit?: (intent?: { url: string; method: string }) => Promise<boolean> }) => {
      allowed = task.beforeSubmit
        ? await task.beforeSubmit({ url: "https://example.com/jobs/123/apply", method: "POST" })
        : false;
      if (allowed) {
        const actionRoute = await dispatchPageRequest("https://example.com/jobs/123/apply", "POST", { frame: "popup" });
        const otherUrlRoute = await dispatchPageRequest("https://popup.example.net/first-document", "GET", { frame: "popup" });
        if (actionRoute) popupRoutes.push(actionRoute);
        if (otherUrlRoute) popupRoutes.push(otherUrlRoute);
      }
      return { status: "manual", error: "Popup request was blocked before network continuation.", durationMs: 123 };
    });

    await import("./apply-queue.js");
    await mockProcessor({
      data: {
        applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1",
        applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
        receiptId: "approval-1", constraintHash: "c".repeat(64),
      },
    });

    expect(allowed).toBe(true);
    expect(popupRoutes).toHaveLength(2);
    for (const popupRoute of popupRoutes) {
      expect(popupRoute.abort).toHaveBeenCalledOnce();
      expect(popupRoute.continue).not.toHaveBeenCalled();
    }
    expect(mockMarkSubmissionRequestStarted).not.toHaveBeenCalled();
    expect(mockProviderSubmitClick).not.toHaveBeenCalled();
    expect(mockInsertApplyResult).toHaveBeenCalledWith(expect.objectContaining({
      status: "manual",
      error: "browser_manual",
    }));
  });

  it.each(["GET", "HEAD", "OPTIONS"] as const)(
    "aborts post-start %s requests to the armed action URL from the source page and a popup",
    async (method) => {
      configureMockBrowserSubmitTool();
      const changedMethodRoutes: Array<NonNullable<Awaited<ReturnType<typeof dispatchPageRequest>>>> = [];
      const approvedPosts: Array<NonNullable<Awaited<ReturnType<typeof dispatchPageRequest>>>> = [];
      const confirmationReads: Array<NonNullable<Awaited<ReturnType<typeof dispatchPageRequest>>>> = [];
      mockHarnessRun.mockImplementation(async (_page: unknown, task: { beforeSubmit?: (intent?: { url: string; method: string }) => Promise<boolean> }) => {
        const intent = { url: "https://example.com/jobs/123/apply", method: "POST" };
        const allowed = task.beforeSubmit ? await task.beforeSubmit(intent) : false;
        if (!allowed) return { status: "submission_blocked", error: "Submission guard denied.", durationMs: 123 };

        const approvedPost = await dispatchPageRequest(intent.url, intent.method, { frame: "main" });
        const changedMainFrame = await dispatchPageRequest(intent.url, method, { frame: "main" });
        const changedPopup = await dispatchPageRequest(intent.url, method, { frame: "popup" });
        const changedUnknown = await dispatchPageRequest(intent.url, method, { frame: "unknown" });
        const confirmationRead = await dispatchPageRequest(
          "https://example.com/application/confirmation",
          "GET",
          { frame: "popup", navigation: true },
        );
        if (approvedPost) approvedPosts.push(approvedPost);
        if (changedMainFrame) changedMethodRoutes.push(changedMainFrame);
        if (changedPopup) changedMethodRoutes.push(changedPopup);
        if (changedUnknown) changedMethodRoutes.push(changedUnknown);
        if (confirmationRead) confirmationReads.push(confirmationRead);
        return { status: "manual", error: "Submission outcome is uncertain.", durationMs: 123 };
      });

      await import("./apply-queue.js");
      await mockProcessor({
        data: {
          applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1",
          applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
          receiptId: "approval-1", constraintHash: "c".repeat(64),
        },
      });

      expect(approvedPosts).toHaveLength(1);
      expect(approvedPosts[0]?.continue).toHaveBeenCalledOnce();
      expect(mockMarkSubmissionRequestStarted).toHaveBeenCalledOnce();
      expect(changedMethodRoutes).toHaveLength(3);
      for (const route of changedMethodRoutes) {
        expect(route.abort).toHaveBeenCalledOnce();
        expect(route.fallback).not.toHaveBeenCalled();
      }
      expect(confirmationReads).toHaveLength(1);
      expect(confirmationReads[0]?.fallback).toHaveBeenCalledOnce();
    },
  );

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
    mockHarnessRun.mockImplementation(async (_page: unknown, task: { beforeSubmit?: (intent?: { url: string; method: string }) => Promise<boolean> }) => {
      const intent = { url: "https://example.com/jobs/123/apply", method: "POST" };
      const allowed = task.beforeSubmit ? await task.beforeSubmit(intent) : false;
      if (!allowed) return { status: "submission_blocked", error: "Submission guard denied.", durationMs: 123 };
      mockProviderSubmitClick.mockImplementationOnce(() => {
        expect(mockTurnClient.query).toHaveBeenLastCalledWith(
          expect.stringContaining('FROM "agent_events"'),
          expect.any(Array),
        );
      });
      await dispatchPageRequest(intent.url, intent.method);
      const confirmationNavigation = await dispatchPageRequest("https://example.com/jobs/123/confirmation", "GET", { navigation: true });
      expect(confirmationNavigation?.fallback).toHaveBeenCalledOnce();
      const confirmationPage = await dispatchPageRequest("https://example.com/application/confirmation", "GET", { frame: "popup", navigation: true });
      expect(confirmationPage?.fallback).toHaveBeenCalledOnce();
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

  it("keeps a continuation error in the started and uncertain state", async () => {
    submitToolMocks.create.mockImplementation(({ submit }: { submit: (input: unknown) => Promise<unknown> }) => ({
      execute: async () => {
        try {
          await submit({ target: {}, artifact: {}, context: {}, beforeSubmit: async () => true });
          return { status: "submitted", confirmationId: "application:application-task-1", postSubmitUrl: null, errorCode: null, output: null };
        } catch {
          return { status: "failed", confirmationId: null, postSubmitUrl: null, errorCode: "browser_manual", output: null };
        }
      },
    }));
    mockHarnessRun.mockImplementation(async (_page: unknown, task: { beforeSubmit?: (intent?: { url: string; method: string }) => Promise<boolean> }) => {
      const intent = { url: "https://example.com/jobs/123/apply", method: "POST" };
      const allowed = task.beforeSubmit ? await task.beforeSubmit(intent) : false;
      if (!allowed) return { status: "submission_blocked", error: "Submission guard denied.", durationMs: 123 };
      const route = await dispatchPageRequest(intent.url, intent.method, { continueError: new Error("browser route closed") });
      expect(route?.continue).toHaveBeenCalledOnce();
      return { status: "failed", error: "The route continuation failed.", durationMs: 123 };
    });

    await import("./apply-queue.js");
    await mockProcessor({
      data: {
        applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1",
        applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
        receiptId: "approval-1", constraintHash: "c".repeat(64),
      },
    });

    expect(mockMarkSubmissionRequestStarted).toHaveBeenCalledOnce();
    expect(mockProviderSubmitClick).toHaveBeenCalledOnce();
    expect(mockTurnClient.query).toHaveBeenCalledWith("COMMIT");
    expect(mockTurnClient.query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(mockInsertApplyResult).toHaveBeenCalledWith(expect.objectContaining({
      status: "manual",
      error: expect.stringContaining("started"),
    }));
  });

  it("fills without submission, then creates the durable final-review checkpoint", async () => {
    mockPage.evaluate.mockResolvedValue({ missing: [], sensitive: [] });
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
