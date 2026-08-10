import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workerHandler: undefined as undefined | ((job: { data: Record<string, unknown> }) => Promise<void>),
  fakePage: {
    goto: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue("https://jobs.example/apply"),
  },
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  withCloakContext: vi.fn(),
  insertApplyResult: vi.fn().mockResolvedValue(1),
  query: vi.fn().mockResolvedValue({ rowCount: 1 }),
  loadTaskContext: vi.fn(),
  detectCaptcha: vi.fn(),
  solveCaptcha: vi.fn(),
  detectFlow: vi.fn(),
  runGreenhouseFlow: vi.fn(),
  runSmartRecruitersFlow: vi.fn(),
  claimApplicationTask: vi.fn().mockResolvedValue(true),
  isUserActive: vi.fn().mockResolvedValue(true),
  completeFillForReview: vi.fn().mockResolvedValue(true),
  finishApplicationTask: vi.fn().mockResolvedValue(undefined),
  pauseForFormInput: vi.fn().mockResolvedValue(undefined),
  applicationTaskStillActive: vi.fn().mockResolvedValue(true),
  createNotification: vi.fn().mockResolvedValue(undefined),
  notifyApplyResult: vi.fn().mockResolvedValue(undefined),
  runtimeFeatureEnabled: vi.fn().mockResolvedValue(true),
  loadAtsPolicy: vi.fn(),
  canUseAtsSource: vi.fn().mockReturnValue(true),
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
vi.mock("../flows/smartrecruiters-flow.js", () => ({
  runSmartRecruitersFlow: mocks.runSmartRecruitersFlow,
}));
vi.mock("../notifications/notify-apply-result.js", () => ({
  notifyApplyResult: mocks.notifyApplyResult,
}));
vi.mock("../notifications/create-notification.js", () => ({
  createNotification: mocks.createNotification,
}));
vi.mock("../patterns/confidence.js", () => ({ shouldUsePattern: vi.fn(() => false) }));
vi.mock("../patterns/replay.js", () => ({ replayPattern: vi.fn() }));
vi.mock("../admin/runtime-feature-flags.js", () => ({
  isWorkerFeatureEnabled: mocks.runtimeFeatureEnabled,
}));
vi.mock("../admin/ats-policy.js", () => ({
  loadEffectiveAtsPolicy: mocks.loadAtsPolicy,
  canUseAtsSource: mocks.canUseAtsSource,
}));
vi.mock("../db/application-task-state.js", () => ({
  claimApplicationTask: mocks.claimApplicationTask,
  completeFillForReview: mocks.completeFillForReview,
  finishApplicationTask: mocks.finishApplicationTask,
  isUserActive: mocks.isUserActive,
  pauseForFormInput: mocks.pauseForFormInput,
  applicationTaskStillActive: mocks.applicationTaskStillActive,
  needsUserTakeover: vi.fn(() => false),
}));
vi.mock("node:fs", () => ({ unlinkSync: vi.fn() }));

const payload = {
  applicationTaskId: "application-task-1",
  operation: "submit",
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
    mocks.fakePage.url.mockReturnValue(payload.applyUrl);
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
    mocks.runtimeFeatureEnabled.mockResolvedValue(true);
    mocks.loadAtsPolicy.mockResolvedValue({ configured: true, version: 1, allowAutoApply: true });
    mocks.canUseAtsSource.mockReturnValue(true);
    mocks.runGreenhouseFlow.mockResolvedValue({ status: "submitted", durationMs: 1 });
    mocks.runSmartRecruitersFlow.mockResolvedValue({ status: "submitted", durationMs: 1 });
    await import("./apply-queue.js");
  });

  it("stops for human takeover without trying to bypass a CAPTCHA", async () => {
    mocks.detectCaptcha.mockResolvedValueOnce(true);

    await expect(mocks.workerHandler?.({ data: payload })).resolves.toBeUndefined();

    expect(mocks.solveCaptcha).not.toHaveBeenCalled();
    expect(mocks.insertApplyResult).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        jobId: "job-1",
        status: "manual",
        error: "CAPTCHA detected. User takeover is required; no bypass was attempted.",
      })
    );
    expect(mocks.createNotification).toHaveBeenCalledWith("user-1", {
      type: "apply_manual",
      title: "Example ⚠️",
      body: "Engineer",
      jobId: "job-1",
    });
    expect(mocks.runGreenhouseFlow).not.toHaveBeenCalled();
    expect(mocks.finishApplicationTask).toHaveBeenCalledWith(
      expect.anything(), "application-task-1", "waiting_for_user", "user_takeover",
      "CAPTCHA detected. User takeover is required; no bypass was attempted.",
    );
  });

  it("uses the Greenhouse flow when no human-handoff condition is found", async () => {
    mocks.detectFlow.mockReturnValueOnce("greenhouse");
    mocks.fakePage.url.mockReturnValue("https://boards.greenhouse.io/example/jobs/123/apply");

    await expect(mocks.workerHandler?.({ data: payload })).resolves.toBeUndefined();

    expect(mocks.fakePage.goto).toHaveBeenCalledTimes(1);
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
    expect(mocks.query).toHaveBeenLastCalledWith(
      expect.stringContaining('"workflowState" = $2'),
      ["applied", "submitted", "job-1", "user-1"]
    );
  });

  it("uses the SmartRecruiters flow instead of the generic fallback", async () => {
    mocks.detectFlow.mockReturnValueOnce("smartrecruiters");
    mocks.fakePage.url.mockReturnValue("https://jobs.smartrecruiters.com/Example/123");

    await expect(mocks.workerHandler?.({ data: payload })).resolves.toBeUndefined();

    expect(mocks.runSmartRecruitersFlow).toHaveBeenCalledWith(
      mocks.fakePage,
      expect.objectContaining({ jobId: "job-1" })
    );
    expect(mocks.insertApplyResult).toHaveBeenCalledWith(
      expect.objectContaining({ atsType: "smartrecruiters", flowUsed: "programmatic" })
    );
  });
});
