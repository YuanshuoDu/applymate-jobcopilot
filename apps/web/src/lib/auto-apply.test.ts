import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  approvalFindFirst: vi.fn(),
  transaction: vi.fn(),
  taskUpdate: vi.fn(),
  taskEventCreate: vi.fn(),
  jobUpdateMany: vi.fn(),
  activityCreate: vi.fn(),
  enqueueApplyTask: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    agentApproval: { findFirst: mocks.approvalFindFirst },
    $transaction: mocks.transaction,
    applicationTask: { update: mocks.taskUpdate, updateMany: mocks.taskUpdate },
    applicationTaskEvent: { create: mocks.taskEventCreate },
    job: { updateMany: mocks.jobUpdateMany },
    activity: { create: mocks.activityCreate },
  },
}));

vi.mock("@/lib/apply-queue-client", () => ({ enqueueApplyTask: mocks.enqueueApplyTask }));

describe("auto-apply authorization", () => {
  const input = {
    userId: "user_1", jobId: "job_1", applicationTaskId: "application_1", approvalId: "approval_1",
    applyUrl: "https://jobs.lever.co/acme/123",
  };

  beforeEach(() => {
    vi.resetModules();
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.approvalFindFirst.mockResolvedValue({ payload: { applicationTaskId: "application_1", jobId: "job_1" } });
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
      if (typeof callback === "function") {
        return callback({ applicationTask: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) }, job: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } });
      }
      return Promise.all(callback);
    });
    mocks.enqueueApplyTask.mockResolvedValue("worker_1");
    mocks.activityCreate.mockResolvedValue({});
    mocks.taskUpdate.mockResolvedValue({});
    mocks.taskEventCreate.mockResolvedValue({});
  });

  it("queues only after matching explicit per-job authorization", async () => {
    const { queueAutonomousApplication } = await import("./auto-apply");
    await expect(queueAutonomousApplication(input)).resolves.toEqual({ taskId: "worker_1" });
    expect(mocks.enqueueApplyTask).toHaveBeenCalledWith({
      applicationTaskId: "application_1", jobId: "job_1", userId: "user_1", applyUrl: input.applyUrl,
    });
  });

  it("rejects a global setting or unrelated approval as submission consent", async () => {
    mocks.approvalFindFirst.mockResolvedValue({ payload: { applicationTaskId: "other", jobId: "job_1" } });
    const { queueAutonomousApplication } = await import("./auto-apply");
    await expect(queueAutonomousApplication(input)).rejects.toThrow("explicit approval");
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("rejects blocked job-board URLs before reading or changing state", async () => {
    const { queueAutonomousApplication } = await import("./auto-apply");
    await expect(queueAutonomousApplication({ ...input, applyUrl: "https://www.linkedin.com/jobs/view/123" })).rejects.toThrow("not supported");
    expect(mocks.approvalFindFirst).not.toHaveBeenCalled();
  });
});
