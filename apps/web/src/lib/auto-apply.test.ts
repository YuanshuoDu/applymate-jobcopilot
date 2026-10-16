import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  approvalFindFirst: vi.fn(),
  transaction: vi.fn(),
  transactionCommit: vi.fn(),
  txTaskFindFirst: vi.fn(),
  txTaskUpdateMany: vi.fn(),
  txTaskEventFindMany: vi.fn(),
  txTaskEventCreate: vi.fn(),
  outboxFindUnique: vi.fn(),
  outboxCreate: vi.fn(),
  txActivityCreate: vi.fn(),
  taskUpdate: vi.fn(),
  taskFindFirst: vi.fn(),
  taskEventCreate: vi.fn(),
  resumeFindFirst: vi.fn(),
  coverLetterFindFirst: vi.fn(),
  jobUpdateMany: vi.fn(),
  jobFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
  activityCreate: vi.fn(),
  enqueueApplyTask: vi.fn(),
  runtimeFeatureEnabled: vi.fn(),
  hasEffectiveEntitlement: vi.fn(),
  isFeatureAllowed: vi.fn(),
  resolveAiAccess: vi.fn(),
  startApplicationFillForReview: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    agentApproval: { findFirst: mocks.approvalFindFirst },
    $transaction: mocks.transaction,
    applicationTask: { findFirst: mocks.taskFindFirst, update: mocks.taskUpdate, updateMany: mocks.taskUpdate },
    resume: { findFirst: mocks.resumeFindFirst },
    coverLetter: { findFirst: mocks.coverLetterFindFirst },
    applicationTaskEvent: { create: mocks.taskEventCreate },
    job: { findFirst: mocks.jobFindFirst, updateMany: mocks.jobUpdateMany },
    user: { findUnique: mocks.userFindUnique },
    activity: { create: mocks.activityCreate },
  },
}));

vi.mock("@/lib/apply-queue-client", () => ({ enqueueApplyTask: mocks.enqueueApplyTask }));
vi.mock("@/lib/runtime-feature-flags", () => ({ isRuntimeFeatureEnabled: mocks.runtimeFeatureEnabled }));
vi.mock("@/lib/entitlements", () => ({ hasEffectiveEntitlement: mocks.hasEffectiveEntitlement, isFeatureAllowed: mocks.isFeatureAllowed, resolveAiAccess: mocks.resolveAiAccess }));
vi.mock("@/lib/agent/control-plane/commands/agent-command-service", () => ({
  AgentCommandService: class {
    constructor(_db: unknown) {}
    startApplicationFillForReview = mocks.startApplicationFillForReview
  },
}));

describe("auto-apply authorization", () => {
  const input = {
    userId: "user_1", jobId: "job_1", applicationTaskId: "application_1", approvalId: "approval_1",
    receiptNonce: "nonce_1", sessionId: "session_1",
    applyUrl: "https://jobs.lever.co/acme/123",
  };

  beforeEach(() => {
    vi.resetModules();
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.approvalFindFirst.mockResolvedValue({
      id: "approval_1",
      payload: { applicationTaskId: "application_1", jobId: "job_1", resumeId: "resume_1", coverLetterId: null, confirmedAnswers: null },
      sessionId: "session_1", turnId: "turn_1", toolCallId: "call_1", jobId: "job_1", revision: 0,
      expiresAt: new Date(Date.now() + 60_000), scopeHash: "s".repeat(64),
    });
    mocks.taskFindFirst.mockResolvedValue({ sessionId: "session_1", fillTurnId: "turn_1", resumeId: "resume_1", coverLetterId: null, confirmedAnswers: null });
    mocks.txTaskFindFirst.mockResolvedValue({ status: "waiting_for_authorization", checkpoint: "form_filled", workerTaskId: null, resumeId: "resume_1", coverLetterId: null, confirmedAnswers: null, question: null });
    mocks.txTaskEventFindMany.mockResolvedValue([]);
    mocks.resumeFindFirst.mockResolvedValue({ id: "resume_1" });
    mocks.coverLetterFindFirst.mockResolvedValue({ id: "cover_1" });
    mocks.jobFindFirst.mockResolvedValue({
      company: "Acme", description: "Join the platform team with Acme. Build products.", source: "lever", url: input.applyUrl,
    });
    mocks.userFindUnique.mockResolvedValue({ accountStatus: "active" });
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
      if (typeof callback === "function") {
        const result = await callback({
          applicationTask: { findFirst: mocks.txTaskFindFirst, updateMany: mocks.txTaskUpdateMany },
          resume: { findFirst: mocks.resumeFindFirst },
          coverLetter: { findFirst: mocks.coverLetterFindFirst },
          job: { updateMany: mocks.jobUpdateMany },
          applicationTaskEvent: { findMany: mocks.txTaskEventFindMany, create: mocks.txTaskEventCreate },
          agentOutbox: { findUnique: mocks.outboxFindUnique, create: mocks.outboxCreate },
          activity: { create: mocks.txActivityCreate },
        });
        mocks.transactionCommit();
        return result;
      }
      return Promise.all(callback);
    });
    mocks.txTaskUpdateMany.mockReset().mockResolvedValue({ count: 1 })
    mocks.jobUpdateMany.mockReset().mockResolvedValue({ count: 1 })
    mocks.enqueueApplyTask.mockResolvedValue("worker_1");
    mocks.runtimeFeatureEnabled.mockResolvedValue(true);
    mocks.hasEffectiveEntitlement.mockResolvedValue(true);
    mocks.activityCreate.mockResolvedValue({});
    mocks.taskUpdate.mockResolvedValue({});
    mocks.taskEventCreate.mockResolvedValue({});
    mocks.txTaskEventCreate.mockResolvedValue({});
    mocks.outboxFindUnique.mockResolvedValue(null);
    mocks.outboxCreate.mockImplementation(async ({ data }: { data: unknown }) => data);
    mocks.txActivityCreate.mockResolvedValue({});
    mocks.isFeatureAllowed.mockResolvedValue(true);
    mocks.resolveAiAccess.mockResolvedValue('allowed');
    mocks.startApplicationFillForReview.mockResolvedValue({ inputId: "input_1", turnId: "turn_fill_1", sequence: "1", disposition: "started" });
    vi.stubEnv("ENABLE_APPLICATION_FILL_TASKGRAPH", "0");
  });

  it("queues only after matching explicit per-job authorization", async () => {
    const { queueAutonomousApplication } = await import("./auto-apply");
    const result = await queueAutonomousApplication(input);
    expect(result.taskId).toMatch(/^apply-submit-[a-f0-9]{64}$/);
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
    expect(mocks.txTaskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sessionId: "session_1", fillTurnId: "turn_1", workerTaskId: null,
        resumeId: "resume_1", coverLetterId: null, confirmedAnswers: { equals: Prisma.DbNull } }),
      data: expect.objectContaining({ workerTaskId: result.taskId }),
    }));
    expect(mocks.txTaskEventCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        taskId: "application_1", type: "submission_queued",
        data: expect.objectContaining({ applicationTaskId: "application_1", userId: "user_1", jobId: "job_1",
          sessionId: "session_1", fillTurnId: "turn_1", approvalId: "approval_1", receiptId: "approval_1", workerTaskId: result.taskId }),
      }),
    }));
    expect(mocks.outboxCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      topic: "application.submit.dispatch", aggregateId: "session_1", idempotencyKey: expect.stringMatching(/^application-submit:/),
      payload: expect.objectContaining({ workerTaskId: result.taskId, receiptId: "approval_1", submitPayload: expect.objectContaining({ receiptId: "approval_1" }) }),
    }) }));
    expect(mocks.transaction).toHaveBeenCalled();
  }, 15_000);

  it("resolves duplicate requests to the same committed submit intent and job ID", async () => {
    const { queueAutonomousApplication } = await import("./auto-apply");
    const first = await queueAutonomousApplication(input);
    const outbox = mocks.outboxCreate.mock.calls[0]?.[0]?.data;
    const event = mocks.txTaskEventCreate.mock.calls[0]?.[0]?.data?.data;
    mocks.txTaskFindFirst.mockResolvedValueOnce({ status: "filling", checkpoint: "submission_authorized", workerTaskId: first.taskId,
      resumeId: "resume_1", coverLetterId: null, confirmedAnswers: null });
    mocks.outboxFindUnique.mockResolvedValueOnce(outbox);
    mocks.txTaskEventFindMany.mockResolvedValueOnce([{ data: event }]);

    await expect(queueAutonomousApplication(input)).resolves.toEqual(first);
    expect(mocks.txTaskUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.outboxCreate).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it.each([
    ["resume", { resumeId: "resume_2" }],
    ["cover letter", { coverLetterId: "cover_2" }],
    ["confirmed answers", { confirmedAnswers: { Location: "Cork" } }],
  ] as const)("rejects when approved %s change before the submit transaction", async (_field, changed) => {
    mocks.txTaskFindFirst.mockResolvedValueOnce({
      status: "waiting_for_authorization", checkpoint: "form_filled", workerTaskId: null,
      resumeId: "resume_1", coverLetterId: null, confirmedAnswers: null, question: null, ...changed,
    });
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("no longer ready");
    expect(mocks.txTaskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled();
    expect(mocks.txTaskEventCreate).not.toHaveBeenCalled();
    expect(mocks.outboxCreate).not.toHaveBeenCalled();
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("rejects a missing current fill Turn before enqueueing submission", async () => {
    mocks.taskFindFirst.mockResolvedValueOnce({ sessionId: "session_1", fillTurnId: null, resumeId: "resume_1", coverLetterId: null, confirmedAnswers: null });
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("explicit approval");
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects an approval bound to another fill Turn or session", async () => {
    mocks.approvalFindFirst.mockResolvedValueOnce({
      id: "approval_1",
      payload: { applicationTaskId: "application_1", jobId: "job_1", resumeId: "resume_1", coverLetterId: null },
      sessionId: "session_other", turnId: "turn_other", toolCallId: "call_1", jobId: "job_1", revision: 0,
      expiresAt: new Date(Date.now() + 60_000), scopeHash: "s".repeat(64),
    });
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("explicit approval");
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects a caller session that does not match the current task", async () => {
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication({ ...input, sessionId: "session_other" })).rejects.toThrow("explicit approval");
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rolls back the claim when outbox persistence fails and never dispatches Redis work", async () => {
    mocks.outboxCreate.mockRejectedValueOnce(new Error("outbox unavailable"));
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("outbox unavailable");
    expect(mocks.transactionCommit).not.toHaveBeenCalled();
    expect(mocks.txTaskUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.jobUpdateMany).toHaveBeenCalledTimes(1)
    expect(mocks.txTaskEventCreate).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  })

  it("rolls back the task claim when the canonical Job transition loses its race", async () => {
    mocks.jobUpdateMany.mockResolvedValueOnce({ count: 0 });
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("no longer ready");
    expect(mocks.txTaskUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.transactionCommit).not.toHaveBeenCalled();
    expect(mocks.txTaskEventCreate).not.toHaveBeenCalled();
    expect(mocks.outboxCreate).not.toHaveBeenCalled();
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  })

  it("rejects autonomous submission when the current plan lacks auto-apply", async () => {
    mocks.isFeatureAllowed.mockResolvedValueOnce(false);
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("not included in your current plan");
    expect(mocks.approvalFindFirst).not.toHaveBeenCalled();
  });

  it("rejects autonomous submission when monthly AI credits are exhausted", async () => {
    mocks.resolveAiAccess.mockResolvedValueOnce('exhausted');
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("Monthly AI credits exhausted");
    expect(mocks.approvalFindFirst).not.toHaveBeenCalled();
  });

  it("queues a fill-only pass without changing the job into a submission", async () => {
    mocks.taskUpdate.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({});
    const { queueApplicationFill } = await import("./auto-apply");
    await expect(queueApplicationFill({
      userId: "user_1", jobId: "job_1", applicationTaskId: "application_1", applyUrl: input.applyUrl,
    })).resolves.toEqual({ taskId: "worker_1" });
    expect(mocks.enqueueApplyTask).toHaveBeenCalledWith(expect.objectContaining({ operation: "fill" }));
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled();
  });

  it("routes a user-input resume through the TaskGraph resume transaction", async () => {
    vi.stubEnv("ENABLE_APPLICATION_FILL_TASKGRAPH", "1");
    mocks.taskFindFirst.mockResolvedValueOnce({ sessionId: "session_1", fillTurnId: "turn_waiting" });
    const { queueApplicationFill } = await import("./auto-apply");

    await expect(queueApplicationFill({
      userId: "user_1", jobId: "job_1", applicationTaskId: "application_1", applyUrl: input.applyUrl,
      resumeAfterUserInput: true,
    })).resolves.toMatchObject({ taskId: "turn_fill_1", turnId: "turn_fill_1", disposition: "started" });

    expect(mocks.startApplicationFillForReview).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session_1", userId: "user_1", applicationTaskId: "application_1",
      clientMessageId: "application-fill-resume:application_1", resumeAfterUserInput: true,
    }));
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("keeps TaskGraph fill disabled by default and uses the existing ApplyQueue fallback", async () => {
    mocks.taskUpdate.mockResolvedValueOnce({ count: 1 });
    const { applicationFillTaskGraphEnabled, queueApplicationFill } = await import("./auto-apply");
    expect(applicationFillTaskGraphEnabled(undefined)).toBe(false);
    await expect(queueApplicationFill(input)).resolves.toEqual({ taskId: "worker_1" });
    expect(mocks.enqueueApplyTask).toHaveBeenCalledWith(expect.objectContaining({ operation: "fill" }));
    expect(mocks.startApplicationFillForReview).not.toHaveBeenCalled();
  });

  it("routes enabled fill-for-review to one deterministic canonical Turn without enqueuing ApplyQueue", async () => {
    vi.stubEnv("ENABLE_APPLICATION_FILL_TASKGRAPH", "1");
    const { queueApplicationFill } = await import("./auto-apply");
    await expect(queueApplicationFill(input)).resolves.toEqual({ taskId: "turn_fill_1", turnId: "turn_fill_1", disposition: "started" });
    expect(mocks.startApplicationFillForReview).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session_1", userId: "user_1", applicationTaskId: "application_1", clientMessageId: "application-fill:application_1",
    }));
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("does not queue unattended browser work when the platform control is disabled", async () => {
    mocks.runtimeFeatureEnabled.mockResolvedValueOnce(false);
    mocks.taskUpdate.mockResolvedValueOnce({ count: 1 });
    const { queueApplicationFill } = await import("./auto-apply");

    await expect(queueApplicationFill({
      userId: "user_1", jobId: "job_1", applicationTaskId: "application_1", applyUrl: input.applyUrl,
    })).rejects.toThrow("temporarily unavailable");

    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("rejects a global setting or unrelated approval as submission consent", async () => {
    mocks.approvalFindFirst.mockResolvedValue({
      payload: { applicationTaskId: "other", jobId: "job_1", resumeId: "resume_1", coverLetterId: null },
      sessionId: "session_1", turnId: "turn_1", toolCallId: "call_1", jobId: "job_1", revision: 0,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { queueAutonomousApplication } = await import("./auto-apply");
    await expect(queueAutonomousApplication(input)).rejects.toThrow("explicit approval");
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("rejects a legacy approval that has no canonical scope hash", async () => {
    mocks.approvalFindFirst.mockResolvedValueOnce({
      payload: { applicationTaskId: "application_1", jobId: "job_1", resumeId: "resume_1", coverLetterId: null },
      sessionId: "session_1", turnId: "turn_1", toolCallId: "call_1", jobId: "job_1", revision: 0,
      expiresAt: new Date(Date.now() + 60_000), scopeHash: null,
    });
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("explicit approval");
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("rejects a stale task whose resume does not belong to this job or the current default", async () => {
    mocks.approvalFindFirst.mockResolvedValueOnce({
      id: "approval_1",
      payload: { applicationTaskId: "application_1", jobId: "job_1", resumeId: "resume_1", coverLetterId: null },
      sessionId: "session_1", turnId: "turn_1", toolCallId: "call_1", jobId: "job_1", revision: 0,
      expiresAt: new Date(Date.now() + 60_000), scopeHash: "s".repeat(64),
    });
    mocks.taskFindFirst
      .mockResolvedValueOnce({ sessionId: "session_1", fillTurnId: "turn_1", resumeId: "resume_1", coverLetterId: null, confirmedAnswers: null })
      .mockResolvedValueOnce({ resumeId: "resume_1", coverLetterId: null });
    mocks.resumeFindFirst.mockResolvedValueOnce(null);
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("no longer ready");

    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("rejects a task whose stored cover letter belongs to a different application", async () => {
    mocks.taskFindFirst
      .mockResolvedValueOnce({ sessionId: "session_1", fillTurnId: "turn_1", resumeId: "resume_1", coverLetterId: "cover_other", confirmedAnswers: null })
      .mockResolvedValueOnce({ resumeId: "resume_1", coverLetterId: "cover_other" });
    mocks.txTaskFindFirst.mockResolvedValueOnce({ status: "waiting_for_authorization", checkpoint: "form_filled", workerTaskId: null, resumeId: "resume_1", coverLetterId: "cover_other", question: null });
    mocks.approvalFindFirst.mockResolvedValueOnce({
      id: "approval_1",
      payload: { applicationTaskId: "application_1", jobId: "job_1", resumeId: "resume_1", coverLetterId: "cover_other" },
      sessionId: "session_1", turnId: "turn_1", toolCallId: "call_1", jobId: "job_1", revision: 0,
      expiresAt: new Date(Date.now() + 60_000), scopeHash: "s".repeat(64),
    });
    mocks.coverLetterFindFirst.mockResolvedValueOnce(null);
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("no longer ready");

    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("rejects blocked job-board URLs before reading or changing state", async () => {
    const { queueAutonomousApplication } = await import("./auto-apply");
    await expect(queueAutonomousApplication({ ...input, applyUrl: "https://www.linkedin.com/jobs/view/123" })).rejects.toThrow("direct supported ATS");
    expect(mocks.approvalFindFirst).not.toHaveBeenCalled();
  });

  it("rejects a direct ATS URL when the saved job identity conflicts with its description", async () => {
    mocks.jobFindFirst.mockResolvedValueOnce({
      company: "Questionmark", description: "Join Future of EdTech with Learnosity. At Learnosity, build products.", source: "lever", url: input.applyUrl,
    });
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("does not match")
    expect(mocks.approvalFindFirst).not.toHaveBeenCalled();
  });
});
