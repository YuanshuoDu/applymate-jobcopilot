import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnqueueApplyInput, ApplyQueueSubmissionIdentity } from "./apply-queue-client";

const mocks = vi.hoisted(() => ({
  redis: { exists: vi.fn(), del: vi.fn() },
  getJob: vi.fn(),
  add: vi.fn(),
  close: vi.fn(),
  toKey: vi.fn((jobId: string) => `bull:apply-tasks:${jobId}`),
}));

vi.mock("ioredis", () => ({
  Redis: class MockRedis {
    exists = mocks.redis.exists;
    del = mocks.redis.del;
  },
}));
vi.mock("bullmq", () => ({
  Queue: class MockQueue {
    getJob = mocks.getJob;
    add = mocks.add;
    close = mocks.close;
    toKey = mocks.toKey;
  },
}));

import {
  closeApplyQueueClient,
  enqueueApplyTask,
  verifyAndCancelSubmissionJob,
} from "./apply-queue-client";

const workerTaskId = "submit-queue-job-1";
const expected: ApplyQueueSubmissionIdentity = {
  applicationTaskId: "task-1",
  userId: "user-1",
  jobId: "job-1",
  sessionId: "session-1",
  fillTurnId: "turn-1",
  receiptId: "approval-1",
  constraintHash: "hash-1",
};
const identityMismatches: Array<[string, { id?: string; data?: Record<string, unknown> }]> = [
  ["job id", { id: "another-job" }],
  ["operation", { data: { operation: "fill" } }],
  ["task", { data: { applicationTaskId: "another-task" } }],
  ["user", { data: { userId: "another-user" } }],
  ["employer job", { data: { jobId: "another-employer-job" } }],
  ["session", { data: { sessionId: "another-session" } }],
  ["turn", { data: { fillTurnId: "old-turn" } }],
  ["approval", { data: { receiptId: "another-approval" } }],
  ["constraint hash", { data: { constraintHash: "stale-hash" } }],
];

function createJob(
  state: string,
  overrides: { id?: string; data?: Record<string, unknown>; removeError?: Error } = {},
) {
  return {
    id: overrides.id ?? workerTaskId,
    data: { ...expected, operation: "submit", ...overrides.data } as EnqueueApplyInput,
    getState: vi.fn().mockResolvedValue(state),
    remove: overrides.removeError
      ? vi.fn().mockRejectedValue(overrides.removeError)
      : vi.fn().mockResolvedValue(undefined),
  };
}

describe("apply queue submission recovery check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redis.exists.mockResolvedValue(0);
    mocks.getJob.mockResolvedValue(undefined);
    mocks.add.mockResolvedValue({ id: workerTaskId });
    mocks.close.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await closeApplyQueueClient();
  });

  it.each(["completed", "failed"])("accepts matching %s jobs only when their exact lock is absent", async status => {
    const job = createJob(status);
    mocks.getJob.mockResolvedValue(job);

    await expect(verifyAndCancelSubmissionJob({ workerTaskId, expected })).resolves.toBe(true);
    expect(job.remove).not.toHaveBeenCalled();
    expect(mocks.redis.exists).toHaveBeenCalledWith(`bull:apply-tasks:${workerTaskId}:lock`);
    expect(mocks.redis.del).not.toHaveBeenCalled();
  });

  it("fails closed for missing IDs, missing jobs, and missing expected identity", async () => {
    await expect(verifyAndCancelSubmissionJob({ workerTaskId: "", expected })).resolves.toBe(false);
    await expect(verifyAndCancelSubmissionJob({ workerTaskId: " ", expected })).resolves.toBe(false);
    await expect(verifyAndCancelSubmissionJob({ workerTaskId, expected: undefined })).resolves.toBe(false);
    await expect(verifyAndCancelSubmissionJob({ workerTaskId, expected })).resolves.toBe(false);
    expect(mocks.getJob).toHaveBeenCalledTimes(1);
  });

  it.each(identityMismatches)("rejects a mismatched %s", async (_label, overrides) => {
    mocks.getJob.mockResolvedValue(createJob("completed", overrides));
    await expect(verifyAndCancelSubmissionJob({ workerTaskId, expected })).resolves.toBe(false);
    expect(mocks.redis.exists).not.toHaveBeenCalled();
  });

  it.each(["completed", "failed", "waiting", "delayed"])("rejects %s while the exact lock exists", async status => {
    const job = createJob(status);
    mocks.getJob.mockResolvedValue(job);
    mocks.redis.exists.mockResolvedValue(1);
    const withFence = vi.fn(async (remove: () => Promise<boolean>) => remove());

    await expect(verifyAndCancelSubmissionJob({ workerTaskId, expected, withExactAttemptFence: withFence })).resolves.toBe(false);
    expect(withFence).not.toHaveBeenCalled();
    expect(job.remove).not.toHaveBeenCalled();
    expect(mocks.redis.del).not.toHaveBeenCalled();
  });

  it.each(["active", "waiting-children", "paused", "prioritized", "unknown"])("rejects nonterminal %s jobs", async status => {
    mocks.getJob.mockResolvedValue(createJob(status));
    const withFence = vi.fn(async (remove: () => Promise<boolean>) => remove());

    await expect(verifyAndCancelSubmissionJob({ workerTaskId, expected, withExactAttemptFence: withFence })).resolves.toBe(false);
    expect(withFence).not.toHaveBeenCalled();
  });

  it.each(["waiting", "delayed"])("removes a matching %s job inside the exact fence and rechecks absence", async status => {
    const job = createJob(status);
    mocks.getJob.mockResolvedValueOnce(job).mockResolvedValueOnce(job).mockResolvedValueOnce(undefined);
    let fenceHeld = false;
    const withFence = vi.fn(async (remove: () => Promise<boolean>) => {
      fenceHeld = true;
      try {
        return await remove();
      } finally {
        fenceHeld = false;
      }
    });
    job.remove.mockImplementation(async () => {
      expect(fenceHeld).toBe(true);
      return undefined;
    });

    await expect(verifyAndCancelSubmissionJob({ workerTaskId, expected, withExactAttemptFence: withFence })).resolves.toBe(true);
    expect(withFence).toHaveBeenCalledTimes(1);
    expect(job.remove).toHaveBeenCalledTimes(1);
    expect(mocks.getJob).toHaveBeenCalledTimes(3);
    expect(mocks.redis.exists).toHaveBeenCalledTimes(3);
    expect(mocks.redis.del).not.toHaveBeenCalled();
  });

  it("rejects pending jobs without the exact-fence callback or when the callback skips removal", async () => {
    mocks.getJob.mockResolvedValue(createJob("waiting"));
    await expect(verifyAndCancelSubmissionJob({ workerTaskId, expected })).resolves.toBe(false);
    await expect(verifyAndCancelSubmissionJob({
      workerTaskId,
      expected,
      withExactAttemptFence: async () => true,
    })).resolves.toBe(false);
  });

  it("fails closed when the pending job disappears before removal", async () => {
    const job = createJob("waiting");
    mocks.getJob.mockResolvedValueOnce(job).mockResolvedValueOnce(undefined);
    const withFence = vi.fn(async (remove: () => Promise<boolean>) => remove());

    await expect(verifyAndCancelSubmissionJob({ workerTaskId, expected, withExactAttemptFence: withFence })).resolves.toBe(false);
    expect(job.remove).not.toHaveBeenCalled();
  });

  it("rechecks the state and lock inside the caller's exact attempt fence", async () => {
    const job = createJob("waiting");
    job.getState.mockResolvedValueOnce("waiting").mockResolvedValueOnce("active");
    mocks.getJob.mockResolvedValue(job);
    const withFence = vi.fn(async (remove: () => Promise<boolean>) => remove());

    await expect(verifyAndCancelSubmissionJob({ workerTaskId, expected, withExactAttemptFence: withFence })).resolves.toBe(false);
    expect(job.getState).toHaveBeenCalledTimes(2);
    expect(job.remove).not.toHaveBeenCalled();
  });

  it("fails closed when removal errors or the follow-up finds the job or a lock", async () => {
    const removalErrorJob = createJob("waiting", { removeError: new Error("locked") });
    mocks.getJob.mockResolvedValue(removalErrorJob);
    await expect(verifyAndCancelSubmissionJob({
      workerTaskId,
      expected,
      withExactAttemptFence: async (remove: () => Promise<boolean>) => remove(),
    })).resolves.toBe(false);

    const removedJob = createJob("delayed");
    mocks.getJob.mockReset();
    mocks.getJob.mockResolvedValueOnce(removedJob).mockResolvedValueOnce(removedJob).mockResolvedValueOnce(removedJob);
    await expect(verifyAndCancelSubmissionJob({
      workerTaskId,
      expected,
      withExactAttemptFence: async (remove: () => Promise<boolean>) => remove(),
    })).resolves.toBe(false);

    const lockJob = createJob("waiting");
    mocks.getJob.mockReset();
    mocks.getJob.mockResolvedValueOnce(lockJob).mockResolvedValueOnce(lockJob).mockResolvedValueOnce(undefined);
    mocks.redis.exists.mockReset();
    mocks.redis.exists.mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    await expect(verifyAndCancelSubmissionJob({
      workerTaskId,
      expected,
      withExactAttemptFence: async (remove: () => Promise<boolean>) => remove(),
    })).resolves.toBe(false);
  });

  it("returns false on Redis and BullMQ query errors", async () => {
    mocks.getJob.mockRejectedValueOnce(new Error("redis unavailable"));
    await expect(verifyAndCancelSubmissionJob({ workerTaskId, expected })).resolves.toBe(false);

    mocks.getJob.mockResolvedValueOnce(createJob("completed"));
    mocks.redis.exists.mockRejectedValueOnce(new Error("redis unavailable"));
    await expect(verifyAndCancelSubmissionJob({ workerTaskId, expected })).resolves.toBe(false);

    const stateError = createJob("completed");
    stateError.getState.mockRejectedValueOnce(new Error("state query failed"));
    mocks.getJob.mockResolvedValueOnce(stateError);
    await expect(verifyAndCancelSubmissionJob({ workerTaskId, expected })).resolves.toBe(false);
  });

  it("preserves turn and session identity when enqueuing", async () => {
    await enqueueApplyTask({
      ...expected,
      operation: "submit",
      applyUrl: "https://employer.example/apply",
    });
    expect(mocks.add).toHaveBeenCalledWith(
      "apply",
      expect.objectContaining({ sessionId: expected.sessionId, fillTurnId: expected.fillTurnId }),
      expect.any(Object),
    );
  });
});
