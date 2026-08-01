import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ add: vi.fn(), queue: vi.fn(), redis: vi.fn() }));

vi.mock("bullmq", () => ({
  Queue: mocks.queue.mockImplementation(() => ({ add: mocks.add })),
}));
vi.mock("ioredis", () => ({ Redis: mocks.redis }));

describe("enqueueAgentRun", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.add.mockReset();
    mocks.queue.mockClear();
    mocks.redis.mockClear();
    mocks.add.mockResolvedValue({ id: "agent_task_1" });
  });

  it("enqueues a retryable background task for the worker", async () => {
    const { enqueueAgentRun } = await import("./agent-run-queue-client");

    await expect(enqueueAgentRun({ userId: "user_1", sessionId: "session_1" })).resolves.toBe("agent_task_1");
    expect(mocks.add).toHaveBeenCalledWith("run", { userId: "user_1", sessionId: "session_1" }, {
      attempts: 3,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    });
  });
});
