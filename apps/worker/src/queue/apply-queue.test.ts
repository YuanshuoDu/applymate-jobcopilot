import { describe, it, expect, vi, beforeEach } from "vitest";

const mockProcessor = vi.fn();
const mockUpsertFormPattern = vi.fn().mockResolvedValue(undefined);
const mockIncrementBudget = vi.fn().mockResolvedValue(undefined);
const mockInsertApplyResult = vi.fn().mockResolvedValue(1);
const mockCompleteFillForReview = vi.fn().mockResolvedValue(undefined);
const mockFinishApplicationTask = vi.fn().mockResolvedValue(undefined);
const mockClaimApplicationTask = vi.fn().mockResolvedValue(true);
const mockHarnessRun = vi.fn();
const mockWithCloakContext = vi.fn();
const mockIsUserActive = vi.fn().mockResolvedValue(true);
const mockSubmitContext = vi.fn();
const mockMarkSubmissionRequestStarted = vi.fn().mockResolvedValue("started");
const mockClaimUnattendedSubmission = vi.fn().mockResolvedValue("claimed");
const mockReleaseUncertainSubmission = vi.fn().mockResolvedValue({ kind: "current", value: true });
const mockUpdateJobForSubmission = vi.fn().mockResolvedValue({ kind: "current", value: true });
const mockRecordSubmissionExecutionSettled = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const mockWorkerListeners = vi.hoisted(() => new Map<string, (job?: unknown) => Promise<void>>());
const mockRedisExists = vi.hoisted(() => vi.fn().mockResolvedValue(0));
const mockReconcileClaimedSubmissionUncertain = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const mockQueueGetJob = vi.hoisted(() => vi.fn());
const mockQueueIsPaused = vi.hoisted(() => vi.fn().mockResolvedValue(false));
const expectedSubmissionIdentity = {
  applicationTaskId: "application-task-1",
  userId: "user-1",
  jobId: "job-1",
  sessionId: "agent-session-1",
  fillTurnId: "agent-turn-1",
  approvalId: "approval-1",
  constraintHash: "c".repeat(64),
};
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
  close: vi.fn().mockResolvedValue(undefined),
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
    if (sql.includes('SELECT "sessionId" FROM application_tasks')) return { rows: [{ sessionId: "agent-session-1" }], rowCount: 1 };
    if (sql.includes('SELECT "id", "fillTurnId", "sessionId"')) return { rows: [{ id: "application-task-1", fillTurnId: null, sessionId: "agent-session-1", status: "filling", checkpoint: "form_fill_queued" }], rowCount: 1 };
    if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [{ id: "filler-1" }], rowCount: 1 };
    if (sql.includes('SELECT "sessionId", "fillTurnId", "fillTurnSessionId", "fillTurnUserId"')) {
      return { rows: [{ sessionId: "agent-session-1", fillTurnId: "agent-turn-1", fillTurnSessionId: "agent-session-1", fillTurnUserId: "user-1" }], rowCount: 1 };
    }
    if (sql.includes('FROM "Job"')) return { rows: [{ id: "job-1" }], rowCount: 1 };
    if (sql.includes("INSERT INTO apply_results")) return { rows: [{ id: 1 }], rowCount: 1 };
    if (sql.includes('FROM "agent_sessions"')) return { rows: [{ status: mockTurnState.sessionStatus }], rowCount: 1 };
    if (sql.includes('FROM "agent_turns"')) return { rows: [{ id: "agent-turn-1", status: mockTurnState.turnStatus }], rowCount: 1 };
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

vi.mock("../redis.js", () => ({ redisConnection: { exists: mockRedisExists } }));

vi.mock("bullmq", () => {
  const mockWorker = {
    on: vi.fn((event: string, listener: (job?: unknown) => Promise<void>) => mockWorkerListeners.set(event, listener)),
    close: vi.fn().mockResolvedValue(undefined),
    isRunning: vi.fn().mockReturnValue(true),
  };
  const mockWorkerCtor = vi.fn().mockImplementation((_name, processor) => {
    mockProcessor.mockImplementation((job) => processor({ id: job.id ?? "worker-task-test", ...job }));
    return mockWorker;
  });
  const mockQueueCtor = vi.fn().mockReturnValue({
    add: vi.fn().mockResolvedValue({ id: "test-job-1" }),
    client: Promise.resolve({
      get: vi.fn(async (key: string) => (await mockRedisExists(key)) === 0 ? null : "lock-token"),
    }),
    getJob: mockQueueGetJob,
    isPaused: mockQueueIsPaused,
    toKey: vi.fn((key: string) => `apply-tasks:${key}`),
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
  claimApplicationTask: mockClaimApplicationTask,
  applicationTaskStillActive: vi.fn().mockResolvedValue(true),
  completeFillForReview: mockCompleteFillForReview,
  finishApplicationTask: mockFinishApplicationTask,
  isUserActive: mockIsUserActive,
  markSubmissionRequestStarted: mockMarkSubmissionRequestStarted,
  needsUserTakeover: vi.fn().mockReturnValue(false),
  USER_TAKEOVER_CHECKPOINT: "user_takeover",
}));

vi.mock("./application-submit-fence.js", async importOriginal => ({
  ...await importOriginal<typeof import("./application-submit-fence.js")>(),
  recordSubmissionExecutionSettled: mockRecordSubmissionExecutionSettled,
}));

vi.mock("../db/submission-guard.js", () => ({
  claimUnattendedSubmission: mockClaimUnattendedSubmission,
  reconcileClaimedSubmissionUncertain: mockReconcileClaimedSubmissionUncertain,
  releaseUncertainSubmission: mockReleaseUncertainSubmission,
  updateJobForSubmission: mockUpdateJobForSubmission,
  UNCONFIRMED_SUBMISSION_MESSAGE: "The previous background attempt was interrupted after it started. ApplyMate did not retry it to avoid sending a duplicate application.",
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

type MockPageRouteResult = {
  continue: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  fallback: ReturnType<typeof vi.fn>;
};

async function dispatchPageRequest(url: string, method: string, options: { continueError?: Error; continueGate?: Promise<void>; continueNeverResolves?: boolean; frame?: "main" | "iframe" | "other-tab" | "popup" | "unknown"; navigation?: boolean; onRouteCreated?: (route: MockPageRouteResult) => void } = {}): Promise<MockPageRouteResult | null> {
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
      if (options.continueGate) await options.continueGate;
      if (options.continueNeverResolves) await new Promise<void>(() => undefined);
      if (options.continueError) throw options.continueError;
    }),
    abort: vi.fn().mockResolvedValue(undefined),
    fallback: vi.fn().mockResolvedValue(undefined),
  };
  options.onRouteCreated?.(route);
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

function terminalSubmitJob(attemptsMade = 3, attempts = 3, overrides: Record<string, unknown> = {}) {
  return {
    id: "bull-submit-1",
    data: {
      applicationTaskId: expectedSubmissionIdentity.applicationTaskId,
      userId: expectedSubmissionIdentity.userId,
      jobId: expectedSubmissionIdentity.jobId,
      sessionId: expectedSubmissionIdentity.sessionId,
      fillTurnId: expectedSubmissionIdentity.fillTurnId,
      receiptId: expectedSubmissionIdentity.approvalId,
      constraintHash: expectedSubmissionIdentity.constraintHash,
      operation: "submit",
      applyUrl: "https://example.com/jobs/1/apply",
      personaId: "persona-1",
      resumePath: "/resume.pdf",
      ...overrides,
    },
    attemptsMade,
    opts: { attempts },
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

describe("apply-queue (unit — mocked)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisExists.mockResolvedValue(0);
    mockQueueIsPaused.mockResolvedValue(false);
    mockQueueGetJob.mockReset().mockImplementation(async (id: string) => {
      if (id !== "bull-submit-1") return undefined;
      return { ...terminalSubmitJob(), getState: vi.fn().mockResolvedValue("completed") };
    });
    mockReconcileClaimedSubmissionUncertain.mockImplementation(async (
      _pool: unknown,
      _identity: unknown,
      _workerTaskId: string,
      isCurrentTerminalDelivery?: (client: unknown) => Promise<boolean>,
    ) => isCurrentTerminalDelivery ? isCurrentTerminalDelivery({
      query: async (sql: string) => sql.includes('FROM "application_tasks"')
        ? { rows: [{ id: "application-task-1", status: "filling", checkpoint: "browser_active" }], rowCount: 1 }
        : sql.includes('FROM "application_task_events"')
          ? { rows: [], rowCount: 0 }
          : { rows: [], rowCount: 1 },
    }) : true);
    mockIsUserActive.mockResolvedValue(true);
    mockClaimApplicationTask.mockReset().mockResolvedValue(true);
    mockMarkSubmissionRequestStarted.mockReset().mockImplementation(async () =>
      !mockTurnState.interrupted && !["interrupted", "cancelled", "completed", "failed"].includes(mockTurnState.turnStatus)
        ? "started"
        : "inactive"
    );
    mockFinishApplicationTask.mockReset().mockResolvedValue(undefined);
    mockClaimUnattendedSubmission.mockReset().mockResolvedValue("claimed");
    mockReleaseUncertainSubmission.mockReset().mockResolvedValue({ kind: "current", value: true });
    mockUpdateJobForSubmission.mockReset().mockResolvedValue({ kind: "current", value: true });
    mockRecordSubmissionExecutionSettled.mockReset().mockResolvedValue(true);
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
    mockPage.close.mockReset().mockResolvedValue(undefined);
    mockPage.on.mockClear();
    mockPage.evaluate.mockClear().mockResolvedValue(false);
    mockPage.context.mockClear();
    mockContext.pages.mockClear();
    mockContext.close.mockReset().mockResolvedValue(undefined);
    mockContext.route.mockClear();
    mockContext.unroute.mockClear();
    approvalMocks.inspectSubmission.mockResolvedValue({
      id: "approval-1",
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
    const { Worker } = await import("bullmq");
    const mod = await import("./apply-queue.js");
    expect(mod.QUEUE_NAME).toBe("apply-tasks");
    expect(mod.applyWorker).toBeDefined();
    expect(vi.mocked(Worker)).toHaveBeenCalledWith(
      "apply-tasks", expect.any(Function), expect.objectContaining({ autorun: false }),
    );
  }, 30_000);

  it("reconciles only the current completed exact submit delivery after its Redis lock is absent", async () => {
    await import("./apply-queue.js");
    const completed = mockWorkerListeners.get("completed");
    expect(completed).toBeDefined();
    if (!completed) throw new Error("completed listener was not registered");

    await completed(terminalSubmitJob());

    expect(mockQueueGetJob).toHaveBeenCalledWith("bull-submit-1");
    expect(mockRedisExists).toHaveBeenCalledWith("apply-tasks:bull-submit-1:lock");
    expect(mockReconcileClaimedSubmissionUncertain).toHaveBeenCalledWith(
      expect.anything(),
      { ...expectedSubmissionIdentity },
      "bull-submit-1",
      expect.any(Function),
    );
    await expect(mockReconcileClaimedSubmissionUncertain.mock.results[0]?.value).resolves.toBe(true);
  });

  it("reconciles the exact terminal event after BullMQ prunes its job and lock", async () => {
    await import("./apply-queue.js");
    const completed = mockWorkerListeners.get("completed");
    expect(completed).toBeDefined();
    if (!completed) throw new Error("completed listener was not registered");

    mockQueueGetJob.mockResolvedValueOnce(undefined);
    await completed(terminalSubmitJob());

    expect(mockQueueGetJob).toHaveBeenCalledWith("bull-submit-1");
    expect(mockRedisExists).toHaveBeenCalledWith("apply-tasks:bull-submit-1:lock");
    expect(mockReconcileClaimedSubmissionUncertain).toHaveBeenCalledOnce();
    await expect(mockReconcileClaimedSubmissionUncertain.mock.results[0]?.value).resolves.toBe(true);
  });

  it("defers a pruned terminal delivery while the apply queue is paused", async () => {
    await import("./apply-queue.js");
    const completed = mockWorkerListeners.get("completed");
    expect(completed).toBeDefined();
    if (!completed) throw new Error("completed listener was not registered");

    mockQueueGetJob.mockResolvedValueOnce(undefined);
    mockQueueIsPaused.mockResolvedValueOnce(true);
    await completed(terminalSubmitJob());

    expect(mockQueueIsPaused).toHaveBeenCalledOnce();
    expect(mockQueueGetJob).not.toHaveBeenCalled();
    expect(mockRedisExists).not.toHaveBeenCalled();
    expect(mockReconcileClaimedSubmissionUncertain).not.toHaveBeenCalled();
  });

  it("does not reconcile a pruned delivery while its exact Redis lock remains", async () => {
    await import("./apply-queue.js");
    const completed = mockWorkerListeners.get("completed");
    expect(completed).toBeDefined();
    if (!completed) throw new Error("completed listener was not registered");

    mockQueueGetJob.mockResolvedValueOnce(undefined);
    mockRedisExists.mockResolvedValueOnce(1);
    await completed(terminalSubmitJob());

    expect(mockRedisExists).toHaveBeenCalledWith("apply-tasks:bull-submit-1:lock");
    expect(mockQueueGetJob).not.toHaveBeenCalled();
    expect(mockReconcileClaimedSubmissionUncertain).not.toHaveBeenCalled();
  });

  it("leaves retryable failures and a stale terminal event for a newly active retry unchanged", async () => {
    await import("./apply-queue.js");
    const failed = mockWorkerListeners.get("failed");
    expect(failed).toBeDefined();
    if (!failed) throw new Error("failed listener was not registered");

    await failed(terminalSubmitJob(1, 3));
    expect(mockRedisExists).not.toHaveBeenCalled();
    expect(mockReconcileClaimedSubmissionUncertain).not.toHaveBeenCalled();

    mockRedisExists.mockResolvedValue(1);
    await failed(terminalSubmitJob());
    expect(mockRedisExists).toHaveBeenCalledWith("apply-tasks:bull-submit-1:lock");
    expect(mockQueueGetJob).not.toHaveBeenCalled();
    expect(mockReconcileClaimedSubmissionUncertain).not.toHaveBeenCalled();
  });

  it("ignores an old terminal event when the current exact job has been retried", async () => {
    await import("./apply-queue.js");
    const completed = mockWorkerListeners.get("completed");
    expect(completed).toBeDefined();
    if (!completed) throw new Error("completed listener was not registered");

    mockQueueGetJob.mockResolvedValueOnce({
      ...terminalSubmitJob(),
      getState: vi.fn().mockResolvedValue("active"),
    });
    mockRedisExists.mockResolvedValueOnce(1);
    await completed(terminalSubmitJob());

    expect(mockRedisExists).toHaveBeenCalledWith("apply-tasks:bull-submit-1:lock");
    expect(mockQueueGetJob).not.toHaveBeenCalled();
    expect(mockReconcileClaimedSubmissionUncertain).not.toHaveBeenCalled();
  });

  it("ignores terminal events unless the current Queue job has the exact identity and payload", async () => {
    await import("./apply-queue.js");
    const completed = mockWorkerListeners.get("completed");
    expect(completed).toBeDefined();
    if (!completed) throw new Error("completed listener was not registered");

    mockQueueGetJob.mockResolvedValueOnce({
      ...terminalSubmitJob(),
      id: "bull-other-submit",
      getState: vi.fn().mockResolvedValue("completed"),
    });
    await completed(terminalSubmitJob());
    expect(mockQueueGetJob).toHaveBeenCalledWith("bull-submit-1");
    expect(mockReconcileClaimedSubmissionUncertain).not.toHaveBeenCalled();

    mockQueueGetJob.mockResolvedValueOnce({
      ...terminalSubmitJob(),
      data: { ...terminalSubmitJob().data, applyUrl: "https://example.com/changed" },
      getState: vi.fn().mockResolvedValue("completed"),
    });
    await completed(terminalSubmitJob());
    expect(mockQueueGetJob).toHaveBeenCalledTimes(2);
    expect(mockReconcileClaimedSubmissionUncertain).not.toHaveBeenCalled();
  });

  it("ignores a malformed terminal submit identity", async () => {
    await import("./apply-queue.js");
    const completed = mockWorkerListeners.get("completed");
    expect(completed).toBeDefined();
    if (!completed) throw new Error("completed listener was not registered");

    await completed(terminalSubmitJob(3, 3, { constraintHash: "wrong" }));

    expect(mockRedisExists).not.toHaveBeenCalled();
    expect(mockReconcileClaimedSubmissionUncertain).not.toHaveBeenCalled();
  });

  it("can enqueue a task", async () => {
    const mod = await import("./apply-queue.js");
    const job = await mod.applyQueue.add("test", {
      applicationTaskId: "application-task-1",
      operation: "fill",
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
        sessionId: "agent-session-1",
        fillTurnId: "agent-turn-1",
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
        applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1", sessionId: "agent-session-1", fillTurnId: "agent-turn-1",
        applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
        receiptId: "approval-1", constraintHash: "c".repeat(64),
      },
    });

    expect(submitToolMocks.create).toHaveBeenCalledWith(expect.objectContaining({ pool: expect.anything(), submit: expect.any(Function) }));
    expect(mockSubmitContext).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "agent-session-1", turnId: "agent-turn-1" }));
    expect(mockMarkSubmissionRequestStarted).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "user-1", sessionId: "agent-session-1", turnId: "agent-turn-1", fillTurnId: "agent-turn-1",
      applicationTaskId: "application-task-1", jobId: "job-1", approvalId: "approval-1", constraintHash: "c".repeat(64),
      workerTaskId: "worker-task-test", executionId: expect.any(String),
    }));
    expect(mockProviderSubmitClick).toHaveBeenCalledOnce();
    expect(mockHarnessRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ allowSubmit: true }));
    expect(mockInsertApplyResult).toHaveBeenCalledWith(expect.objectContaining({ status: "submitted", flowUsed: "application.submit" }));
    expect(mockPage.close).toHaveBeenCalledOnce();
    expect(mockContext.close).not.toHaveBeenCalled();
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
        applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1", sessionId: "agent-session-1", fillTurnId: "agent-turn-1",
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
        applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1", sessionId: "agent-session-1", fillTurnId: "agent-turn-1",
        applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
      },
    });

    expect(mockWithCloakContext).not.toHaveBeenCalled();
    expect(submitToolMocks.create).not.toHaveBeenCalled();
    expect(mockHarnessRun).not.toHaveBeenCalled();
    expect(mockContext.route).not.toHaveBeenCalled();
    expect(mockProviderSubmitClick).not.toHaveBeenCalled();
    expect(mockMarkSubmissionRequestStarted).not.toHaveBeenCalled();
    expect(mockInsertApplyResult).not.toHaveBeenCalled();
    expect(mockFinishApplicationTask).not.toHaveBeenCalled();
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
        applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1", sessionId: "agent-session-1", fillTurnId: "agent-turn-1",
        applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
        receiptId: "approval-1", constraintHash: "c".repeat(64),
      },
    });

    expect(allowed).toBe(false);
    expect(mockContext.route).not.toHaveBeenCalled();
    expect(mockProviderSubmitClick).not.toHaveBeenCalled();
    expect(mockMarkSubmissionRequestStarted).not.toHaveBeenCalled();
  });

  it("persists a pre-request user handoff with the Stop-cancellable checkpoint", async () => {
    configureMockBrowserSubmitTool();
    mockHarnessRun.mockResolvedValue({
      status: "manual", error: "CAPTCHA detected; user takeover required.", durationMs: 123,
    });
    await import("./apply-queue.js");

    await mockProcessor({
      data: {
        applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1", sessionId: "agent-session-1", fillTurnId: "agent-turn-1",
        applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
        receiptId: "approval-1", constraintHash: "c".repeat(64),
      },
    });

    expect(mockMarkSubmissionRequestStarted).not.toHaveBeenCalled();
    expect(mockProviderSubmitClick).not.toHaveBeenCalled();
    expect(mockFinishApplicationTask).toHaveBeenCalledWith(
      expect.anything(), "application-task-1", "waiting_for_user", "user_takeover", expect.any(String), "submit", expectedSubmissionIdentity,
    );
  });

  it("keeps post-start uncertainty pending until context close is confirmed", async () => {
    configureMockBrowserSubmitTool();
    let uncertaintyWasPersistedAtClose = false;
    let resolveContextClose!: () => void;
    let signalContextCloseStarted!: () => void;
    const contextCloseGate = new Promise<void>((resolve) => { resolveContextClose = resolve; });
    const contextCloseStarted = new Promise<void>((resolve) => { signalContextCloseStarted = resolve; });
    let processorSettled = false;
    mockContext.close.mockImplementationOnce(async () => {
      uncertaintyWasPersistedAtClose = mockFinishApplicationTask.mock.calls.some(([, taskId, status, checkpoint]) =>
        taskId === "application-task-1" && status === "waiting_for_user" && checkpoint === "submission_uncertain"
      );
      signalContextCloseStarted();
      await contextCloseGate;
    });
    mockHarnessRun.mockImplementation(async (_page: unknown, task: { beforeSubmit?: (intent?: { url: string; method: string }) => Promise<boolean> }) => {
      const intent = { url: "https://example.com/jobs/123/apply", method: "POST" };
      const allowed = task.beforeSubmit ? await task.beforeSubmit(intent) : false;
      if (!allowed) return { status: "submission_blocked", error: "Submission guard denied.", durationMs: 123 };
      await dispatchPageRequest(intent.url, intent.method);
      return { status: "manual", error: "Submission result is unknown.", durationMs: 123 };
    });

    await import("./apply-queue.js");
    const processor = Promise.resolve(mockProcessor({
      data: {
        applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1", sessionId: "agent-session-1", fillTurnId: "agent-turn-1",
        applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
        receiptId: "approval-1", constraintHash: "c".repeat(64),
      },
    })).then(() => { processorSettled = true; });

    try {
      await contextCloseStarted;
      expect(uncertaintyWasPersistedAtClose).toBe(true);
      expect(processorSettled).toBe(false);
      expect(mockContext.close).toHaveBeenCalledOnce();
      expect(mockFinishApplicationTask).toHaveBeenCalledTimes(1);
      expect(mockFinishApplicationTask).toHaveBeenCalledWith(
        expect.anything(), "application-task-1", "waiting_for_user", "submission_uncertain", expect.any(String), "submit", expectedSubmissionIdentity,
      );
    } finally {
      resolveContextClose();
      await processor;
    }

    expect(processorSettled).toBe(true);
    expect(mockFinishApplicationTask).toHaveBeenCalledTimes(1);
  });

  it("confirms context closure when post-start finalization is superseded", async () => {
    configureMockBrowserSubmitTool();
    let resolveContextClose!: () => void;
    const contextCloseGate = new Promise<void>((resolve) => { resolveContextClose = resolve; });
    let processorSettled = false;
    mockContext.close.mockImplementationOnce(async () => { await contextCloseGate; });
    mockFinishApplicationTask.mockImplementationOnce(async () => "superseded");
    mockHarnessRun.mockImplementation(async (_page: unknown, task: { beforeSubmit?: (intent?: { url: string; method: string }) => Promise<boolean> }) => {
      const intent = { url: "https://example.com/jobs/123/apply", method: "POST" };
      const allowed = task.beforeSubmit ? await task.beforeSubmit(intent) : false;
      if (!allowed) return { status: "submission_blocked", error: "Submission guard denied.", durationMs: 123 };
      await dispatchPageRequest(intent.url, intent.method);
      return { status: "manual", error: "Submission result is unknown.", durationMs: 123 };
    });

    await import("./apply-queue.js");
    const processor = Promise.resolve(mockProcessor({
      data: {
        applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1", sessionId: "agent-session-1", fillTurnId: "agent-turn-1",
        applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
        receiptId: "approval-1", constraintHash: "c".repeat(64),
      },
    })).then(() => { processorSettled = true; });

    try {
      await vi.waitFor(() => expect(mockContext.close).toHaveBeenCalledOnce(), { timeout: 2_000 });
      expect(mockFinishApplicationTask).toHaveBeenCalledWith(
        expect.anything(), "application-task-1", "waiting_for_user", "submission_uncertain", expect.any(String), "submit", expectedSubmissionIdentity,
      );
      expect(processorSettled).toBe(false);
    } finally {
      resolveContextClose();
      await processor;
    }

    expect(processorSettled).toBe(true);
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
        applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1", sessionId: "agent-session-1", fillTurnId: "agent-turn-1",
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

      // Main-page writes and source-page iframe writes/navigation are blocked;
      // safe non-navigation iframe reads remain outside the submission fence.
      const telemetryRequest = await dispatchPageRequest("https://example.com/telemetry", "POST");
      expect(telemetryRequest?.abort).toHaveBeenCalledOnce();
      const safeRead = await dispatchPageRequest("https://example.com/assets/pixel", "GET");
      expect(safeRead?.fallback).toHaveBeenCalledOnce();
      const iframeRequest = await dispatchPageRequest(intent.url, intent.method, { frame: "iframe" });
      expect(iframeRequest?.abort).toHaveBeenCalledOnce();
      const iframeMutatedMethod = await dispatchPageRequest(intent.url, "GET", { frame: "iframe" });
      expect(iframeMutatedMethod?.abort).toHaveBeenCalledOnce();
      const iframeChangedUrlWrite = await dispatchPageRequest("https://example.com/iframe/alternate-action", "POST", { frame: "iframe" });
      expect(iframeChangedUrlWrite?.abort).toHaveBeenCalledOnce();
      const iframeChangedUrlNavigation = await dispatchPageRequest("https://example.com/iframe/next-document", "GET", { frame: "iframe", navigation: true });
      expect(iframeChangedUrlNavigation?.abort).toHaveBeenCalledOnce();
      const iframeSafeRead = await dispatchPageRequest("https://example.com/iframe/assets/pixel", "GET", { frame: "iframe" });
      expect(iframeSafeRead?.fallback).toHaveBeenCalledOnce();
      expect(mockMarkSubmissionRequestStarted).not.toHaveBeenCalled();
      const otherTabRequest = await dispatchPageRequest(intent.url, intent.method, { frame: "other-tab" });
      expect(otherTabRequest?.abort).toHaveBeenCalledOnce();
      const otherTabMutatedMethod = await dispatchPageRequest(intent.url, "GET", { frame: "other-tab" });
      expect(otherTabMutatedMethod?.abort).toHaveBeenCalledOnce();
      const otherTabTelemetryRequest = await dispatchPageRequest("https://example.com/other-tab/telemetry", "POST", { frame: "other-tab" });
      expect(otherTabTelemetryRequest?.fallback).toHaveBeenCalledOnce();
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
        applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1", sessionId: "agent-session-1", fillTurnId: "agent-turn-1",
        applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
        receiptId: "approval-1", constraintHash: "c".repeat(64),
      },
    });

    expect(mockMarkSubmissionRequestStarted).not.toHaveBeenCalled();
    expect(mockProviderSubmitClick).not.toHaveBeenCalled();
    expect(mockPageRouting.matcher?.(new URL("https://example.com/telemetry"))).toBe(true);
    expect(mockContext.route).toHaveBeenCalledOnce();
    expect(mockInsertApplyResult).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", error: "Agent turn was stopped before the application submission request started." }));
    expect(mockFinishApplicationTask).toHaveBeenCalledWith(expect.anything(), "application-task-1", "failed", "turn_stopped_before_submit", expect.stringContaining("stopped before"), "submit", expectedSubmissionIdentity);
    expect(mockPage.close).toHaveBeenCalled();
    expect(mockContext.close).not.toHaveBeenCalled();
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
        applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1", sessionId: "agent-session-1", fillTurnId: "agent-turn-1",
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
          applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1", sessionId: "agent-session-1", fillTurnId: "agent-turn-1",
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
      expect(mockContext.close).toHaveBeenCalledOnce();
      expect(mockFinishApplicationTask).toHaveBeenCalledWith(
        expect.anything(), "application-task-1", "waiting_for_user", "submission_uncertain", expect.any(String), "submit",
        expectedSubmissionIdentity,
      );
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
        applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1", sessionId: "agent-session-1", fillTurnId: "agent-turn-1",
        applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
        receiptId: "approval-1", constraintHash: "c".repeat(64),
      },
    });

    expect(mockContext.close).toHaveBeenCalledOnce();
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
        applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1", sessionId: "agent-session-1", fillTurnId: "agent-turn-1",
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

  it("preserves the committed start marker when the lock-holder COMMIT fails after continuation", async () => {
    const task = { status: "filling", checkpoint: "browser_active" };
    const order: string[] = [];
    const baseQuery = mockTurnClient.query.getMockImplementation();
    let pendingRoute: Promise<MockPageRouteResult | null> | null = null;
    mockFinishApplicationTask.mockImplementation(async (_pool: unknown, _taskId: string, status: string, checkpoint: string) => {
      if (checkpoint === "submission_uncertain") {
        if (task.checkpoint !== "submission_uncertain") {
          task.status = "waiting_for_user";
          task.checkpoint = checkpoint;
          order.push("worker-uncertain");
        }
      } else if (task.checkpoint !== "submission_uncertain" || status === "submitted") {
        task.status = status;
        task.checkpoint = checkpoint;
      }
    });
    mockMarkSubmissionRequestStarted.mockImplementationOnce(async () => {
      task.checkpoint = "submission_request_started";
      order.push("marker-commit");
      return "started";
    });
    mockTurnClient.query.mockImplementation(async (sql: string) => {
      if (sql === "COMMIT" && order.includes("route.continue")) {
        expect(order).toEqual(["marker-commit", "route.continue"]);
        order.push("lock-holder-commit");
        expect(task.checkpoint).toBe("submission_request_started");
        throw new Error("injected lock-holder COMMIT failure after request continuation");
      }
      if (sql === "ROLLBACK") {
        // Stop obtains the Session/Turn locks only after the failed lock-holder
        // transaction rolls back; it must then observe the committed marker.
        expect(task.checkpoint).toBe("submission_request_started");
        order.push("stop-preserved-started");
      }
      return baseQuery!(sql);
    });
    mockProviderSubmitClick.mockImplementationOnce(() => order.push("route.continue"));
    mockContext.close.mockImplementationOnce(async () => { order.push("context-close"); });
    submitToolMocks.create.mockImplementation(({ submit }: { submit: (input: unknown) => Promise<unknown> }) => ({
      execute: async () => submit({ target: {}, artifact: {}, context: {}, beforeSubmit: async () => true }),
    }));
    mockHarnessRun.mockImplementation(async (_page: unknown, taskContext: { beforeSubmit?: (intent?: { url: string; method: string }) => Promise<boolean> }) => {
      const intent = { url: "https://example.com/jobs/123/apply", method: "POST" };
      if (!await taskContext.beforeSubmit?.(intent)) {
        return { status: "submission_blocked", error: "Submission guard denied.", durationMs: 123 };
      }
      pendingRoute = dispatchPageRequest(intent.url, intent.method);
      await vi.waitFor(() => expect(task.checkpoint).toBe("submission_uncertain"));
      const duplicate = await dispatchPageRequest(intent.url, intent.method);
      expect(duplicate?.abort).toHaveBeenCalledOnce();
      return { status: "manual", error: "Submission outcome is uncertain.", durationMs: 123 };
    });

    try {
      await import("./apply-queue.js");
      await mockProcessor({
        data: {
          applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1", sessionId: "agent-session-1", fillTurnId: "agent-turn-1",
          applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
          receiptId: "approval-1", constraintHash: "c".repeat(64),
        },
      });
      if (pendingRoute) await pendingRoute;

      expect(order).toEqual([
        "marker-commit",
        "route.continue",
        "lock-holder-commit",
        "stop-preserved-started",
        "worker-uncertain",
        "context-close",
      ]);
      expect(task).toEqual({ status: "waiting_for_user", checkpoint: "submission_uncertain" });
      expect(mockFinishApplicationTask).toHaveBeenCalledWith(
        expect.anything(), "application-task-1", "waiting_for_user", "submission_uncertain", expect.any(String), "submit",
        expectedSubmissionIdentity,
      );
      expect(mockInsertApplyResult).toHaveBeenCalledTimes(1);

      await mockFinishApplicationTask(undefined, "application-task-1", "failed", "execution_failed", "Late cleanup callback");
      expect(task).toEqual({ status: "waiting_for_user", checkpoint: "submission_uncertain" });
    } finally {
      if (baseQuery) mockTurnClient.query.mockImplementation(baseQuery);
    }
  });

  it("aborts without continuing when the durable request-start COMMIT is ambiguous", async () => {
    const order: string[] = [];
    const baseQuery = mockTurnClient.query.getMockImplementation();
    let markerCommitFailed = false;
    let commitCount = 0;
    mockTurnClient.query.mockImplementation(async (sql: string) => {
      if (sql === "ROLLBACK") order.push("fence-release");
      if (sql === "COMMIT") commitCount += 1;
      if (sql === "COMMIT" && commitCount === 2 && !markerCommitFailed) {
        markerCommitFailed = true;
        throw new Error("injected ambiguous marker commit");
      }
      return baseQuery!(sql);
    });
    configureMockBrowserSubmitTool();
    mockFinishApplicationTask.mockImplementationOnce(async () => { order.push("finish-uncertain"); });
    mockHarnessRun.mockImplementation(async (_page: unknown, task: { beforeSubmit?: (intent?: { url: string; method: string }) => Promise<boolean> }) => {
      const intent = { url: "https://example.com/jobs/123/apply", method: "POST" };
      if (!await task.beforeSubmit?.(intent)) {
        return { status: "submission_blocked", error: "Submission guard denied.", durationMs: 123 };
      }
      const route = await dispatchPageRequest(intent.url, intent.method);
      expect(route?.abort).toHaveBeenCalledOnce();
      expect(route?.continue).not.toHaveBeenCalled();
      return { status: "failed", error: "The request start could not be durably confirmed.", durationMs: 123 };
    });

    try {
      await import("./apply-queue.js");
      await mockProcessor({
        data: {
          applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1", sessionId: "agent-session-1", fillTurnId: "agent-turn-1",
          applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
          receiptId: "approval-1", constraintHash: "c".repeat(64),
        },
      });

      expect(mockMarkSubmissionRequestStarted).toHaveBeenCalledOnce();
      expect(mockProviderSubmitClick).not.toHaveBeenCalled();
      expect(mockFinishApplicationTask).toHaveBeenCalledWith(
        expect.anything(), "application-task-1", "waiting_for_user", "submission_uncertain", expect.any(String), "submit",
        expectedSubmissionIdentity,
      );
      expect(mockInsertApplyResult).toHaveBeenCalledWith(expect.objectContaining({ status: "manual" }));
      expect(order).toEqual(["fence-release", "finish-uncertain"]);
      const rollbackIndex = mockTurnClient.query.mock.calls.findIndex(([sql]) => sql === "ROLLBACK");
      const rollbackOrder = mockTurnClient.query.mock.invocationCallOrder[rollbackIndex];
      const finishOrder = mockFinishApplicationTask.mock.invocationCallOrder[0];
      expect(mockTurnClient.release.mock.invocationCallOrder.some(callOrder => callOrder > rollbackOrder && callOrder < finishOrder)).toBe(true);
    } finally {
      if (baseQuery) mockTurnClient.query.mockImplementation(baseQuery);
    }
  });

  it("leaves an existing started marker untouched when the durable claim is unavailable", async () => {
    const task = { status: "filling", checkpoint: "submission_request_started" };
    mockClaimApplicationTask.mockResolvedValue(false);
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ status: task.status, checkpoint: task.checkpoint }] });
    mockClaimUnattendedSubmission.mockResolvedValue("unavailable");

    await import("./apply-queue.js");
    const payload = {
      applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1", sessionId: "agent-session-1", fillTurnId: "agent-turn-1",
      applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
      receiptId: "approval-1", constraintHash: "c".repeat(64),
    };
    await mockProcessor({ data: payload });

    expect(task).toEqual({ status: "filling", checkpoint: "submission_request_started" });
    expect(mockWithCloakContext).not.toHaveBeenCalled();
    expect(mockProviderSubmitClick).not.toHaveBeenCalled();
    expect(mockMarkSubmissionRequestStarted).not.toHaveBeenCalled();
    expect(mockClaimUnattendedSubmission).toHaveBeenCalledWith(expect.anything(), expectedSubmissionIdentity, "worker-task-test");
    expect(mockFinishApplicationTask).not.toHaveBeenCalled();
    expect(mockUpdateJobForSubmission).not.toHaveBeenCalled();
    expect(mockInsertApplyResult).not.toHaveBeenCalled();

    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ status: task.status, checkpoint: task.checkpoint }] });
    await mockProcessor({ data: payload });

    expect(task).toEqual({ status: "filling", checkpoint: "submission_request_started" });
    expect(mockWithCloakContext).not.toHaveBeenCalled();
    expect(mockProviderSubmitClick).not.toHaveBeenCalled();
    expect(mockInsertApplyResult).not.toHaveBeenCalled();
  });

  it("retries approval inspection errors without changing the queued task or Job", async () => {
    const approvalError = new Error("approval_expired");
    approvalMocks.inspectSubmission.mockRejectedValueOnce(approvalError);
    await import("./apply-queue.js");

    await expect(mockProcessor({
      data: {
        applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1", sessionId: "agent-session-1", fillTurnId: "agent-turn-1",
        applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
        receiptId: "approval-1", constraintHash: "c".repeat(64),
      },
    })).rejects.toBe(approvalError);

    expect(mockClaimUnattendedSubmission).not.toHaveBeenCalled();
    expect(mockInsertApplyResult).not.toHaveBeenCalled();
    expect(mockUpdateJobForSubmission).not.toHaveBeenCalled();
    expect(mockFinishApplicationTask).not.toHaveBeenCalled();
    expect(mockWithCloakContext).not.toHaveBeenCalled();
  });

  it("does not regress a competing claimed task and submitting Job after a pre-claim error", async () => {
    let rejectApproval!: (error: Error) => void;
    approvalMocks.inspectSubmission.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectApproval = reject; }));
    const current = {
      task: { status: "filling", checkpoint: "submission_authorized" },
      job: { status: "saved", workflowState: "queued" },
    };
    mockUpdateJobForSubmission.mockImplementation(async (_pool: unknown, _identity: unknown, update: { status: string; workflowState: string }) => {
      current.job = { status: update.status, workflowState: update.workflowState };
      return { kind: "current", value: true };
    });
    mockFinishApplicationTask.mockImplementation(async (_pool: unknown, _id: string, status: string, checkpoint: string) => {
      current.task = { status, checkpoint };
    });
    await import("./apply-queue.js");

    const processing = mockProcessor({
      data: {
        applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1", sessionId: "agent-session-1", fillTurnId: "agent-turn-1",
        applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
        receiptId: "approval-1", constraintHash: "c".repeat(64),
      },
    });
    await vi.waitFor(() => expect(approvalMocks.inspectSubmission).toHaveBeenCalledOnce());
    current.task = { status: "filling", checkpoint: "browser_active" };
    current.job = { status: "saved", workflowState: "submitting" };
    rejectApproval(new Error("approval_expired"));

    await expect(processing).rejects.toThrow("approval_expired");

    expect(current).toEqual({
      task: { status: "filling", checkpoint: "browser_active" },
      job: { status: "saved", workflowState: "submitting" },
    });
    expect(mockInsertApplyResult).not.toHaveBeenCalled();
    expect(mockUpdateJobForSubmission).not.toHaveBeenCalled();
    expect(mockFinishApplicationTask).not.toHaveBeenCalled();
  });

  it("rethrows submit-claim errors for BullMQ retry before browser setup", async () => {
    const claimError = new Error("temporary claim database failure");
    mockClaimUnattendedSubmission.mockRejectedValueOnce(claimError);
    await import("./apply-queue.js");

    await expect(mockProcessor({
      data: {
        applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1", sessionId: "agent-session-1", fillTurnId: "agent-turn-1",
        applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
        receiptId: "approval-1", constraintHash: "c".repeat(64),
      },
    })).rejects.toBe(claimError);

    expect(mockWithCloakContext).not.toHaveBeenCalled();
    expect(mockProviderSubmitClick).not.toHaveBeenCalled();
    expect(mockFinishApplicationTask).not.toHaveBeenCalled();
    expect(mockUpdateJobForSubmission).not.toHaveBeenCalled();
    expect(mockInsertApplyResult).not.toHaveBeenCalled();
  });

  it("marks a suspended submit task failed without opening a browser", async () => {
    mockIsUserActive.mockResolvedValue(false);

    await import("./apply-queue.js");
    await mockProcessor({
      data: {
        applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1", sessionId: "agent-session-1", fillTurnId: "agent-turn-1",
        applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
        receiptId: "approval-1", constraintHash: "c".repeat(64),
      },
    });

    expect(mockClaimUnattendedSubmission).not.toHaveBeenCalled();
    expect(mockFinishApplicationTask).toHaveBeenCalledWith(
      expect.anything(), "application-task-1", "failed", "account_suspended",
      "Account suspended by an administrator.", "submit", expectedSubmissionIdentity,
    );
    expect(mockWithCloakContext).not.toHaveBeenCalled();
    expect(mockProviderSubmitClick).not.toHaveBeenCalled();
    expect(mockInsertApplyResult).not.toHaveBeenCalled();
  });

  it("keeps the timed-out submit attempt active until context closure settles its route", async () => {
    let resolveContinuationAttempted!: () => void;
    const continuationAttempted = new Promise<void>((resolve) => { resolveContinuationAttempted = resolve; });
    let resolveContinuation!: () => void;
    const continuationGate = new Promise<void>((resolve) => { resolveContinuation = resolve; });
    let resolveContextClose!: () => void;
    let signalContextCloseStarted!: () => void;
    const contextCloseGate = new Promise<void>((resolve) => { resolveContextClose = resolve; });
    const contextCloseStarted = new Promise<void>((resolve) => { signalContextCloseStarted = resolve; });
    let commitsBeforeRequest = 0;
    let duplicateRequestWasAborted = false;
    let processorSettled = false;
    let finalGateResult: boolean | null = null;
    let firstRoute: MockPageRouteResult | null = null;
    mockContext.close.mockImplementationOnce(async () => {
      signalContextCloseStarted();
      await contextCloseGate;
      resolveContinuation();
    });
    mockProviderSubmitClick.mockImplementationOnce(() => resolveContinuationAttempted());
    submitToolMocks.create.mockImplementation(({ submit }: { submit: (input: unknown) => Promise<unknown> }) => ({
      execute: async () => submit({ target: {}, artifact: {}, context: {}, beforeSubmit: async () => true }),
    }));
    mockHarnessRun.mockImplementation(async (_page: unknown, task: { beforeSubmit?: (intent?: { url: string; method: string }) => Promise<boolean> }) => {
      const intent = { url: "https://example.com/jobs/123/apply", method: "POST" };
      finalGateResult = task.beforeSubmit ? await task.beforeSubmit(intent) : false;
      if (!finalGateResult) return { status: "submission_blocked", error: "Submission guard denied.", durationMs: 123 };

      commitsBeforeRequest = mockTurnClient.query.mock.calls.filter(([sql]) => sql === "COMMIT").length;
      await dispatchPageRequest(intent.url, intent.method, { continueGate: continuationGate, onRouteCreated: (route) => { firstRoute = route; } });
      if (!firstRoute?.continue.mock.calls.length) return { status: "failed", error: "The exact request route was not continued.", durationMs: 123 };
      return { status: "submitted", error: null, durationMs: 123 };
    });

    vi.stubEnv("APPLY_TIMEOUT_MS", "5000");
    vi.resetModules();
    try {
      await import("./apply-queue.js");
      const processor = Promise.resolve(mockProcessor({
        data: {
          applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1", sessionId: "agent-session-1", fillTurnId: "agent-turn-1",
          applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
          receiptId: "approval-1", constraintHash: "c".repeat(64),
        },
      })).then(() => { processorSettled = true; });

      await vi.waitFor(() => expect(mockProviderSubmitClick).toHaveBeenCalledOnce(), { timeout: 4_000 });
      await continuationAttempted;
      await vi.waitFor(() => {
        const commitCount = mockTurnClient.query.mock.calls.filter(([sql]) => sql === "COMMIT").length;
        expect(commitCount).toBeGreaterThan(commitsBeforeRequest);
      }, { timeout: 2_000 });
      await vi.waitFor(() => expect(mockFinishApplicationTask).toHaveBeenCalledWith(
        expect.anything(), "application-task-1", "waiting_for_user", "submission_uncertain", expect.stringContaining("Apply timeout"), "submit", expectedSubmissionIdentity,
      ), { timeout: 7_000 });
      await contextCloseStarted;

      const duplicateRequest = await dispatchPageRequest("https://example.com/jobs/123/apply", "POST");
      duplicateRequestWasAborted = Boolean(duplicateRequest && duplicateRequest.abort.mock.calls.length === 1);
      expect(mockTurnClient.query.mock.calls.filter(([sql]) => sql === "COMMIT").length)
        .toBeGreaterThan(commitsBeforeRequest);
      expect(mockTurnClient.query).toHaveBeenCalledWith("COMMIT");
      expect(duplicateRequestWasAborted).toBe(true);
      expect(processorSettled).toBe(false);
      expect(mockContext.close).toHaveBeenCalledOnce();
      expect(mockContext.unroute).not.toHaveBeenCalled();

      resolveContextClose();
      await mockContext.close.mock.results[0]?.value;
      await processor;
      expect(processorSettled).toBe(true);
      expect(mockContext.unroute).toHaveBeenCalledOnce();
      expect(mockInsertApplyResult).toHaveBeenCalledTimes(1);
    } finally {
      resolveContextClose();
      resolveContinuation();
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  }, 15_000);

  it("aborts a paused submission when timeout catch starts before fence acquisition resolves", async () => {
    let releaseFenceAcquisition!: () => void;
    const fenceAcquisitionGate = new Promise<void>((resolve) => { releaseFenceAcquisition = resolve; });
    let beginCount = 0;
    let commitCountBeforeFence = 0;
    const defaultTurnQuery = mockTurnClient.query.getMockImplementation();
    mockTurnClient.query.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN") {
        beginCount += 1;
        if (beginCount === 2) {
          commitCountBeforeFence = mockTurnClient.query.mock.calls.filter(([query]) => query === "COMMIT").length;
          await fenceAcquisitionGate;
        }
      }
      return defaultTurnQuery!(sql);
    });

    vi.stubEnv("APPLY_TIMEOUT_MS", "100");
    vi.resetModules();
    const pausedRoute: { current: MockPageRouteResult | null } = { current: null };
    configureMockBrowserSubmitTool();
    mockHarnessRun.mockImplementation(async (_page: unknown, task: { beforeSubmit?: (intent?: { url: string; method: string }) => Promise<boolean> }) => {
      const intent = { url: "https://example.com/jobs/123/apply", method: "POST" };
      if (!await task.beforeSubmit?.(intent)) {
        return { status: "submission_blocked", error: "Submission guard denied.", durationMs: 123 };
      }
      await dispatchPageRequest(intent.url, intent.method, { onRouteCreated: (route) => { pausedRoute.current = route; } });
      return { status: "submitted", error: null, durationMs: 123 };
    });

    let pendingProcessor: Promise<unknown> | null = null;
    try {
      await import("./apply-queue.js");
      pendingProcessor = Promise.resolve(mockProcessor({
        data: {
          applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1", sessionId: "agent-session-1", fillTurnId: "agent-turn-1",
          applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
          receiptId: "approval-1", constraintHash: "c".repeat(64),
        },
      }));
      await vi.waitFor(() => expect(beginCount).toBe(2), { timeout: 2_000 });
      await vi.waitFor(() => {
        expect(mockInsertApplyResult).toHaveBeenCalledWith(expect.objectContaining({
          status: "manual",
          error: expect.stringContaining("Apply timeout"),
        }));
      }, { timeout: 2_000 });
    } finally {
      releaseFenceAcquisition();
      if (pendingProcessor) await pendingProcessor;
      mockTurnClient.query.mockImplementation(defaultTurnQuery!);
      vi.unstubAllEnvs();
      vi.resetModules();
    }

    expect(pausedRoute.current).not.toBeNull();
    expect(pausedRoute.current?.abort).toHaveBeenCalledOnce();
    expect(pausedRoute.current?.continue).not.toHaveBeenCalled();
    expect(mockProviderSubmitClick).not.toHaveBeenCalled();
    expect(mockMarkSubmissionRequestStarted).toHaveBeenCalledOnce();
    expect(mockTurnClient.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mockTurnClient.query.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(commitCountBeforeFence + 1);
    expect(mockTurnClient.release).toHaveBeenCalledTimes(3);
    expect(mockFinishApplicationTask).toHaveBeenCalledWith(
      expect.anything(), "application-task-1", "waiting_for_user", "submission_uncertain", expect.stringContaining("Apply timeout"), "submit", expectedSubmissionIdentity,
    );
  });

  it("preserves uncertainty in catch finalization after the request-start fence", async () => {
    let uncertaintyWasPersistedAtClose = false;
    mockContext.close.mockImplementationOnce(async () => {
      uncertaintyWasPersistedAtClose = mockFinishApplicationTask.mock.calls.some(([, taskId, status, checkpoint]) =>
        taskId === "application-task-1" && status === "waiting_for_user" && checkpoint === "submission_uncertain"
      );
    });
    submitToolMocks.create.mockImplementation(({ submit }: { submit: (input: unknown) => Promise<unknown> }) => ({
      execute: async () => {
        await submit({ target: {}, artifact: {}, context: {}, beforeSubmit: async () => true });
        throw new Error("worker lost the provider result");
      },
    }));

    await import("./apply-queue.js");
    await mockProcessor({
      data: {
        applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1", sessionId: "agent-session-1", fillTurnId: "agent-turn-1",
        applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
        receiptId: "approval-1", constraintHash: "c".repeat(64),
      },
    });

    expect(mockMarkSubmissionRequestStarted).toHaveBeenCalledOnce();
    expect(mockProviderSubmitClick).toHaveBeenCalledOnce();
    expect(mockContext.close).toHaveBeenCalledOnce();
    expect(mockInsertApplyResult).toHaveBeenCalledWith(expect.objectContaining({
      status: "manual",
      error: expect.stringContaining("after it started"),
    }));
    expect(mockFinishApplicationTask).toHaveBeenCalledWith(
      expect.anything(), "application-task-1", "waiting_for_user", "submission_uncertain", expect.stringContaining("after it started"), "submit", expectedSubmissionIdentity,
    );
    expect(uncertaintyWasPersistedAtClose).toBe(true);
  });

  it("fills without submission, then creates the durable final-review checkpoint", async () => {
    mockPage.evaluate.mockResolvedValue({ missing: [], sensitive: [], selectors: [] });
    await import("./apply-queue.js");
    await mockProcessor({
      data: {
        applicationTaskId: "application-task-1", operation: "fill", jobId: "job-1", userId: "user-1",
        applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
      },
    });
    expect(mockCompleteFillForReview).toHaveBeenCalledWith(expect.anything(), "application-task-1", "user-1", "job-1", mockTurnClient);
    expect(mockTurnClient.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO apply_results"), expect.arrayContaining(["user-1", "job-1", "manual"]));
  });

  it("marks suspended queued tasks failed without opening a browser", async () => {
    mockIsUserActive.mockResolvedValue(false);
    await import("./apply-queue.js");

    await mockProcessor({
      data: {
        applicationTaskId: "application-task-1", operation: "submit", jobId: "job-1", userId: "user-1", sessionId: "agent-session-1", fillTurnId: "agent-turn-1",
        applyUrl: "https://example.com/jobs/123/apply", personaId: "persona-1", resumePath: "/resume.pdf", dryRun: false,
      },
    });

    expect(mockWithCloakContext).not.toHaveBeenCalled();
  });
});
