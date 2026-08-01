import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agentConfigFindUnique: vi.fn(),
  jobUpdateMany: vi.fn(),
  activityCreate: vi.fn(),
  enqueueApplyTask: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    agentConfig: { findUnique: mocks.agentConfigFindUnique },
    job: { updateMany: mocks.jobUpdateMany },
    activity: { create: mocks.activityCreate },
  },
}));

vi.mock("@/lib/apply-queue-client", () => ({
  enqueueApplyTask: mocks.enqueueApplyTask,
}));

describe("auto-apply", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.agentConfigFindUnique.mockResolvedValue({ autoApply: true, requireApproval: false });
    mocks.jobUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 1 });
    mocks.enqueueApplyTask.mockResolvedValue("task_1");
    mocks.activityCreate.mockResolvedValue({});
  });

  it("queues an eligible job after atomically claiming it", async () => {
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication({
      userId: "user_1",
      jobId: "job_1",
      applyUrl: "https://jobs.lever.co/acme/123",
    })).resolves.toEqual({ taskId: "task_1" });

    expect(mocks.jobUpdateMany).toHaveBeenNthCalledWith(1, {
      where: expect.objectContaining({
        id: "job_1",
        userId: "user_1",
        status: "saved",
        workflowState: { in: ["draft", "ready_to_apply"] },
      }),
      data: expect.objectContaining({ workflowState: "queued" }),
    });
    expect(mocks.enqueueApplyTask).toHaveBeenCalledWith({
      jobId: "job_1",
      userId: "user_1",
      applyUrl: "https://jobs.lever.co/acme/123",
    });
  });

  it("rejects blocked job-board URLs before changing state", async () => {
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication({
      userId: "user_1",
      jobId: "job_1",
      applyUrl: "https://www.linkedin.com/jobs/view/123",
    })).rejects.toThrow("not supported");
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled();
  });

  it("restores the ready state when the queue cannot accept a task", async () => {
    mocks.enqueueApplyTask.mockRejectedValueOnce(new Error("Redis unavailable"));
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication({
      userId: "user_1",
      jobId: "job_1",
      applyUrl: "https://boards.greenhouse.io/acme/jobs/123",
    })).rejects.toThrow("Redis unavailable");
    expect(mocks.jobUpdateMany).toHaveBeenLastCalledWith({
      where: { id: "job_1", userId: "user_1", workflowState: "queued" },
      data: { workflowState: "ready_to_apply" },
    });
  });
});
