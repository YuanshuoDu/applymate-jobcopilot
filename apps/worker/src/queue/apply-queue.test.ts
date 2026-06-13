import { describe, it, expect, vi, beforeEach } from "vitest";

const mockProcessor = vi.fn();
const mockUpsertFormPattern = vi.fn().mockResolvedValue(undefined);
const mockIncrementBudget = vi.fn().mockResolvedValue(undefined);
const mockInsertApplyResult = vi.fn().mockResolvedValue(1);

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
  withCloakContext: vi.fn().mockImplementation(
    async (_userId: string, fn: (page: unknown) => Promise<void>) => {
      await fn({ goto: vi.fn().mockResolvedValue(undefined), url: vi.fn().mockReturnValue("https://example.com/apply") });
    }
  ),
  closeAllSlots: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../db/apply-results.js", () => ({
  insertApplyResult: mockInsertApplyResult,
  getPool: vi.fn().mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
}));

vi.mock("../rate-limit.js", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("../cloak/captcha.js", () => ({
  detectCaptcha: vi.fn().mockResolvedValue(false),
  solveCaptcha: vi.fn().mockResolvedValue(false),
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
    run: vi.fn().mockResolvedValue({
      status: "submitted",
      error: null,
      durationMs: 123,
      fieldMappings: { "#name": "fullName" },
    }),
  })),
}));

describe("apply-queue (unit — mocked)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a worker on the apply-tasks queue", async () => {
    const mod = await import("./apply-queue.js");
    expect(mod.QUEUE_NAME).toBe("apply-tasks");
    expect(mod.applyWorker).toBeDefined();
  });

  it("can enqueue a task", async () => {
    const mod = await import("./apply-queue.js");
    const job = await mod.applyQueue.add("test", {
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
});
