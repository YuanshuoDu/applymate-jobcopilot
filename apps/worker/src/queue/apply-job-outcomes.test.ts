import { beforeEach, describe, expect, it, vi } from "vitest";

const outcomeMocks = vi.hoisted(() => ({
  finishTask: vi.fn(), insertResult: vi.fn(), updateJob: vi.fn(), poolQuery: vi.fn(),
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
vi.mock("./legacy-apply-outcomes.js", () => ({
  persistLegacyFillHarnessOutcome: vi.fn(), persistLegacyFillErrorOutcome: vi.fn(),
  persistUnavailableLegacyFillOutcome: vi.fn(),
}));

import { createNotification } from "../notifications/create-notification.js";
import { createApplyResultNotification, handOffUnavailableUnattendedTask } from "./apply-job-outcomes.js";

vi.mock("../notifications/create-notification.js", () => ({ createNotification: vi.fn().mockResolvedValue(undefined) }));

describe("application outcome notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outcomeMocks.insertResult.mockResolvedValue(1);
    outcomeMocks.updateJob.mockResolvedValue({ kind: "current", value: true });
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
});
