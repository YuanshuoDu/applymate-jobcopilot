import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  approvalFindFirst: vi.fn(),
  transaction: vi.fn(),
  taskUpdate: vi.fn(),
  taskFindFirst: vi.fn(),
  taskEventCreate: vi.fn(),
  resumeFindFirst: vi.fn(),
  coverLetterFindFirst: vi.fn(),
  jobUpdateMany: vi.fn(),
  jobFindFirst: vi.fn(),
  activityCreate: vi.fn(),
  enqueueApplyTask: vi.fn(),
  isFeatureAllowed: vi.fn(),
  resolveAiAccess: vi.fn(),
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
    activity: { create: mocks.activityCreate },
  },
}));

vi.mock("@/lib/apply-queue-client", () => ({ enqueueApplyTask: mocks.enqueueApplyTask }));
vi.mock("@/lib/entitlements", () => ({ isFeatureAllowed: mocks.isFeatureAllowed, resolveAiAccess: mocks.resolveAiAccess }));

describe("auto-apply authorization", () => {
  const input = {
    userId: "user_1", jobId: "job_1", applicationTaskId: "application_1", approvalId: "approval_1",
    applyUrl: "https://jobs.lever.co/acme/123",
  };

  beforeEach(() => {
    vi.resetModules();
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.approvalFindFirst.mockResolvedValue({ payload: { applicationTaskId: "application_1", jobId: "job_1" } });
    mocks.taskFindFirst.mockResolvedValue({ resumeId: "resume_1", coverLetterId: null });
    mocks.resumeFindFirst.mockResolvedValue({ id: "resume_1" });
    mocks.coverLetterFindFirst.mockResolvedValue({ id: "cover_1" });
    mocks.jobFindFirst.mockResolvedValue({
      company: "Acme", description: "Join the platform team with Acme. Build products.", source: "lever", url: input.applyUrl,
    });
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
      if (typeof callback === "function") {
        return callback({
          applicationTask: { findFirst: mocks.taskFindFirst, updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
          resume: { findFirst: mocks.resumeFindFirst },
          coverLetter: { findFirst: mocks.coverLetterFindFirst },
          job: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        });
      }
      return Promise.all(callback);
    });
    mocks.enqueueApplyTask.mockResolvedValue("worker_1");
    mocks.activityCreate.mockResolvedValue({});
    mocks.taskUpdate.mockResolvedValue({});
    mocks.taskEventCreate.mockResolvedValue({});
    mocks.isFeatureAllowed.mockResolvedValue(true);
    mocks.resolveAiAccess.mockResolvedValue('allowed');
  });

  it("queues only after matching explicit per-job authorization", async () => {
    const { queueAutonomousApplication } = await import("./auto-apply");
    await expect(queueAutonomousApplication(input)).resolves.toEqual({ taskId: "worker_1" });
    expect(mocks.enqueueApplyTask).toHaveBeenCalledWith({
      applicationTaskId: "application_1", jobId: "job_1", userId: "user_1", applyUrl: input.applyUrl, operation: "submit",
    });
    expect(mocks.transaction).toHaveBeenCalled();
  });

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

  it("rejects a global setting or unrelated approval as submission consent", async () => {
    mocks.approvalFindFirst.mockResolvedValue({ payload: { applicationTaskId: "other", jobId: "job_1" } });
    const { queueAutonomousApplication } = await import("./auto-apply");
    await expect(queueAutonomousApplication(input)).rejects.toThrow("explicit approval");
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("rejects a stale task whose resume does not belong to this job or the current default", async () => {
    mocks.resumeFindFirst.mockResolvedValueOnce(null);
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("no longer ready");

    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("rejects a task whose stored cover letter belongs to a different application", async () => {
    mocks.taskFindFirst.mockResolvedValueOnce({ resumeId: "resume_1", coverLetterId: "cover_other" });
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
