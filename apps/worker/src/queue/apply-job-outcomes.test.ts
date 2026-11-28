import { describe, expect, it, vi } from "vitest";
import { createNotification } from "../notifications/create-notification.js";
import { createApplyResultNotification } from "./apply-job-outcomes.js";
import { persistApplyJobOutcome } from "./apply-job-outcomes.js";
import type { ApplyJobRunContext } from "./apply-job-runner.js";
import type { HarnessResult } from "../harness/agent-harness.js";
import type { Page } from "playwright-core";

const mocks = vi.hoisted(() => ({
  insert: vi.fn(), recordObjective: vi.fn(), updateJob: vi.fn(), finishTask: vi.fn(),
  notifyEmail: vi.fn(), purge: vi.fn(), pool: {},
}));
vi.mock("../db/apply-results.js", () => ({ getPool: () => mocks.pool, insertApplyResult: mocks.insert }));
vi.mock("../db/objective-application-submit-result.js", () => ({ recordObjectiveApplicationSubmitResult: mocks.recordObjective }));
vi.mock("../db/submission-guard.js", () => ({ updateJobForSubmission: mocks.updateJob, UNCONFIRMED_SUBMISSION_MESSAGE: "uncertain" }));
vi.mock("../db/application-task-state.js", () => ({ finishApplicationTask: mocks.finishTask, needsUserTakeover: () => false }));
vi.mock("../notifications/notify-apply-result.js", () => ({ notifyApplyResult: mocks.notifyEmail }));
vi.mock("../notifications/purge-cover-letters.js", () => ({ purgeTemporaryGeneratedCoverLetters: mocks.purge }));

vi.mock("../notifications/create-notification.js", () => ({ createNotification: vi.fn().mockResolvedValue(undefined) }));

describe("application outcome notifications", () => {
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
});

describe("Objective submission outcome", () => {
  function scenario(): { context: ApplyJobRunContext; result: HarnessResult } {
    const identity = { applicationTaskId: "task", userId: "user", jobId: "job", sessionId: "session",
      fillTurnId: "turn", approvalId: "approval", constraintHash: "a".repeat(64) };
    const context = {
      payload: { ...identity, operation: "submit" }, submissionIdentity: identity,
      workerTaskId: "worker", executionId: "execution", startedAt: Date.now(),
      taskContext: { jobTitle: "Engineer", jobCompany: "Acme", applyUrl: "https://boards.greenhouse.io/acme/jobs/1" },
      state: { objectiveMode: true, objectiveRunnerReportedSuccess: true, objectiveRunnerConfirmationId: "confirmation",
        submissionRequestStarted: true, submissionRequestForwarded: true, submissionFenceUnavailable: false,
        submissionAcknowledgementUncertain: false, turnStopped: false, submissionTaskInactive: false,
        challengeBoundary: null, queueCatchStarted: false, submissionSuperseded: false,
        applicationTaskFinalized: false, resultWritten: false, resultWriteStarted: false,
        objectiveResultLinkCommitted: false, objectiveResultCorrelationRequired: false, flow: "greenhouse", usedFlow: "application.submit" },
    } as unknown as ApplyJobRunContext;
    return { context, result: { status: "submitted", turns: 1, durationMs: 10, error: null, log: [] } };
  }

  it("records only the exact Objective receipt before marking the task submitted", async () => {
    vi.clearAllMocks();
    mocks.recordObjective.mockResolvedValueOnce({ kind: "recorded", resultId: 73 });
    mocks.updateJob.mockResolvedValueOnce({ kind: "current" });
    mocks.finishTask.mockResolvedValueOnce("updated");
    mocks.notifyEmail.mockResolvedValue(undefined);
    mocks.purge.mockResolvedValue(undefined);
    const { context, result } = scenario();
    await persistApplyJobOutcome(context, {} as Page, result);
    expect(mocks.recordObjective).toHaveBeenCalledWith(expect.objectContaining({
      execution: expect.objectContaining({ ...context.submissionIdentity, workerTaskId: "worker", executionId: "execution" }),
      runnerStatus: "submitted", confirmationId: "confirmation", requestStarted: true, requestContinued: true, fenceUnavailable: false,
    }));
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(context.state.objectiveResultLinkCommitted).toBe(true);
    expect(mocks.finishTask).toHaveBeenCalledWith(expect.anything(), "task", "submitted", "submission_verified",
      null, "submit", context.submissionIdentity, { preserveRunnableSession: true });
  });

  it("treats current-invalid as uncertain instead of silently calling it superseded", async () => {
    vi.clearAllMocks();
    mocks.recordObjective.mockResolvedValueOnce({ kind: "invalid" });
    const { context, result } = scenario();
    await expect(persistApplyJobOutcome(context, {} as Page, result)).rejects.toThrow("Objective submission result could not be verified.");
    expect(context.state.objectiveResultCorrelationRequired).toBe(true);
    expect(context.state.submissionSuperseded).toBe(false);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.updateJob).not.toHaveBeenCalled();
  });

  it("leaves a truly superseded result untouched", async () => {
    vi.clearAllMocks();
    mocks.recordObjective.mockResolvedValueOnce({ kind: "superseded" });
    const { context, result } = scenario();
    await persistApplyJobOutcome(context, {} as Page, result);
    expect(context.state.submissionSuperseded).toBe(true);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.updateJob).not.toHaveBeenCalled();
    expect(mocks.finishTask).not.toHaveBeenCalled();
  });

  it("never falls back to a generic success when the exact receipt write fails", async () => {
    vi.clearAllMocks();
    mocks.recordObjective.mockRejectedValueOnce(new Error("receipt unavailable"));
    const { context, result } = scenario();
    await expect(persistApplyJobOutcome(context, {} as Page, result)).rejects.toThrow("receipt unavailable");
    expect(context.state.objectiveResultCorrelationRequired).toBe(true);
    expect(context.state.objectiveResultLinkCommitted).toBe(false);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.updateJob).not.toHaveBeenCalled();
    expect(mocks.finishTask).not.toHaveBeenCalled();
  });
});
