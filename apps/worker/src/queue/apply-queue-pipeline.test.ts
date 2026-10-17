import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const agentRun = vi.fn().mockResolvedValue({ status: "submitted", durationMs: 11 });
  const outcomeQuery = vi.fn(async (sql: string) => {
    if (sql.includes('SELECT "sessionId" FROM application_tasks')) return { rows: [{ sessionId: "session-1" }], rowCount: 1 };
    if (sql.includes('FROM agent_sessions')) return { rows: [{ id: "session-1" }], rowCount: 1 };
    if (sql.includes('FROM agent_turns')) return { rows: [{ id: "turn-1" }], rowCount: 1 };
    if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [{ id: "filler-1" }], rowCount: 1 };
    if (sql.includes('SELECT "sessionId", "fillTurnId", "fillTurnSessionId", "fillTurnUserId"')) {
      return { rows: [{ sessionId: "agent-session-1", fillTurnId: "agent-turn-1", fillTurnSessionId: "agent-session-1", fillTurnUserId: "user-1" }], rowCount: 1 };
    }
    if (sql.includes('FROM "Job"')) return { rows: [{ id: "job-1" }], rowCount: 1 };
    if (sql.includes('SELECT "id", "fillTurnId", "sessionId"')) return { rows: [{ id: "application-task-1", fillTurnId: null, sessionId: "session-1", status: "filling", checkpoint: "form_fill_queued" }], rowCount: 1 };
    if (sql.includes("INSERT INTO apply_results")) return { rows: [{ id: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const outcomeClient = { query: outcomeQuery, release: vi.fn() };
  const fakeContext = {
    close: vi.fn().mockResolvedValue(undefined),
    route: vi.fn().mockResolvedValue(undefined),
    unroute: vi.fn().mockResolvedValue(undefined),
  };
  const fakePage = {
    goto: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue("https://jobs.example/apply/start/123"),
    context: vi.fn(() => fakeContext),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return {
    workerHandler: undefined as undefined | ((job: { id: string; data: Record<string, unknown> }) => Promise<void>),
    workerEvents: {} as Record<string, unknown>,
    currentSubmitJob: undefined as undefined | {
      id: string;
      data: Record<string, unknown>;
      attemptsMade: number;
      opts: { attempts: number };
      getState: () => Promise<string>;
    },
    getJob: vi.fn(),
    fakePage,
    fakeContext,
    checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
    withCloakContext: vi.fn(),
    insertApplyResult: vi.fn().mockResolvedValue(1),
    query: vi.fn().mockResolvedValue({ rowCount: 1 }),
    outcomeQuery,
    outcomeClient,
    loadTaskContext: vi.fn(),
    detectCaptcha: vi.fn().mockResolvedValue(false),
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
    claimApplicationTask: vi.fn().mockResolvedValue(true),
    isUserActive: vi.fn().mockResolvedValue(true),
    applicationTaskStillActive: vi.fn().mockResolvedValue(true),
    completeFillForReview: vi.fn().mockResolvedValue(true),
    finishApplicationTask: vi.fn().mockResolvedValue(undefined),
    claimUnattendedSubmission: vi.fn().mockResolvedValue("claimed"),
    releaseUncertainSubmission: vi.fn().mockResolvedValue({ kind: "current", value: true }),
    updateJobForSubmission: vi.fn().mockResolvedValue({ kind: "current", value: true }),
    reconcileClaimedSubmissionUncertain: vi.fn().mockResolvedValue(true),
    redisExists: vi.fn().mockResolvedValue(0),
    pauseForFormInput: vi.fn().mockResolvedValue(undefined),
    agentRun,
    AgentHarness: vi.fn().mockImplementation(() => ({ run: agentRun })),
    createNotification: vi.fn().mockResolvedValue(undefined),
    notifyApplyResult: vi.fn().mockResolvedValue(undefined),
    runtimeFeatureEnabled: vi.fn().mockResolvedValue(true),
    loadAtsPolicy: vi.fn(),
    canUseAtsSource: vi.fn().mockReturnValue(true),
  };
});
const approvalMocks = vi.hoisted(() => ({
  inspectSubmission: vi.fn().mockResolvedValue({
    type: "submit_application",
    status: "approved",
    scope: {
      userId: "user-1",
      sessionId: "agent-session-1",
      turnId: "agent-turn-1",
      jobId: "job-1",
      toolCallId: "application-submit:application-task-1",
      action: "submit_application",
    },
    payload: { applicationTaskId: "application-task-1", jobId: "job-1" },
  }),
}));
const submitToolMocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn(),
    client: Promise.resolve({
      get: vi.fn(async (key: string) => (await mocks.redisExists(key)) === 0 ? null : "lock-token"),
    }),
    getJob: mocks.getJob,
    isPaused: vi.fn().mockResolvedValue(false),
    toKey: (suffix: string) => `bull:apply-tasks:${suffix}`,
  })),
  Worker: vi.fn().mockImplementation((_name, handler) => {
    mocks.workerHandler = handler;
    return { on: vi.fn((event: string, callback: unknown) => { mocks.workerEvents[event] = callback; }), close: vi.fn(), isRunning: vi.fn() };
  }),
}));

vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(() => ({ disconnect: vi.fn() })),
}));
vi.mock("../redis.js", () => ({ redisConnection: { exists: mocks.redisExists } }));

vi.mock("../rate-limit.js", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("../cloak/pool.js", () => ({ withCloakContext: mocks.withCloakContext }));
vi.mock("../cloak/captcha.js", () => ({
  detectCaptcha: mocks.detectCaptcha,
}));
vi.mock("../db/apply-results.js", () => ({
  insertApplyResult: mocks.insertApplyResult,
  getPool: vi.fn(() => ({ query: mocks.query, connect: vi.fn().mockResolvedValue(mocks.outcomeClient) })),
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
vi.mock("../admin/runtime-feature-flags.js", () => ({ isWorkerFeatureEnabled: mocks.runtimeFeatureEnabled }));
vi.mock("../admin/ats-policy.js", () => ({
  loadEffectiveAtsPolicy: mocks.loadAtsPolicy,
  canUseAtsSource: mocks.canUseAtsSource,
}));
vi.mock("../db/application-task-state.js", () => ({
  USER_TAKEOVER_CHECKPOINT: "user_takeover",
  claimApplicationTask: mocks.claimApplicationTask,
  applicationTaskStillActive: mocks.applicationTaskStillActive,
  completeFillForReview: mocks.completeFillForReview,
  finishApplicationTask: mocks.finishApplicationTask,
  isUserActive: mocks.isUserActive,
  pauseForFormInput: mocks.pauseForFormInput,
  needsUserTakeover: vi.fn(() => false),
}));
vi.mock("../db/submission-guard.js", () => ({
  claimUnattendedSubmission: mocks.claimUnattendedSubmission,
  reconcileClaimedSubmissionUncertain: mocks.reconcileClaimedSubmissionUncertain,
  releaseUncertainSubmission: mocks.releaseUncertainSubmission,
  updateJobForSubmission: mocks.updateJobForSubmission,
  UNCONFIRMED_SUBMISSION_MESSAGE: "The previous background attempt was interrupted after it started. ApplyMate did not retry it to avoid sending a duplicate application.",
}));
vi.mock("../runtime/approval/pg-store.js", () => ({
  createPgApprovalStore: vi.fn(() => ({ inspectSubmission: approvalMocks.inspectSubmission })),
}));
vi.mock("../runtime/interrupt/application-submission-probe.js", () => ({
  acquireApplicationSubmissionStartFence: vi.fn(),
  isApplicationSubmissionStopped: vi.fn().mockResolvedValue(false),
  startApplicationSubmissionStopProbe: vi.fn(() => ({ stop: vi.fn() })),
}));
vi.mock("../runtime/tools/application-submit-tool.js", () => ({
  createPgApplicationSubmitTool: submitToolMocks.create.mockImplementation((
    { submit }: { submit: (input: { beforeSubmit: (intent?: unknown) => Promise<boolean> }) => Promise<unknown> },
  ) => ({
    execute: async () => {
      try {
        await submit({ beforeSubmit: async () => true });
        return { status: "submitted", confirmationId: "application:application-task-1", postSubmitUrl: null, errorCode: null, output: null };
      } catch (error) {
        const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code
          : "browser_failed";
        return { status: "failed", confirmationId: null, postSubmitUrl: null, errorCode, output: null };
      }
    },
  })),
}));
vi.mock("node:fs", () => ({ unlinkSync: vi.fn() }));

const payload = {
  applicationTaskId: "application-task-1",
  operation: "submit",
  userId: "user-1",
  jobId: "job-1",
  sessionId: "agent-session-1",
  fillTurnId: "agent-turn-1",
  applyUrl: "https://jobs.example/apply/start/123",
  personaId: "persona-1",
  resumePath: "/resume.pdf",
  dryRun: false,
  receiptId: "approval-1",
  constraintHash: "c".repeat(64),
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
  await mocks.workerHandler?.({ id: "worker-task-pipeline-1", data: payload });
}

describe("apply-queue Phase 5 pipeline", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.claimApplicationTask.mockReset().mockResolvedValue(true);
    mocks.finishApplicationTask.mockReset().mockResolvedValue(undefined);
    mocks.claimUnattendedSubmission.mockReset().mockResolvedValue("claimed");
    mocks.releaseUncertainSubmission.mockReset().mockResolvedValue({ kind: "current", value: true });
    mocks.updateJobForSubmission.mockReset().mockResolvedValue({ kind: "current", value: true });
    mocks.outcomeQuery.mockClear();
    mocks.outcomeClient.release.mockClear();
    mocks.workerHandler = undefined;
    mocks.workerEvents = {};
    mocks.currentSubmitJob = undefined;
    mocks.getJob.mockImplementation(async (id: string) => id === mocks.currentSubmitJob?.id ? mocks.currentSubmitJob : undefined);
    mocks.redisExists.mockReset().mockResolvedValue(0);
    mocks.reconcileClaimedSubmissionUncertain.mockReset().mockImplementation(async (
      _pool: unknown,
      _identity: unknown,
      _workerTaskId: string,
      isCurrentTerminalDelivery?: (client: unknown) => Promise<boolean>,
    ) => isCurrentTerminalDelivery ? isCurrentTerminalDelivery({
      query: async (sql: string) => sql.includes('FROM "application_tasks"')
        ? { rows: [{ id: "application-task-1" }], rowCount: 1 }
        : sql.includes('FROM "application_task_events"')
          ? { rows: [], rowCount: 0 }
          : { rows: [], rowCount: 1 },
    }) : true);
    mocks.fakePage.goto.mockResolvedValue(undefined);
    mocks.fakePage.context.mockClear();
    mocks.fakePage.close.mockReset().mockResolvedValue(undefined);
    mocks.fakeContext.close.mockReset().mockResolvedValue(undefined);
    mocks.fakeContext.route.mockReset().mockResolvedValue(undefined);
    mocks.fakeContext.unroute.mockReset().mockResolvedValue(undefined);
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
    approvalMocks.inspectSubmission.mockResolvedValue({
      id: "approval-1",
      type: "submit_application",
      status: "approved",
      scope: {
        userId: "user-1",
        sessionId: "agent-session-1",
        turnId: "agent-turn-1",
        jobId: "job-1",
        toolCallId: "application-submit:application-task-1",
        action: "submit_application",
      },
      payload: { applicationTaskId: "application-task-1", jobId: "job-1" },
    });
    submitToolMocks.create.mockClear();
    payload.operation = "submit";
    mocks.runtimeFeatureEnabled.mockResolvedValue(true);
    mocks.loadAtsPolicy.mockResolvedValue({ configured: true, version: 1, allowAutoApply: true });
    mocks.canUseAtsSource.mockReturnValue(true);
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
    expect(mocks.findFormPattern).toHaveBeenCalledWith("user-1", "jobs.example", "apply/start/");
    expect(mocks.shouldUsePattern).toHaveBeenCalledWith(formPattern);
    expect(mocks.replayPattern).toHaveBeenCalledWith(
      mocks.fakePage,
      formPattern,
      expect.objectContaining({ fullName: "Ada Lovelace", coverLetter: "Hello" }),
      expect.any(Function),
    );
    expect(mocks.AgentHarness).not.toHaveBeenCalled();
    expect(mocks.incrementBudget).not.toHaveBeenCalled();
    expect(mocks.insertApplyResult).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        jobId: "job-1",
        status: "submitted",
        atsType: "unknown",
        flowUsed: "application.submit",
        error: null,
      })
    );
    expect(mocks.claimApplicationTask).not.toHaveBeenCalled();
    expect(mocks.claimUnattendedSubmission).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        applicationTaskId: "application-task-1", userId: "user-1", jobId: "job-1",
        sessionId: "agent-session-1", fillTurnId: "agent-turn-1", approvalId: "approval-1",
      }),
      "worker-task-pipeline-1",
    );
    expect(mocks.withCloakContext).toHaveBeenCalledOnce();
  }, 15_000);

  it("lets only one concurrent delivery reach browser setup before the submit-start marker", async () => {
    let claimCount = 0;
    mocks.claimUnattendedSubmission.mockImplementation(async () => ++claimCount === 1 ? "claimed" : "unavailable");
    let browserSetupStarted!: () => void;
    let allowBrowserSetup!: () => void;
    const browserStarted = new Promise<void>(resolve => { browserSetupStarted = resolve; });
    const browserGate = new Promise<void>(resolve => { allowBrowserSetup = resolve; });
    mocks.withCloakContext.mockImplementationOnce(async (_userId: string, fn: (page: typeof mocks.fakePage) => Promise<void>) => {
      browserSetupStarted();
      await browserGate;
      await fn(mocks.fakePage);
    });

    const owner = runApplyJob();
    await browserStarted;
    await expect(runApplyJob()).resolves.toBeUndefined();

    expect(mocks.claimUnattendedSubmission).toHaveBeenCalledTimes(2);
    expect(mocks.withCloakContext).toHaveBeenCalledOnce();
    expect(mocks.fakePage.goto).not.toHaveBeenCalled();
    expect(mocks.updateJobForSubmission).not.toHaveBeenCalled();
    expect(mocks.releaseUncertainSubmission).not.toHaveBeenCalled();
    expect(mocks.finishApplicationTask).not.toHaveBeenCalled();
    expect(mocks.insertApplyResult).not.toHaveBeenCalled();

    allowBrowserSetup();
    await expect(owner).resolves.toBeUndefined();
    expect(mocks.updateJobForSubmission).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ applicationTaskId: "application-task-1" }),
      expect.objectContaining({ status: "applied", workflowState: "submitted", applied: true }), "finish_apply_job_state",
    );
    expect(mocks.updateJobForSubmission.mock.calls.some(([, , state]) =>
      (state as { workflowState?: string }).workflowState === "ready_to_apply")).toBe(false);
    expect(mocks.withCloakContext).toHaveBeenCalledOnce();
  }, 15_000);

  it("keeps a claimed task terminal and uncertain when browser setup fails", async () => {
    mocks.withCloakContext.mockRejectedValueOnce(new Error("Cloak context failed to start"));

    await expect(runApplyJob()).resolves.toBeUndefined();

    expect(mocks.withCloakContext).toHaveBeenCalledOnce();
    expect(mocks.releaseUncertainSubmission).not.toHaveBeenCalled();
    expect(mocks.updateJobForSubmission).not.toHaveBeenCalled();
    expect(mocks.insertApplyResult).toHaveBeenCalledWith(expect.objectContaining({
      status: "manual", error: expect.stringContaining("did not retry"),
    }));
    expect(mocks.finishApplicationTask).toHaveBeenCalledWith(
      expect.anything(), "application-task-1", "waiting_for_user", "submission_uncertain",
      expect.stringContaining("did not retry"), "submit", expect.objectContaining({ fillTurnId: "agent-turn-1" }),
    );
  }, 15_000);

  it("rejects a stale legacy fill delivery for a TaskGraph-bound task before starting a browser", async () => {
    payload.operation = "fill";
    mocks.claimApplicationTask.mockResolvedValueOnce(false);

    await expect(runApplyJob()).resolves.toBeUndefined();

    expect(mocks.claimApplicationTask).toHaveBeenCalledWith(
      expect.anything(), "application-task-1", "user-1", "job-1",
    );
    expect(mocks.withCloakContext).not.toHaveBeenCalled();
    expect(mocks.fakePage.goto).not.toHaveBeenCalled();
    expect(mocks.agentRun).not.toHaveBeenCalled();
    expect(mocks.finishApplicationTask).not.toHaveBeenCalled();
    expect(mocks.completeFillForReview).not.toHaveBeenCalled();
    expect(mocks.pauseForFormInput).not.toHaveBeenCalled();
    expect(mocks.insertApplyResult).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("rejects a duplicate legacy fill while the owner returns the task to materials review", async () => {
    payload.operation = "fill";
    let status = "filling";
    let checkpoint = "form_fill_queued";
    mocks.claimApplicationTask.mockImplementation(async (_pool, _taskId, _userId, _jobId, operation) => {
      const claimable = operation === "submit"
        || (status === "filling" && checkpoint === "form_fill_queued");
      if (claimable) checkpoint = "browser_active";
      return claimable;
    });
    let releaseControl!: (enabled: boolean) => void;
    let controlStarted!: () => void;
    const ownerReachedControl = new Promise<void>(resolve => { controlStarted = resolve; });
    const ownerControl = new Promise<boolean>(resolve => { releaseControl = resolve; });
    mocks.runtimeFeatureEnabled.mockImplementationOnce(async () => {
      controlStarted();
      return ownerControl;
    });
    mocks.finishApplicationTask.mockImplementationOnce(async (_pool, _taskId, nextStatus, nextCheckpoint) => {
      status = nextStatus;
      checkpoint = nextCheckpoint;
    });

    const owner = runApplyJob();
    await ownerReachedControl;
    await expect(runApplyJob()).resolves.toBeUndefined();

    expect(mocks.claimApplicationTask).toHaveBeenCalledTimes(2);
    expect(mocks.withCloakContext).not.toHaveBeenCalled();
    expect(mocks.fakePage.goto).not.toHaveBeenCalled();
    expect(mocks.agentRun).not.toHaveBeenCalled();
    expect(mocks.insertApplyResult).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.finishApplicationTask).not.toHaveBeenCalled();

    releaseControl(false);
    await expect(owner).resolves.toBeUndefined();

    expect(status).toBe("waiting_for_user");
    expect(checkpoint).toBe("materials_ready");
    expect(mocks.finishApplicationTask).toHaveBeenCalledOnce();
    expect(mocks.outcomeQuery.mock.calls.filter(([sql]) => sql.includes("INSERT INTO apply_results"))).toHaveLength(1);
    expect(mocks.outcomeQuery.mock.calls.some(([sql]) => sql.includes('UPDATE "Job"'))).toBe(true);
    expect(mocks.withCloakContext).not.toHaveBeenCalled();
    expect(mocks.agentRun).not.toHaveBeenCalled();
  });

  it("pattern cache authorization block is terminal and does not fall back to AI", async () => {
    mocks.findFormPattern.mockResolvedValueOnce(formPattern);
    mocks.shouldUsePattern.mockReturnValueOnce(true);
    mocks.replayPattern.mockResolvedValueOnce({
      status: "submission_blocked",
      durationMs: 7,
      error: "Submission blocked: runtime authorization guard denied the submit.",
    });

    await expect(runApplyJob()).resolves.toBeUndefined();

    expect(mocks.AgentHarness).not.toHaveBeenCalled();
    expect(mocks.agentRun).not.toHaveBeenCalled();
    expect(mocks.recordPatternFailure).not.toHaveBeenCalled();
    expect(mocks.insertApplyResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "submission_blocked",
        flowUsed: "application.submit",
        error: "browser_412",
      }),
    );
    expect(mocks.createNotification).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        type: "apply_blocked",
        title: "Example submission blocked",
      }),
    );
    expect(mocks.notifyApplyResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: "submission_blocked" }),
    );
    expect(mocks.finishApplicationTask).toHaveBeenCalledWith(
      expect.anything(),
      "application-task-1",
      "waiting_for_authorization",
      "submission_blocked",
      "browser_412",
      "submit",
      expect.objectContaining({ fillTurnId: "agent-turn-1" }),
    );
  });

  it("pattern cache miss -> AI fallback -> budget incremented on success", async () => {
    mocks.findFormPattern.mockResolvedValueOnce(null);
    mocks.agentRun.mockResolvedValueOnce({ status: "submitted", durationMs: 13, error: null });

    await expect(runApplyJob()).resolves.toBeUndefined();

    expect(mocks.findFormPattern).toHaveBeenCalledWith("user-1", "jobs.example", "apply/start/");
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
        flowUsed: "application.submit",
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
        flowUsed: "application.submit",
        error: "browser_manual",
      })
    );
  });

  it("does not mutate state or open a browser when the exact submit claim is unavailable", async () => {
    mocks.claimUnattendedSubmission.mockResolvedValueOnce("unavailable");

    await expect(runApplyJob()).resolves.toBeUndefined();

    expect(mocks.claimUnattendedSubmission).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ applicationTaskId: "application-task-1" }), "worker-task-pipeline-1",
    );
    expect(mocks.fakePage.goto).not.toHaveBeenCalled();
    expect(mocks.withCloakContext).not.toHaveBeenCalled();
    expect(mocks.AgentHarness).not.toHaveBeenCalled();
    expect(mocks.insertApplyResult).not.toHaveBeenCalled();
    expect(mocks.finishApplicationTask).not.toHaveBeenCalled();
    expect(mocks.updateJobForSubmission).not.toHaveBeenCalled();
    expect(mocks.releaseUncertainSubmission).not.toHaveBeenCalled();
  });

  it("reconciles a stranded claim only after terminal delivery and exact lock release", async () => {
    mocks.claimUnattendedSubmission.mockResolvedValueOnce("unavailable");
    await expect(runApplyJob()).resolves.toBeUndefined();
    const completed = mocks.workerEvents.completed as (job: unknown) => Promise<void>;
    const failed = mocks.workerEvents.failed as (job: unknown) => Promise<void>;
    const terminalJob = { id: "worker-task-pipeline-1", data: payload, attemptsMade: 2, opts: { attempts: 2 } };
    mocks.currentSubmitJob = {
      ...terminalJob,
      getState: vi.fn().mockResolvedValue("completed"),
    };

    await failed({ ...terminalJob, attemptsMade: 1 });
    expect(mocks.redisExists).not.toHaveBeenCalled();
    await completed(terminalJob);

    expect(mocks.redisExists).toHaveBeenCalledWith("bull:apply-tasks:worker-task-pipeline-1:lock");
    expect(mocks.getJob).toHaveBeenCalledWith("worker-task-pipeline-1");
    expect(mocks.reconcileClaimedSubmissionUncertain).toHaveBeenCalledOnce();
    expect(mocks.reconcileClaimedSubmissionUncertain).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ applicationTaskId: "application-task-1", jobId: "job-1" }),
      "worker-task-pipeline-1",
      expect.any(Function),
    );
    await expect(mocks.reconcileClaimedSubmissionUncertain.mock.results[0]?.value).resolves.toBe(true);
    expect(mocks.withCloakContext).not.toHaveBeenCalled();
    expect(mocks.updateJobForSubmission).not.toHaveBeenCalled();

    mocks.redisExists.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    await completed(terminalJob);
    expect(mocks.reconcileClaimedSubmissionUncertain).toHaveBeenCalledTimes(2);
    await expect(mocks.reconcileClaimedSubmissionUncertain.mock.results[1]?.value).resolves.toBe(false);
  });

  it("does not recover an old terminal event after the same exact Queue job has been retried and claimed", async () => {
    mocks.claimUnattendedSubmission.mockResolvedValueOnce("unavailable");
    await expect(runApplyJob()).resolves.toBeUndefined();
    const completed = mocks.workerEvents.completed as (job: unknown) => Promise<void>;
    const terminalEvent = { id: "worker-task-pipeline-1", data: payload, attemptsMade: 2, opts: { attempts: 2 } };
    mocks.currentSubmitJob = {
      ...terminalEvent,
      getState: vi.fn().mockResolvedValue("active"),
    };
    mocks.redisExists.mockResolvedValue(1);

    await completed(terminalEvent);

    expect(mocks.redisExists).toHaveBeenCalledWith("bull:apply-tasks:worker-task-pipeline-1:lock");
    expect(mocks.getJob).not.toHaveBeenCalled();
    expect(mocks.reconcileClaimedSubmissionUncertain).not.toHaveBeenCalled();
    expect(mocks.withCloakContext).not.toHaveBeenCalled();
  });

  it("does not open a browser when a known ATS policy blocks unattended work", async () => {
    mocks.detectFlow.mockReturnValueOnce("greenhouse");
    mocks.canUseAtsSource.mockReturnValueOnce(false);

    await expect(runApplyJob()).resolves.toBeUndefined();

    expect(mocks.fakePage.goto).not.toHaveBeenCalled();
    expect(mocks.withCloakContext).not.toHaveBeenCalled();
    expect(mocks.insertApplyResult).toHaveBeenCalledWith(expect.objectContaining({
      status: "manual",
      atsType: "greenhouse",
      error: expect.stringContaining("temporarily unavailable"),
    }));
    expect(mocks.finishApplicationTask).toHaveBeenCalledWith(
      expect.anything(),
      "application-task-1",
      "waiting_for_authorization",
      "form_filled",
      expect.stringContaining("temporarily unavailable"),
      "submit",
      expect.objectContaining({ fillTurnId: "agent-turn-1" }),
    );
    expect(mocks.updateJobForSubmission).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ fillTurnId: "agent-turn-1" }),
      expect.objectContaining({ status: "saved", workflowState: "ready_to_apply" }), "handoff_unavailable_submit",
    );
  });

  it("does not open a browser when the platform unattended-apply control is disabled", async () => {
    mocks.runtimeFeatureEnabled.mockResolvedValueOnce(false);

    await expect(runApplyJob()).resolves.toBeUndefined();

    expect(mocks.fakePage.goto).not.toHaveBeenCalled();
    expect(mocks.withCloakContext).not.toHaveBeenCalled();
    expect(mocks.insertApplyResult).toHaveBeenCalledWith(expect.objectContaining({
      status: "manual",
      error: expect.stringContaining("temporarily unavailable"),
    }));
    expect(mocks.finishApplicationTask).toHaveBeenCalledWith(
      expect.anything(),
      "application-task-1",
      "waiting_for_authorization",
      "form_filled",
      expect.stringContaining("temporarily unavailable"),
      "submit",
      expect.objectContaining({ fillTurnId: "agent-turn-1" }),
    );
  });

  it("returns a blocked fill task to the user without creating a browser", async () => {
    payload.operation = "fill";
    mocks.runtimeFeatureEnabled.mockResolvedValueOnce(false);

    await expect(runApplyJob()).resolves.toBeUndefined();

    expect(mocks.fakePage.goto).not.toHaveBeenCalled();
    expect(mocks.finishApplicationTask).toHaveBeenCalledWith(
      expect.anything(),
      "application-task-1",
      "waiting_for_user",
      "materials_ready",
      expect.any(String),
      "fill",
    );
  });

  it("does not attach final submission authorization to fill-only work", async () => {
    payload.operation = "fill";
    const capturedTask: { current: { beforeSubmit?: () => Promise<boolean> } | null } = { current: null };
    mocks.agentRun.mockImplementationOnce(async (_page: unknown, input: { beforeSubmit?: () => Promise<boolean> }) => {
      capturedTask.current = input;
      return { status: "manual", durationMs: 1, error: "review" };
    });

    await expect(runApplyJob()).resolves.toBeUndefined();

    expect(capturedTask.current).not.toBeNull();
    expect(capturedTask.current?.beforeSubmit).toBeUndefined();
    const commitIndex = mocks.outcomeQuery.mock.calls.findIndex(([sql]) => sql === "COMMIT");
    const commitOrder = mocks.outcomeQuery.mock.invocationCallOrder[commitIndex];
    expect(commitIndex).toBeGreaterThanOrEqual(0);
    expect(mocks.createNotification.mock.invocationCallOrder[0]).toBeGreaterThan(commitOrder!);
    expect(mocks.notifyApplyResult.mock.invocationCallOrder[0]).toBeGreaterThan(commitOrder!);
  });

  it("fails closed without opening a browser when the platform control store is unavailable", async () => {
    mocks.runtimeFeatureEnabled.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(runApplyJob()).resolves.toBeUndefined();

    expect(mocks.fakePage.goto).not.toHaveBeenCalled();
    expect(mocks.withCloakContext).not.toHaveBeenCalled();
    expect(mocks.insertApplyResult).toHaveBeenCalledWith(expect.objectContaining({
      status: "manual",
      error: expect.stringContaining("temporarily unavailable"),
    }));
  });

  it("fails closed without opening a browser when the known ATS policy cannot be loaded", async () => {
    mocks.detectFlow.mockReturnValueOnce("greenhouse");
    mocks.loadAtsPolicy.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(runApplyJob()).resolves.toBeUndefined();

    expect(mocks.fakePage.goto).not.toHaveBeenCalled();
    expect(mocks.withCloakContext).not.toHaveBeenCalled();
    expect(mocks.insertApplyResult).toHaveBeenCalledWith(expect.objectContaining({
      status: "manual",
      atsType: "greenhouse",
      error: expect.stringContaining("temporarily unavailable"),
    }));
  });

  it("gives every active ATS flow a fresh submission authorization callback", async () => {
    mocks.detectFlow.mockReturnValueOnce("greenhouse");
    mocks.fakePage.url.mockReturnValueOnce("https://jobs.greenhouse.io/apply/start/123");
    mocks.runtimeFeatureEnabled.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const capturedTask: { current: { beforeSubmit?: () => Promise<boolean> } | null } = { current: null };
    mocks.runGreenhouseFlow.mockImplementationOnce(async (_page: unknown, input: { beforeSubmit?: () => Promise<boolean> }) => {
      capturedTask.current = input;
      return { status: "manual", durationMs: 1, error: "review" };
    });

    await expect(runApplyJob()).resolves.toBeUndefined();

    const beforeSubmit = capturedTask.current?.beforeSubmit;
    expect(beforeSubmit).toEqual(expect.any(Function));
    if (!beforeSubmit) throw new Error("Expected a submission authorization callback");
    await expect(beforeSubmit()).resolves.toBe(false);
  });
});
