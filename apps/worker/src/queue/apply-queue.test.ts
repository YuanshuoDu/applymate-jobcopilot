import { describe, it, expect, vi, beforeEach } from "vitest";

const mockProcessor = vi.fn();
const mockUpsertFormPattern = vi.fn().mockResolvedValue(undefined);
const mockIncrementBudget = vi.fn().mockResolvedValue(undefined);
const mockInsertApplyResult = vi.fn().mockResolvedValue(1);
const mockCompleteFillForReview = vi.fn().mockResolvedValue(undefined);
const mockHarnessRun = vi.fn();
const mockWithCloakContext = vi.fn();
const mockIsUserActive = vi.fn().mockResolvedValue(true);

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
  });
  return {
    Worker: mockWorkerCtor,
    Queue: mockQueueCtor,
  };
});

vi.mock("../cloak/pool.js", () => ({
  withCloakContext: mockWithCloakContext.mockImplementation(
    async (_userId: string, fn: (page: unknown) => Promise<void>) => {
      await fn({ goto: vi.fn().mockResolvedValue(undefined), url: vi.fn().mockReturnValue("https://example.com/apply") });
    }
  ),
  closeAllSlots: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../db/apply-results.js", () => ({
  insertApplyResult: mockInsertApplyResult,
  getPool: vi.fn().mockReturnValue({ query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }) }),
}));

vi.mock("../rate-limit.js", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("../cloak/captcha.js", () => ({
  detectCaptcha: vi.fn().mockResolvedValue(false),
}));

vi.mock("../db/application-task-state.js", () => ({
  claimApplicationTask: vi.fn().mockResolvedValue(true),
  completeFillForReview: mockCompleteFillForReview,
  finishApplicationTask: vi.fn().mockResolvedValue(undefined),
  isUserActive: mockIsUserActive,
  needsUserTakeover: vi.fn().mockReturnValue(false),
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

describe("apply-queue (unit — mocked)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsUserActive.mockResolvedValue(true);
    mockHarnessRun.mockImplementation(async (_page: unknown, task: { allowSubmit?: boolean }) => task.allowSubmit === false
      ? { status: "manual", error: "Form filled and ready for user review.", durationMs: 123, reviewReady: true }
      : { status: "submitted", error: null, durationMs: 123, fieldMappings: { "#name": "fullName" } });
  });

  it("creates a worker on the apply-tasks queue", async () => {
    const mod = await import("./apply-queue.js");
    expect(mod.QUEUE_NAME).toBe("apply-tasks");
    expect(mod.applyWorker).toBeDefined();
  });

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
      },
    });

    expect(mockIncrementBudget).toHaveBeenCalledWith("user-1");
    expect(mockUpsertFormPattern).toHaveBeenCalledWith({
      atsHost: "example.com",
      urlPattern: "jobs/123/",
      fieldMapping: { "#name": "fullName" },
    });
    expect(mockInsertApplyResult).toHaveBeenCalledWith(expect.objectContaining({
      status: "submitted",
      flowUsed: "llm",
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
