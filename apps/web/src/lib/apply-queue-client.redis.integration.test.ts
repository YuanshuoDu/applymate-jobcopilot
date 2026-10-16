import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import {
  closeApplyQueueClient,
  verifyAndCancelSubmissionJob,
  type ApplyQueueSubmissionIdentity,
  type EnqueueApplyInput,
} from "./apply-queue-client";

const RUN_REDIS_INTEGRATION = process.env.RUN_AGENT_TURN_REDIS_INTEGRATION === "1";

function dedicatedRedisUrl(): string | null {
  if (!RUN_REDIS_INTEGRATION) return null;
  if (process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true") {
    throw new Error("Apply queue Redis integration requires an explicitly disposable Redis service");
  }
  const value = process.env.AGENT_TURN_REDIS_TEST_URL;
  if (!value) throw new Error("AGENT_TURN_REDIS_TEST_URL is required when the Redis integration gate is enabled");
  const url = new URL(value);
  if (
    url.protocol !== "redis:"
    || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
    || url.port !== "6379"
    || url.pathname !== "/15"
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new Error("Apply queue Redis integration accepts only a disposable loopback Redis DB 15 URL");
  }
  return value;
}

const redisUrl = dedicatedRedisUrl();
const describeWithRedis = redisUrl ? describe : describe.skip;
type SubmitPayload = EnqueueApplyInput & {
  operation: "submit";
  sessionId: string;
  fillTurnId: string;
  receiptId: string;
  constraintHash: string;
};

function createAttempt(label: string): ApplyQueueSubmissionIdentity {
  return {
    applicationTaskId: `task-${label}`,
    userId: `user-${label}`,
    jobId: `employer-job-${label}`,
    sessionId: `session-${label}`,
    fillTurnId: `turn-${label}`,
    receiptId: `approval-${label}`,
    constraintHash: `hash-${label}`,
  };
}

function payloadFor(identity: ApplyQueueSubmissionIdentity): SubmitPayload {
  return { ...identity, operation: "submit", applyUrl: "https://employer.example/apply" };
}

async function waitForState<T extends object>(
  queue: Queue<T>,
  jobId: string,
  expected: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);
    if (job && await job.getState() === expected) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for apply queue job ${jobId} to become ${expected}`);
}

describeWithRedis("apply queue recovery checks (real Redis/BullMQ)", () => {
  let redis: Redis | undefined;
  let queueRedis: Redis | undefined;
  let workerRedis: Redis | undefined;
  let queue: Queue<SubmitPayload> | undefined;
  let worker: Worker<SubmitPayload> | undefined;
  let releaseActive: (() => void) | undefined;
  const jobIds: string[] = [];

  beforeAll(async () => {
    vi.stubEnv("REDIS_URL", redisUrl!);
    redis = new Redis(redisUrl!, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      connectTimeout: 2_000,
      retryStrategy: attempt => attempt > 3 ? null : 100,
    });
    await redis.connect();
    await redis.ping();
    queueRedis = redis.duplicate();
    queue = new Queue<SubmitPayload>("apply-tasks", { connection: queueRedis });
    await queue.waitUntilReady();
  }, 15_000);

  afterAll(async () => {
    releaseActive?.();
    await worker?.close().catch(() => undefined);
    for (const id of jobIds) {
      const job = await queue?.getJob(id).catch(() => undefined);
      if (!job) continue;
      const state = await job.getState().catch(() => "unknown");
      if (state !== "active") await job.remove().catch(() => undefined);
    }
    await closeApplyQueueClient().catch(() => undefined);
    await queue?.close().catch(() => undefined);
    await workerRedis?.quit().catch(() => undefined);
    if (redis && redis.status !== "end") await redis.quit().catch(() => redis?.disconnect());
    vi.unstubAllEnvs();
  });

  it("checks terminal jobs and locks, then removes waiting and delayed jobs under the fence", async () => {
    const unique = randomUUID();
    const completedId = `apply-recovery-${unique}-completed`;
    const failedId = `apply-recovery-${unique}-failed`;
    const activeId = `apply-recovery-${unique}-active`;
    jobIds.push(completedId, failedId, activeId);
    const completedIdentity = createAttempt(`${unique}-completed`);
    const failedIdentity = createAttempt(`${unique}-failed`);
    const activeIdentity = createAttempt(`${unique}-active`);
    await queue!.add("apply", payloadFor(completedIdentity), { jobId: completedId, removeOnComplete: false });
    await queue!.add("apply", payloadFor(failedIdentity), { jobId: failedId, attempts: 1, removeOnFail: false });
    await queue!.add("apply", payloadFor(activeIdentity), { jobId: activeId, removeOnComplete: false });

    let signalActive!: () => void;
    let markActive!: () => void;
    const activeStarted = new Promise<void>(resolve => { signalActive = resolve; });
    const keepActive = new Promise<void>(resolve => { markActive = resolve; });
    releaseActive = markActive;
    workerRedis = redis!.duplicate();
    worker = new Worker<SubmitPayload>("apply-tasks", async job => {
      if (job.id === failedId) throw new Error("fixture failure");
      if (job.id === activeId) {
        signalActive();
        await keepActive;
      }
      return "done";
    }, { connection: workerRedis, concurrency: 1 });
    await worker.waitUntilReady();

    await waitForState(queue!, completedId, "completed");
    await waitForState(queue!, failedId, "failed");
    await waitForState(queue!, activeId, "active");
    await activeStarted;
    await expect(verifyAndCancelSubmissionJob({ workerTaskId: completedId, expected: completedIdentity })).resolves.toBe(true);
    await expect(verifyAndCancelSubmissionJob({ workerTaskId: failedId, expected: failedIdentity })).resolves.toBe(true);
    await expect(verifyAndCancelSubmissionJob({
      workerTaskId: activeId,
      expected: activeIdentity,
      withExactAttemptFence: async remove => remove(),
    })).resolves.toBe(false);
    expect(await redis!.exists(`${queue!.toKey(activeId)}:lock`)).toBe(1);

    releaseActive();
    releaseActive = undefined;
    await waitForState(queue!, activeId, "completed");
    await worker.close();
    worker = undefined;

    for (const state of ["waiting", "delayed"] as const) {
      const id = `apply-recovery-${unique}-${state}`;
      jobIds.push(id);
      const identity = createAttempt(`${unique}-${state}`);
      await queue!.add("apply", payloadFor(identity), {
        jobId: id,
        ...(state === "delayed" ? { delay: 60_000 } : {}),
      });
      await waitForState(queue!, id, state);
      const eligible = await verifyAndCancelSubmissionJob({
        workerTaskId: id,
        expected: identity,
        withExactAttemptFence: async remove => remove(),
      });
      expect(eligible).toBe(true);
      expect(await queue!.getJob(id)).toBeUndefined();
      expect(await redis!.exists(`${queue!.toKey(id)}:lock`)).toBe(0);
    }
  }, 30_000);
});
