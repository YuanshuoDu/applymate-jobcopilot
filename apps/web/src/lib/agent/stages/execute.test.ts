import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queueAutonomousApplication: vi.fn(),
  activityCreate: vi.fn(),
}));

vi.mock("@/lib/auto-apply", () => ({
  queueAutonomousApplication: mocks.queueAutonomousApplication,
}));

vi.mock("@/lib/db", () => ({
  db: { activity: { create: mocks.activityCreate } },
}));

function context(events: Array<{ event: string; data: unknown }>) {
  return {
    userId: "user_1",
    agentCfg: { autoApply: true, requireApproval: false },
    emit: (event: string, data: unknown) => events.push({ event, data }),
  } as never;
}

const packageRow = {
  job: { id: "job_1", company: "Acme", role: "Engineer", url: "https://jobs.lever.co/acme/1", location: "Berlin" },
  score: 92,
  matchedKeywords: ["TypeScript"],
};

describe("runExecute", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.queueAutonomousApplication.mockReset();
    mocks.activityCreate.mockReset();
    mocks.queueAutonomousApplication.mockResolvedValue({ taskId: "task_1" });
    mocks.activityCreate.mockResolvedValue({});
  });

  it("dispatches approved packages to the unattended worker", async () => {
    const events: Array<{ event: string; data: unknown }> = [];
    const { runExecute } = await import("./execute");

    const result = await runExecute([packageRow] as never, context(events));

    expect(result.data).toEqual({ queued: ["job_1"], failed: [] });
    expect(mocks.queueAutonomousApplication).toHaveBeenCalledWith({
      userId: "user_1",
      jobId: "job_1",
      applyUrl: "https://jobs.lever.co/acme/1",
      approvalPolicy: { autoApply: true, requireApproval: false },
    });
    expect(events).toContainEqual(expect.objectContaining({ event: "application_queued" }));
  });

  it("reports a queue failure without claiming the job was submitted", async () => {
    mocks.queueAutonomousApplication.mockRejectedValueOnce(new Error("Redis unavailable"));
    const events: Array<{ event: string; data: unknown }> = [];
    const { runExecute } = await import("./execute");

    const result = await runExecute([packageRow] as never, context(events));

    expect(result.data).toEqual({ queued: [], failed: ["job_1"] });
    expect(mocks.activityCreate).toHaveBeenCalled();
  });
});
