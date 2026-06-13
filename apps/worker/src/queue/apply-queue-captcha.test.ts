import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workerHandler: undefined as undefined | ((job: { data: Record<string, unknown> }) => Promise<void>),
  fakePage: { goto: vi.fn().mockResolvedValue(undefined) },
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  withCloakContext: vi.fn(),
  insertApplyResult: vi.fn().mockResolvedValue(1),
  query: vi.fn().mockResolvedValue({ rowCount: 1 }),
  loadTaskContext: vi.fn(),
  detectCaptcha: vi.fn(),
  solveCaptcha: vi.fn(),
  detectFlow: vi.fn(),
  runGreenhouseFlow: vi.fn(),
  createNotification: vi.fn().mockResolvedValue(undefined),
  notifyApplyResult: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: vi.fn() })),
  Worker: vi.fn().mockImplementation((_name, handler) => {
    mocks.workerHandler = handler;
    return { on: vi.fn(), close: vi.fn(), isRunning: vi.fn() };
  }),
}));

vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(() => ({ disconnect: vi.fn() })),
}));

vi.mock("../rate-limit.js", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("../cloak/pool.js", () => ({
  withCloakContext: mocks.withCloakContext,
}));
vi.mock("../cloak/captcha.js", () => ({
  detectCaptcha: mocks.detectCaptcha,
  solveCaptcha: mocks.solveCaptcha,
}));
vi.mock("../db/apply-results.js", () => ({
  insertApplyResult: mocks.insertApplyResult,
  getPool: vi.fn(() => ({ query: mocks.query })),
}));
vi.mock("../db/budget.js", () => ({
  checkBudget: vi.fn().mockResolvedValue({ allowed: true, used: 0, limit: 10 }),
  incrementBudget: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../db/form-patterns.js", () => ({
  findFormPattern: vi.fn().mockResolvedValue(null),
  recordPatternFailure: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../db/load-task-context.js", () => ({
  loadTaskContext: mocks.loadTaskContext,
}));
vi.mock("../harness/agent-harness.js", () => ({
  AgentHarness: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockResolvedValue({ status: "submitted", durationMs: 1 }),
  })),
}));
vi.mock("../flows/index.js", () => ({ detectFlow: mocks.detectFlow }));
vi.mock("../flows/greenhouse-flow.js", () => ({
  runGreenhouseFlow: mocks.runGreenhouseFlow,
}));
vi.mock("../flows/workday-flow.js", () => ({ runWorkdayFlow: vi.fn() }));
vi.mock("../flows/lever-flow.js", () => ({ runLeverFlow: vi.fn() }));
vi.mock("../flows/personio-flow.js", () => ({ runPersonioFlow: vi.fn() }));
vi.mock("../notifications/notify-apply-result.js", () => ({
  notifyApplyResult: mocks.notifyApplyResult,
}));
vi.mock("../notifications/create-notification.js", () => ({
  createNotification: mocks.createNotification,
}));
vi.mock("../patterns/confidence.js", () => ({ shouldUsePattern: vi.fn(() => false) }));
vi.mock("../patterns/replay.js", () => ({ replayPattern: vi.fn() }));
vi.mock("node:fs", () => ({ unlinkSync: vi.fn() }));

const payload = {
  userId: "user-1",
  jobId: "job-1",
  applyUrl: "https://jobs.example/apply",
  personaId: "persona-1",
  resumePath: "/resume.pdf",
  dryRun: true,
};

describe("apply-queue CAPTCHA handling", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.workerHandler = undefined;
    mocks.fakePage.goto.mockResolvedValue(undefined);
    mocks.withCloakContext.mockImplementation(async (_userId: string, fn: (page: typeof mocks.fakePage) => Promise<void>) => {
      await fn(mocks.fakePage);
    });
    mocks.loadTaskContext.mockResolvedValue({
      applyUrl: payload.applyUrl,
      persona: { firstName: "Ada" },
      coverLetterText: "",
      jobTitle: "Engineer",
      jobCompany: "Example",
      jobKeywords: "typescript",
      resumeTempPath: null,
    });
    mocks.detectCaptcha.mockResolvedValue(false);
    mocks.solveCaptcha.mockResolvedValue(false);
    mocks.detectFlow.mockReturnValue(null);
    mocks.runGreenhouseFlow.mockResolvedValue({ status: "submitted", durationMs: 1 });
    await import("./apply-queue.js");
  });

  it("writes a manual result when CAPTCHA is detected but cannot be solved", async () => {
    mocks.detectCaptcha.mockResolvedValueOnce(true);
    mocks.solveCaptcha.mockResolvedValueOnce(false);

    await expect(mocks.workerHandler?.({ data: payload })).resolves.toBeUndefined();

    expect(mocks.solveCaptcha).toHaveBeenCalledWith(mocks.fakePage);
    expect(mocks.insertApplyResult).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        jobId: "job-1",
        status: "manual",
        error: "CAPTCHA detected and could not be solved automatically",
      })
    );
    expect(mocks.createNotification).toHaveBeenCalledWith("user-1", {
      type: "apply_manual",
      title: "Example ⚠️",
      body: "Engineer",
      jobId: "job-1",
    });
    expect(mocks.runGreenhouseFlow).not.toHaveBeenCalled();
  });

  it("retries navigation once when CapSolver returns a token", async () => {
    mocks.detectCaptcha.mockResolvedValueOnce(true);
    mocks.solveCaptcha.mockResolvedValueOnce(true);
    mocks.detectFlow.mockReturnValueOnce("greenhouse");

    await expect(mocks.workerHandler?.({ data: payload })).resolves.toBeUndefined();

    expect(mocks.fakePage.goto).toHaveBeenCalledTimes(2);
    expect(mocks.runGreenhouseFlow).toHaveBeenCalled();
    expect(mocks.insertApplyResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: "submitted" })
    );
    expect(mocks.createNotification).toHaveBeenCalledWith("user-1", {
      type: "apply_submitted",
      title: "Example ✅",
      body: "Engineer",
      jobId: "job-1",
    });
  });
});
