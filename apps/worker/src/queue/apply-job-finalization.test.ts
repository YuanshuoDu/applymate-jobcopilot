import { describe, expect, it, vi } from "vitest";
import type { ApplyJobRunContext } from "./apply-job-runner.js";
import { createApplyJobFinalization, finalizeApplyJob, handleApplyJobFailure } from "./apply-job-finalization.js";

const mocks = vi.hoisted(() => ({ recordSettled: vi.fn(), insert: vi.fn(), finishTask: vi.fn(), updateJob: vi.fn(), pool: {} }));
vi.mock("../db/apply-results.js", () => ({ getPool: () => mocks.pool, insertApplyResult: mocks.insert }));
vi.mock("../db/application-task-state.js", () => ({ finishApplicationTask: mocks.finishTask, USER_TAKEOVER_CHECKPOINT: "user_takeover" }));
vi.mock("../db/submission-guard.js", () => ({ updateJobForSubmission: mocks.updateJob, UNCONFIRMED_SUBMISSION_MESSAGE: "uncertain" }));
vi.mock("./application-submit-fence.js", () => ({ recordSubmissionExecutionSettled: mocks.recordSettled }));

describe("apply job finalization", () => {
  it("releases a held submission fence exactly once", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const context = {
      state: {
        activePageCloseRef: { current: null },
        activeSubmissionContextClose: null,
        activeSubmissionContextClosePromise: null,
        pendingSubmissionFence: { release },
        submissionFenceRelease: null,
        submissionFenceTimer: null,
        turnStopped: false,
        stopController: new AbortController(),
      },
    } as unknown as ApplyJobRunContext;
    const lifecycle = createApplyJobFinalization(context);

    await lifecycle.releaseSubmissionFence(true);
    await lifecycle.releaseSubmissionFence(false);

    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(true);
    expect(context.state.pendingSubmissionFence).toBeNull();
  });

  it("bounds Objective cleanup and never records settlement when browser closure is unconfirmed", async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    try {
      const never = new Promise<void>(() => undefined);
      const release = vi.fn().mockResolvedValue(undefined);
      const cleanup = vi.fn().mockResolvedValue(undefined);
      const cancel = vi.fn();
      const context = {
        payload: {}, taskContext: null, submissionIdentity: null,
        state: {
          objectiveMode: true, objectiveSubmissionRouteLifecycle: { cancel, settle: vi.fn().mockResolvedValue(false) },
          objectiveSubmissionObservation: { current: null }, submissionRequestStarted: true,
          submissionCandidateSeen: true, submissionExecutionStartAttempted: true,
          queueCatchStarted: true, submissionSuperseded: false, browserExecutionFinished: false,
          objectiveRunnerReportedSuccess: false, objectiveResultLinkCommitted: false, submissionRequestForwarded: false,
          submissionContextCloseConfirmed: false, submissionPageCloseConfirmed: false,
          activePageCloseRef: { current: () => never }, activeSubmissionContextClose: () => never,
          activeSubmissionContextClosePromise: null, activeBrowserExecution: never,
          submissionRouteState: { work: never, cleanup }, pendingSubmissionFence: { release },
          submissionFenceRelease: null, submissionFenceTimer: null, armedSubmissionIntent: null,
          approvedTurnScope: { userId: "user" }, stopProbe: null, stopController: new AbortController(),
        },
      } as unknown as ApplyJobRunContext;
      context.lifecycle = createApplyJobFinalization(context);
      let completed = false;
      const work = finalizeApplyJob(context).then(() => { completed = true; });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(completed).toBe(true);
      await work;
      expect(cancel).toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
      expect(cleanup).not.toHaveBeenCalled();
      expect(mocks.recordSettled).not.toHaveBeenCalled();
      expect(context.state.submissionContextCloseConfirmed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records settlement for the exact Objective scope only after a linked, forwarded success finishes", async () => {
    vi.clearAllMocks();
    mocks.recordSettled.mockResolvedValueOnce(true);
    const scope = { applicationTaskId: "task", userId: "user", jobId: "job", sessionId: "session", fillTurnId: "turn",
      approvalId: "approval", constraintHash: "hash", workerTaskId: "worker", executionId: "execution" };
    const context = {
      payload: {}, taskContext: null, submissionIdentity: null,
      state: {
        objectiveMode: true, objectiveSubmissionRouteLifecycle: { cancel: vi.fn(), settle: vi.fn().mockResolvedValue(true) },
        objectiveSubmissionObservation: { current: null }, submissionRequestStarted: true,
        submissionCandidateSeen: true, submissionExecutionStartAttempted: true,
        queueCatchStarted: false, submissionSuperseded: false, browserExecutionFinished: true,
        objectiveRunnerReportedSuccess: true, objectiveResultLinkCommitted: true, submissionRequestForwarded: true,
        submissionContextCloseConfirmed: false, submissionPageCloseConfirmed: false,
        activePageCloseRef: { current: null }, activeSubmissionContextClose: () => new Promise<void>(() => undefined),
        activeSubmissionContextClosePromise: null, activeBrowserExecution: null,
        submissionRouteState: { work: null, cleanup: null }, pendingSubmissionFence: null,
        submissionFenceRelease: null, submissionFenceTimer: null, armedSubmissionIntent: null,
        approvedTurnScope: scope, stopProbe: null, stopController: new AbortController(),
      },
    } as unknown as ApplyJobRunContext;
    context.lifecycle = createApplyJobFinalization(context);
    vi.useFakeTimers();
    try {
      const finished = finalizeApplyJob(context);
      await vi.advanceTimersByTimeAsync(2_000);
      await finished;
      expect(mocks.recordSettled).toHaveBeenCalledOnce();
      expect(mocks.recordSettled).toHaveBeenCalledWith(mocks.pool, scope);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a failed exact receipt write uncertain without inserting a generic result", async () => {
    vi.clearAllMocks();
    mocks.finishTask.mockResolvedValue("updated");
    const identity = { applicationTaskId: "task", userId: "user", jobId: "job", sessionId: "session", fillTurnId: "turn",
      approvalId: "approval", constraintHash: "hash" };
    const context = {
      payload: { ...identity, operation: "submit" }, submissionIdentity: identity, validSubmitPayload: true,
      taskContext: { jobTitle: "Engineer", jobCompany: "Acme" }, startedAt: Date.now(),
      state: { objectiveMode: true, objectiveResultCorrelationRequired: true, submissionClaimed: true,
        submissionRequestStarted: true, resultWritten: false, resultWriteStarted: false, applicationTaskFinalized: false,
        submissionSuperseded: false, turnStopped: false, browserAttemptStarted: true, stopController: new AbortController(),
        objectiveSubmissionRouteLifecycle: null, activeSubmissionContextClose: vi.fn().mockResolvedValue(undefined),
        activeSubmissionContextClosePromise: null, activePageCloseRef: { current: null }, submissionUncertainWrite: null },
    } as unknown as ApplyJobRunContext;
    context.lifecycle = createApplyJobFinalization(context);
    await expect(handleApplyJobFailure(context, new Error("receipt unavailable"))).resolves.toBe(false);
    await expect(handleApplyJobFailure(context, new Error("receipt unavailable"))).resolves.toBe(false);
    expect(mocks.finishTask).toHaveBeenCalledOnce();
    expect(mocks.finishTask).toHaveBeenCalledWith(mocks.pool, "task", "waiting_for_user", "submission_uncertain",
      expect.any(String), "submit", identity);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.updateJob).not.toHaveBeenCalled();
  });

  it("initiates context closure before aborting an unresponsive Objective fence release", async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    try {
      const events: string[] = [];
      const never = new Promise<void>(() => undefined);
      const release = vi.fn(() => never);
      const abort = vi.fn(() => { events.push("abort"); });
      const close = vi.fn(() => { events.push("close"); return never; });
      const context = {
        payload: {}, taskContext: null, submissionIdentity: null,
        state: {
          objectiveMode: true, objectiveSubmissionRouteLifecycle: { cancel: vi.fn(), settle: vi.fn().mockResolvedValue(true) },
          objectiveSubmissionObservation: { current: null }, submissionRequestStarted: true, submissionCandidateSeen: true,
          submissionExecutionStartAttempted: true, queueCatchStarted: false, submissionSuperseded: false,
          browserExecutionFinished: false, objectiveRunnerReportedSuccess: false, objectiveResultLinkCommitted: false,
          submissionRequestForwarded: false, submissionContextCloseConfirmed: false, submissionPageCloseConfirmed: false,
          activePageCloseRef: { current: null }, activeSubmissionContextClose: close, activeSubmissionContextClosePromise: null,
          activeBrowserExecution: null, submissionRouteState: { work: null, cleanup: null },
          pendingSubmissionFence: { state: "ready", release, abort }, submissionFenceOwner: null,
          submissionFenceRelease: null, submissionFenceTimer: null, armedSubmissionIntent: null,
          approvedTurnScope: { userId: "user" }, stopProbe: null, stopController: new AbortController(),
          applicationTaskFinalized: false, submissionUncertainWrite: null,
        },
      } as unknown as ApplyJobRunContext;
      context.lifecycle = createApplyJobFinalization(context);
      let completed = false;
      const work = finalizeApplyJob(context).then(() => { completed = true; });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(completed).toBe(true);
      await work;
      expect(release).toHaveBeenCalledOnce();
      expect(abort).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(events).toEqual(["close", "abort"]);
      expect(mocks.recordSettled).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
