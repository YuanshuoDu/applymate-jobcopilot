import { beforeEach, describe, expect, it, vi } from "vitest";

const outcomeMocks = vi.hoisted(() => ({
  finishTask: vi.fn(), insertResult: vi.fn(), updateJob: vi.fn(), poolQuery: vi.fn(), finalizeStopped: vi.fn(),
}));
vi.mock("../db/application-task-state.js", () => ({
  finishApplicationTask: outcomeMocks.finishTask,
  isConfirmedApplicationTaskFinish: (result: string) => result === "current" || result === "already_current",
  CAPTCHA_USER_TAKEOVER_MESSAGE: "CAPTCHA detected.", CHALLENGE_DETECTION_FAILED_MESSAGE: "Challenge detection failed.",
  needsUserTakeover: vi.fn(() => false), USER_TAKEOVER_CHECKPOINT: "user_takeover",
}));
vi.mock("../db/apply-results.js", () => ({
  getPool: vi.fn(() => ({ query: outcomeMocks.poolQuery })), insertApplyResult: outcomeMocks.insertResult,
}));
vi.mock("../db/submission-guard.js", () => ({
  updateJobForSubmission: outcomeMocks.updateJob,
  UNCONFIRMED_SUBMISSION_MESSAGE: "Submit outcome uncertain.",
}));
vi.mock("../db/application-submission-stop-finalization.js", () => ({
  finalizeStoppedApplicationSubmission: outcomeMocks.finalizeStopped,
}));
vi.mock("./legacy-apply-outcomes.js", () => ({
  persistLegacyFillHarnessOutcome: vi.fn(), persistLegacyFillErrorOutcome: vi.fn(),
  persistUnavailableLegacyFillOutcome: vi.fn(),
}));

import { createNotification } from "../notifications/create-notification.js";
import { notifyApplyResult } from "../notifications/notify-apply-result.js";
import { createApplyResultNotification, handOffUnavailableUnattendedTask, persistApplyJobOutcome } from "./apply-job-outcomes.js";
import type { ApplyJobRunContext, ApplyJobRunState } from "./apply-job-runner.js";
import type { HarnessResult } from "../harness/agent-harness.js";
import type { Page } from "playwright-core";

vi.mock("../notifications/create-notification.js", () => ({ createNotification: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../notifications/notify-apply-result.js", () => ({ notifyApplyResult: vi.fn().mockResolvedValue(undefined) }));

function stoppedSubmitContext(options: {
  staged?: boolean;
  state?: Partial<ApplyJobRunState>;
} = {}): { context: ApplyJobRunContext; state: ApplyJobRunState; scope: object } {
  const identity = {
    applicationTaskId: "task", userId: "user", jobId: "job", sessionId: "session", fillTurnId: "turn",
    approvalId: "approval", constraintHash: "a".repeat(64),
  };
  const scope = { ...identity, turnId: "turn", workerTaskId: "worker-task", executionId: "execution" };
  const state = {
    resultWritten: false, resultWriteStarted: false, browserAttemptStarted: true, submissionClaimed: true,
    approvedTurnScope: scope, turnStopped: true, submissionRequestStarted: false,
    submissionAcknowledgementUncertain: false, submissionExecutionStartAttempted: true,
    submissionContextCloseConfirmed: false, submissionPageCloseConfirmed: false, submissionFenceUnavailable: false,
    submissionTaskInactive: false, pendingSubmissionFence: null, submissionFenceTimer: null,
    activePageCloseRef: { current: null }, submissionFenceRelease: null,
    submissionRouteState: { work: null, cleanup: null, observation: null }, submissionCandidateSeen: true,
    armedSubmissionIntent: null, activeBrowserExecution: null, activeSubmissionContextClose: null,
    activeSubmissionContextClosePromise: null, applicationTaskFinalized: false, submissionUncertainWrite: null,
    queueCatchStarted: false, stopController: new AbortController(), stopProbe: null, submissionSuperseded: false,
    challengeBoundary: null, flow: "greenhouse", usedFlow: "application.submit", harnessResult: null,
    ...options.state,
  } as ApplyJobRunState;
  const context = {
    payload: { applicationTaskId: "task", operation: "submit", userId: "user", jobId: "job" },
    workerTaskId: "worker-task", executionId: "execution", submissionIdentity: identity,
    startedAt: Date.now(), taskContext: { jobTitle: "Engineer", jobCompany: "Example", applyUrl: "https://example.test/apply" },
    ...(options.staged === false ? {} : { stagedSubmissionStopProtocol: { isStopped: vi.fn(), acquireStartFence: vi.fn() } }),
    lifecycle: { closeActiveSubmissionContext: vi.fn() },
    state,
  } as unknown as ApplyJobRunContext;
  return { context, state, scope };
}

describe("application outcome notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outcomeMocks.insertResult.mockResolvedValue(1);
    outcomeMocks.updateJob.mockResolvedValue({ kind: "current", value: true });
    outcomeMocks.finishTask.mockResolvedValue("current");
    outcomeMocks.poolQuery.mockResolvedValue({ rows: [{ status: "filling" }] });
    outcomeMocks.finalizeStopped.mockResolvedValue("finalized");
  });

  it("keeps status-specific notification type and title", async () => {
    await createApplyResultNotification({
      userId: "user",
      jobId: "job",
      jobTitle: "Engineer",
      jobCompany: "Acme",
      status: "failed",
    });

    expect(createNotification).toHaveBeenCalledWith("user", {
      type: "apply_failed",
      title: "Acme ❌",
      body: "Engineer",
      jobId: "job",
    });
  });

  it("does not treat an unconfirmed submit task write as a completed handoff", async () => {
    outcomeMocks.finishTask.mockResolvedValueOnce("unconfirmed");

    await expect(handOffUnavailableUnattendedTask({
      applicationTaskId: "task", operation: "submit", userId: "user", jobId: "job",
      submissionIdentity: {
        applicationTaskId: "task", userId: "user", jobId: "job", sessionId: "session", fillTurnId: "turn",
        approvalId: "approval", constraintHash: "a".repeat(64),
      },
      flow: null, startedAt: Date.now(), jobTitle: "Engineer", jobCompany: "Example",
    })).resolves.toBe(false);
    expect(outcomeMocks.finishTask).toHaveBeenCalledOnce();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it("continues the normal result and Job writes after the exact staged finalization", async () => {
    const { context, state, scope } = stoppedSubmitContext();

    await persistApplyJobOutcome(context, {} as Page, { status: "submission_blocked", error: "blocked", durationMs: 1 } as HarnessResult);

    expect(outcomeMocks.finalizeStopped).toHaveBeenCalledOnce();
    expect(outcomeMocks.finalizeStopped).toHaveBeenCalledWith(expect.anything(), scope);
    expect(state.applicationTaskFinalized).toBe(true);
    expect(outcomeMocks.finishTask).not.toHaveBeenCalled();
    expect(outcomeMocks.insertResult).toHaveBeenCalledOnce();
    expect(outcomeMocks.updateJob).toHaveBeenCalledOnce();
  });

  it("returns read-only when the exact staged finalization was already recorded", async () => {
    outcomeMocks.finalizeStopped.mockResolvedValueOnce("already_finalized");
    const { context, state } = stoppedSubmitContext();

    await persistApplyJobOutcome(context, {} as Page, { status: "submission_blocked", error: "blocked", durationMs: 1 } as HarnessResult);

    expect(state.applicationTaskFinalized).toBe(true);
    expect(outcomeMocks.finishTask).not.toHaveBeenCalled();
    expect(outcomeMocks.insertResult).not.toHaveBeenCalled();
    expect(outcomeMocks.updateJob).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(notifyApplyResult).not.toHaveBeenCalled();
  });

  it("keeps the generic strict task write when the staged proof is unavailable", async () => {
    outcomeMocks.finalizeStopped.mockResolvedValueOnce("unavailable");
    outcomeMocks.finishTask.mockResolvedValueOnce("unconfirmed");
    const { context, state } = stoppedSubmitContext();

    await expect(persistApplyJobOutcome(context, {} as Page, { status: "submission_blocked", error: "blocked", durationMs: 1 } as HarnessResult))
      .rejects.toThrow("Could not confirm the final application task state.");

    expect(outcomeMocks.finalizeStopped).toHaveBeenCalledOnce();
    expect(outcomeMocks.finishTask).toHaveBeenCalledWith(
      expect.anything(), "task", "failed", "turn_stopped_before_submit", expect.any(String), "submit", expect.anything(),
    );
    expect(state.applicationTaskFinalized).toBe(false);
  });

  it("does not continue generic task finalization after the exact attempt is superseded", async () => {
    outcomeMocks.finalizeStopped.mockResolvedValueOnce("superseded");
    const { context, state } = stoppedSubmitContext();

    await persistApplyJobOutcome(context, {} as Page, { status: "submission_blocked", error: "blocked", durationMs: 1 } as HarnessResult);

    expect(state.submissionSuperseded).toBe(true);
    expect(outcomeMocks.finishTask).not.toHaveBeenCalled();
    expect(outcomeMocks.insertResult).not.toHaveBeenCalled();
    expect(outcomeMocks.updateJob).not.toHaveBeenCalled();
  });

  it("does not use staged terminalization for legacy or ambiguous grant outcomes", async () => {
    const legacy = stoppedSubmitContext({ staged: false });
    await persistApplyJobOutcome(legacy.context, {} as Page, { status: "submission_blocked", error: "blocked", durationMs: 1 } as HarnessResult);
    expect(outcomeMocks.finalizeStopped).not.toHaveBeenCalled();
    expect(outcomeMocks.finishTask).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    outcomeMocks.insertResult.mockResolvedValue(1);
    outcomeMocks.updateJob.mockResolvedValue({ kind: "current", value: true });
    outcomeMocks.finishTask.mockResolvedValue("current");
    outcomeMocks.poolQuery.mockResolvedValue({ rows: [] });
    const ambiguous = stoppedSubmitContext({ state: {
      turnStopped: false, submissionRequestStarted: true,
      submissionAcknowledgementUncertain: false, submissionFenceUnavailable: true,
    } });
    await persistApplyJobOutcome(ambiguous.context, {} as Page, { status: "failed", error: "uncertain", durationMs: 1 } as HarnessResult);

    expect(outcomeMocks.finalizeStopped).not.toHaveBeenCalled();
    expect(outcomeMocks.finishTask).toHaveBeenCalledOnce();
    expect(outcomeMocks.finishTask).toHaveBeenCalledWith(
      expect.anything(), "task", "waiting_for_user", "submission_uncertain", expect.any(String), "submit", expect.anything(),
    );
  });
});
