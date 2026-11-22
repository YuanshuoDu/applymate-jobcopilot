import { describe, expect, it, vi } from "vitest";
import type { ApplyJobRunContext } from "./apply-job-runner.js";

const finalizationMocks = vi.hoisted(() => ({ finishTask: vi.fn(), insertResult: vi.fn(), updateJob: vi.fn() }));
vi.mock("../db/application-task-state.js", () => ({
  finishApplicationTask: finalizationMocks.finishTask,
  isConfirmedApplicationTaskFinish: (result: string) => result === "current" || result === "already_current",
  USER_TAKEOVER_CHECKPOINT: "user_takeover",
}));
vi.mock("../db/apply-results.js", () => ({ getPool: vi.fn(() => ({})), insertApplyResult: finalizationMocks.insertResult }));
vi.mock("../db/submission-guard.js", () => ({
  updateJobForSubmission: finalizationMocks.updateJob,
  UNCONFIRMED_SUBMISSION_MESSAGE: "Submit outcome uncertain.",
}));
vi.mock("./apply-job-outcomes.js", () => ({ createApplyResultNotification: vi.fn().mockResolvedValue(undefined) }));

import { createApplyJobFinalization, handleApplyJobFailure } from "./apply-job-finalization.js";

describe("apply job finalization", () => {
  it.each(["unconfirmed", "superseded"] as const)("does not mark %s uncertainty as finalized", async result => {
    finalizationMocks.finishTask.mockResolvedValueOnce(result);
    const context = {
      payload: { applicationTaskId: "task" },
      submissionIdentity: { applicationTaskId: "task", userId: "user", jobId: "job", sessionId: "session", fillTurnId: "turn", approvalId: "approval", constraintHash: "a".repeat(64) },
      state: { applicationTaskFinalized: false, submissionSuperseded: false, submissionUncertainWrite: null },
    } as unknown as ApplyJobRunContext;
    const lifecycle = createApplyJobFinalization(context);

    await expect(lifecycle.markSubmissionUncertain("uncertain")).resolves.toBe(result === "superseded" ? "superseded" : "failed");
    expect(context.state.applicationTaskFinalized).toBe(false);
  });

  it("accepts an exact idempotent uncertainty state as durable", async () => {
    finalizationMocks.finishTask.mockResolvedValueOnce("already_current");
    const context = {
      payload: { applicationTaskId: "task" },
      submissionIdentity: { applicationTaskId: "task", userId: "user", jobId: "job", sessionId: "session", fillTurnId: "turn", approvalId: "approval", constraintHash: "a".repeat(64) },
      state: { applicationTaskFinalized: false, submissionSuperseded: false, submissionUncertainWrite: null },
    } as unknown as ApplyJobRunContext;
    const lifecycle = createApplyJobFinalization(context);

    await expect(lifecycle.markSubmissionUncertain("uncertain")).resolves.toBe("written");
    expect(context.state.applicationTaskFinalized).toBe(true);
  });

  it("returns to recovery when a submit terminal task write is unconfirmed", async () => {
    finalizationMocks.finishTask.mockClear();
    finalizationMocks.insertResult.mockResolvedValueOnce(1);
    finalizationMocks.finishTask.mockResolvedValueOnce("unconfirmed");
    finalizationMocks.updateJob.mockResolvedValueOnce({ kind: "current", value: true });
    const state = {
      applicationTaskFinalized: false, submissionSuperseded: false, submissionUncertainWrite: null,
      submissionClaimed: true, submissionRequestStarted: false, turnStopped: false, browserAttemptStarted: false,
      resultWritten: false, resultWriteStarted: false, activeSubmissionContextClose: null, stopController: new AbortController(),
    };
    const context = {
      payload: { applicationTaskId: "task", operation: "submit", userId: "user", jobId: "job" },
      submissionIdentity: { applicationTaskId: "task", userId: "user", jobId: "job", sessionId: "session", fillTurnId: "turn", approvalId: "approval", constraintHash: "a".repeat(64) },
      validSubmitPayload: true, taskContext: null, startedAt: Date.now(), state,
      lifecycle: { markSubmissionUncertain: vi.fn().mockResolvedValue("written"), closeActivePage: vi.fn().mockResolvedValue(undefined) },
    } as unknown as ApplyJobRunContext;

    await expect(handleApplyJobFailure(context, new Error("browser result lost"))).resolves.toBe(true);
    expect(finalizationMocks.finishTask).toHaveBeenCalledOnce();
    expect(state.applicationTaskFinalized).toBe(false);
  });

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
});
