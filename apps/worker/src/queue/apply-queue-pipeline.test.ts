import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const agentRun = vi.fn().mockResolvedValue({ status: "submitted", durationMs: 11 });

  return {
    workerHandler: undefined as undefined | ((job: { data: Record<string, unknown> }) => Promise<void>),
    fakePage: { goto: vi.fn().mockResolvedValue(undefined) },
    checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
    withCloakContext: vi.fn(),
    insertApplyResult: vi.fn().mockResolvedValue(1),
    query: vi.fn().mockResolvedValue({ rowCount: 1 }),
    loadTaskContext: vi.fn(),
    detectCaptcha: vi.fn().mockResolvedValue(false),
    solveCaptcha: vi.fn().mockResolvedValue(false),
    detectFlow: vi.fn().mockReturnValue(null),
    runGreenhouseFlow: vi.fn(),
    runWorkdayFlow: vi.fn(),
    runLeverFlow: vi.fn(),
    runPersonioFlow: vi.fn(),
    checkBudget: vi.fn().mockResolvedValue({ allowed: true, used: 0, limit: 10 }),
    incrementBudget: vi.fn().mockResolvedValue(undefined),
    findFormPattern: vi.fn().mockResolvedValue(null),
    recordPatternFailure: vi.fn().mockResolvedValue(undefined),
    upsertFormPattern: vi.fn().mockResolvedValue(undefined),
    shouldUsePattern: vi.fn().mockReturnValue(false),
    replayPattern: vi.fn(),
    agentRun,
    AgentHarness: vi.fn().mockImplementation(() => ({ run: agentRun })),
    createNotification: vi.fn().mockResolvedValue(undefined),
    notifyApplyResult: vi.fn().mockResolvedValue(undefined),
  };
});

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
vi.mock("../cloak/pool.js", () => ({ withCloakContext: mocks.withCloakContext }));
vi.mock("../cloak/captcha.js", () => ({
  detectCaptcha: mocks.detectCaptcha,
  solveCaptcha: mocks.solveCaptcha,
}));
vi.mock("../db/apply-results.js", () => ({
  insertApplyResult: mocks.insertApplyResult,
  getPool: vi.fn(() => ({ query: mocks.query })),
}));
vi.mock("../db/budget.js", () => ({
  checkBudget: mocks.checkBudget,
  incrementBudget: mocks.incrementBudget,
}));
vi.mock("../db/form-patterns.js", () => ({
  findFormPattern: mocks.findFormPattern,
  recordPatternFailure: mocks.recordPatternFailure,
  upsertFormPattern: mocks.upsertFormPattern,
}));
vi.mock("../db/load-task-context.js", () => ({ loadTaskContext: mocks.loadTaskContext }));
vi.mock("../harness/agent-harness.js", () => ({ AgentHarness: mocks.AgentHarness }));
vi.mock("../flows/index.js", () => ({ detectFlow: mocks.detectFlow }));
vi.mock("../flows/greenhouse-flow.js", () => ({ runGreenhouseFlow: mocks.runGreenhouseFlow }));
vi.mock("../flows/workday-flow.js", () => ({ runWorkdayFlow: mocks.runWorkdayFlow }));
vi.mock("../flows/lever-flow.js", () => ({ runLeverFlow: mocks.runLeverFlow }));
vi.mock("../flows/personio-flow.js", () => ({ runPersonioFlow: mocks.runPersonioFlow }));
vi.mock("../notifications/create-notification.js", () => ({
  createNotification: mocks.createNotification,
}));
vi.mock("../notifications/notify-apply-result.js", () => ({
  notifyApplyResult: mocks.notifyApplyResult,
}));
vi.mock("../patterns/confidence.js", () => ({ shouldUsePattern: mocks.shouldUsePattern }));
vi.mock("../patterns/replay.js", () => ({ replayPattern: mocks.replayPattern }));
vi.mock("node:fs", () => ({ unlinkSync: vi.fn() }));

const payload = {
  userId: "user-1",
  jobId: "job-1",
  applyUrl: "https://jobs.example/apply/start/123",
  personaId: "persona-1",
  resumePath: "/resume.pdf",
  dryRun: false,
};

const formPattern = {
  id: "pattern-1",
  atsHost: "jobs.example",
  urlPattern: "apply/start/",
  fieldMapping: { "#name": "fullName" },
  successCount: 4,
  failureCount: 0,
  lastSuccessAt: "2026-01-01T00:00:00.000Z",
};

async function runApplyJob() {
  await import("./apply-queue.js");
  expect(mocks.workerHandler).toBeDefined();
  await mocks.workerHandler?.({ data: payload });
}

describe("apply-queue Phase 5 pipeline", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.workerHandler = undefined;
    mocks.fakePage.goto.mockResolvedValue(undefined);
    mocks.withCloakContext.mockImplementation(async (_userId: string, fn: (page: typeof mocks.fakePage) => Promise<void>) => {
      await fn(mocks.fakePage);
    });
    mocks.loadTaskContext.mockResolvedValue({
      applyUrl: payload.applyUrl,
      persona: { fullName: "Ada Lovelace" },
      coverLetterText: "Hello",
      jobTitle: "Engineer",
      jobCompany: "Example",
      jobKeywords: "typescript",
      resumeTempPath: null,
    });
    mocks.detectCaptcha.mockResolvedValue(false);
    mocks.detectFlow.mockReturnValue(null);
    mocks.checkBudget.mockResolvedValue({ allowed: true, used: 0, limit: 10 });
    mocks.findFormPattern.mockResolvedValue(null);
    mocks.shouldUsePattern.mockReturnValue(false);
    mocks.replayPattern.mockResolvedValue({ status: "manual", durationMs: 5, error: "not matched" });
    mocks.agentRun.mockResolvedValue({ status: "submitted", durationMs: 11 });
  });

  it("pattern cache hit -> replay succeeds -> zero budget cost", async () => {
    mocks.findFormPattern.mockResolvedValueOnce(formPattern);
    mocks.shouldUsePattern.mockReturnValueOnce(true);
    mocks.replayPattern.mockResolvedValueOnce({ status: "submitted", durationMs: 7, error: null });

    await expect(runApplyJob()).resolves.toBeUndefined();

    expect(mocks.checkBudget).toHaveBeenCalledWith("user-1");
    expect(mocks.findFormPattern).toHaveBeenCalledWith("jobs.example", "apply/start/");
    expect(mocks.shouldUsePattern).toHaveBeenCalledWith(formPattern);
    expect(mocks.replayPattern).toHaveBeenCalledWith(
      mocks.fakePage,
      formPattern,
      expect.objectContaining({ fullName: "Ada Lovelace", coverLetter: "Hello" })
    );
    expect(mocks.AgentHarness).not.toHaveBeenCalled();
    expect(mocks.incrementBudget).not.toHaveBeenCalled();
    expect(mocks.insertApplyResult).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        jobId: "job-1",
        status: "submitted",
        atsType: "unknown",
        flowUsed: "pattern-cache",
        error: null,
      })
    );
  });

  it("pattern cache miss -> AI fallback -> budget incremented on success", async () => {
    mocks.findFormPattern.mockResolvedValueOnce(null);
    mocks.agentRun.mockResolvedValueOnce({ status: "submitted", durationMs: 13, error: null });

    await expect(runApplyJob()).resolves.toBeUndefined();

    expect(mocks.findFormPattern).toHaveBeenCalledWith("jobs.example", "apply/start/");
    expect(mocks.shouldUsePattern).not.toHaveBeenCalled();
    expect(mocks.replayPattern).not.toHaveBeenCalled();
    expect(mocks.AgentHarness).toHaveBeenCalledWith({
      userId: "user-1",
      maxTurns: 30,
      dryRun: false,
      mode: "dom",
    });
    expect(mocks.agentRun).toHaveBeenCalledWith(
      mocks.fakePage,
      expect.objectContaining({
        jobId: "job-1",
        applyUrl: payload.applyUrl,
        jobTitle: "Engineer",
        jobCompany: "Example",
      })
    );
    expect(mocks.incrementBudget).toHaveBeenCalledWith("user-1");
    expect(mocks.insertApplyResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "submitted",
        flowUsed: "llm",
        error: null,
      })
    );
  });

  it("budget exceeded -> manual status without AI call", async () => {
    mocks.checkBudget.mockResolvedValueOnce({ allowed: false, used: 10, limit: 10 });

    await expect(runApplyJob()).resolves.toBeUndefined();

    expect(mocks.AgentHarness).not.toHaveBeenCalled();
    expect(mocks.agentRun).not.toHaveBeenCalled();
    expect(mocks.findFormPattern).not.toHaveBeenCalled();
    expect(mocks.replayPattern).not.toHaveBeenCalled();
    expect(mocks.incrementBudget).not.toHaveBeenCalled();
    expect(mocks.insertApplyResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "manual",
        flowUsed: null,
        error: "AI fallback budget exceeded (10/10 this month)",
      })
    );
  });
});
