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
import { createCancelOperationId, removePendingSubmitJobWithReceipt } from "./apply-queue-removal";

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

type CancellationIdentity = ApplyQueueSubmissionIdentity & { workerTaskId: string };

function cancellationIdentity(identity: ApplyQueueSubmissionIdentity, workerTaskId: string): CancellationIdentity {
  return { ...identity, workerTaskId };
}

function submissionIdentityFor({ workerTaskId, ...submissionIdentity }: CancellationIdentity): ApplyQueueSubmissionIdentity {
  if (!workerTaskId) throw new Error("Cancellation identity must include the worker task ID");
  return submissionIdentity;
}

async function removedEventsFor(queue: Queue<SubmitPayload>, redis: Redis, workerTaskId: string) {
  const entries = await redis.xrange(queue.toKey("events"), "-", "+");
  return entries.flatMap(([, rawFields]) => {
    const fields: Record<string, string> = {};
    for (let index = 0; index < rawFields.length; index += 2) {
      fields[rawFields[index]] = rawFields[index + 1] ?? "";
    }
    return fields.event === "removed" && fields.jobId === workerTaskId ? [fields] : [];
  });
}

async function expectRemovalReceipt(
  queue: Queue<SubmitPayload>,
  redis: Redis,
  identity: CancellationIdentity,
  previousState: "wait" | "paused" | "delayed",
): Promise<void> {
  const operationId = createCancelOperationId(identity);
  const receiptKey = queue.toKey(`cancel-receipt:${operationId}`);
  const receipt = await redis.get(receiptKey);
  expect(receipt).not.toBeNull();
  expect(JSON.parse(receipt!)).toEqual({
    operationName: "apply-submit-cancel",
    version: 1,
    cancelOperationId: operationId,
    ...identity,
  });
  expect(await redis.ttl(receiptKey)).toBe(-1);
  expect(await removedEventsFor(queue, redis, identity.workerTaskId)).toEqual([
    expect.objectContaining({ event: "removed", jobId: identity.workerTaskId, prev: previousState }),
  ]);
}

async function expectRejectedPendingRemoval(
  queue: Queue<SubmitPayload>,
  redis: Redis,
  identity: CancellationIdentity,
  injectConflict: (jobKey: string) => Promise<unknown>,
  verifyConflict: (jobKey: string) => Promise<void>,
  clearConflict: (jobKey: string) => Promise<unknown>,
): Promise<void> {
  const jobKey = queue.toKey(identity.workerTaskId);
  await injectConflict(jobKey);
  try {
    expect(await removePendingSubmitJobWithReceipt(redis, key => queue.toKey(key), identity)).toBe(false);
    expect(await redis.hget(jobKey, "data")).toBe(JSON.stringify(payloadFor(submissionIdentityFor(identity))));
    expect(await redis.lpos(queue.toKey("wait"), identity.workerTaskId)).not.toBeNull();
    expect(await redis.exists(queue.toKey(`cancel-receipt:${createCancelOperationId(identity)}`))).toBe(0);
    expect(await removedEventsFor(queue, redis, identity.workerTaskId)).toHaveLength(0);
    await verifyConflict(jobKey);
  } finally {
    await clearConflict(jobKey);
  }
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
    await expect(removePendingSubmitJobWithReceipt(
      redis!, key => queue!.toKey(key), cancellationIdentity(completedIdentity, completedId),
    )).resolves.toBe(false);
    await expect(verifyAndCancelSubmissionJob({
      workerTaskId: activeId,
      expected: activeIdentity,
      withExactAttemptFence: async remove => remove(),
    })).resolves.toBe(false);
    await expect(removePendingSubmitJobWithReceipt(
      redis!, key => queue!.toKey(key), cancellationIdentity(activeIdentity, activeId),
    )).resolves.toBe(false);
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
      const cancelIdentity = cancellationIdentity(identity, id);
      await queue!.add("apply", payloadFor(identity), {
        jobId: id,
        ...(state === "delayed" ? { delay: 60_000 } : {}),
      });
      await waitForState(queue!, id, state);

      // Concurrent exact retries must share one atomic removal receipt and stream event.
      const results = await Promise.all([
        removePendingSubmitJobWithReceipt(redis!, key => queue!.toKey(key), cancelIdentity),
        removePendingSubmitJobWithReceipt(redis!, key => queue!.toKey(key), cancelIdentity),
      ]);
      expect(results).toEqual([true, true]);
      expect(await queue!.getJob(id)).toBeUndefined();
      expect(await redis!.exists(`${queue!.toKey(id)}:lock`)).toBe(0);
      await expectRemovalReceipt(queue!, redis!, cancelIdentity, state === "waiting" ? "wait" : "delayed");
    }
  }, 30_000);

  it("removes an exact pending job from the globally paused list", async () => {
    const unique = randomUUID();
    const workerTaskId = `apply-cancel-${unique}-paused`;
    jobIds.push(workerTaskId);
    const identity = createAttempt(`${unique}-paused`);
    const cancelIdentity = cancellationIdentity(identity, workerTaskId);
    const pausedKey = queue!.toKey("paused");
    const waitingKey = queue!.toKey("wait");

    try {
      await queue!.pause();
      await queue!.add("apply", payloadFor(identity), { jobId: workerTaskId });

      expect(await redis!.lpos(pausedKey, workerTaskId)).not.toBeNull();
      expect(await redis!.lpos(waitingKey, workerTaskId)).toBeNull();
      await expect(removePendingSubmitJobWithReceipt(
        redis!, key => queue!.toKey(key), cancelIdentity,
      )).resolves.toBe(true);
      expect(await redis!.lpos(pausedKey, workerTaskId)).toBeNull();
      expect(await queue!.getJob(workerTaskId)).toBeUndefined();
      await expectRemovalReceipt(queue!, redis!, cancelIdentity, "paused");
    } finally {
      await queue!.resume();
    }
  }, 15_000);

  it("does not remove a job that appears after the initial missing-job lookup", async () => {
    const unique = randomUUID();
    const workerTaskId = `apply-cancel-${unique}-appeared`;
    jobIds.push(workerTaskId);
    const identity = createAttempt(`${unique}-appeared`);
    const cancelIdentity = cancellationIdentity(identity, workerTaskId);
    const receiptKey = queue!.toKey(`cancel-receipt:${createCancelOperationId(cancelIdentity)}`);
    expect(await queue!.getJob(workerTaskId)).toBeUndefined();
    let fenceCalls = 0;
    const getJobSpy = vi.spyOn(Queue.prototype, "getJob").mockImplementationOnce(async requestedId => {
      expect(requestedId).toBe(workerTaskId);
      await queue!.add("apply", payloadFor(identity), { jobId: workerTaskId });
      return undefined;
    });

    let recovered = true;
    try {
      recovered = await verifyAndCancelSubmissionJob({
        workerTaskId,
        expected: identity,
        withExactAttemptFence: async checkReceipt => {
          fenceCalls += 1;
          return checkReceipt();
        },
      });
      expect(getJobSpy).toHaveBeenCalledOnce();
      expect(getJobSpy).toHaveBeenCalledWith(workerTaskId);
    } finally {
      getJobSpy.mockRestore();
    }

    expect(recovered).toBe(false);
    expect(fenceCalls).toBe(1);
    const appearedJob = await queue!.getJob(workerTaskId);
    expect(appearedJob).toBeDefined();
    expect(await appearedJob!.getState()).toBe("waiting");
    expect(await redis!.exists(receiptKey)).toBe(0);
    expect(await removedEventsFor(queue!, redis!, workerTaskId)).toHaveLength(0);
  }, 15_000);

  it("fails closed on absent jobs, mismatched identities, and locks, then replays an exact receipt after fence rollback", async () => {
    const unique = randomUUID();
    const absentId = `apply-cancel-${unique}-absent`;
    const mismatchId = `apply-cancel-${unique}-mismatch`;
    const lockedId = `apply-cancel-${unique}-locked`;
    const retryId = `apply-cancel-${unique}-retry`;
    jobIds.push(mismatchId, lockedId, retryId);

    const absentIdentity = cancellationIdentity(createAttempt(`${unique}-absent`), absentId);
    expect(await removePendingSubmitJobWithReceipt(
      redis!, key => queue!.toKey(key), absentIdentity,
    )).toBe(false);
    await expect(verifyAndCancelSubmissionJob({
      workerTaskId: absentId,
      expected: absentIdentity,
      withExactAttemptFence: async remove => remove(),
    })).resolves.toBe(false);

    const mismatchIdentity = cancellationIdentity(createAttempt(`${unique}-mismatch`), mismatchId);
    await queue!.add("apply", payloadFor(mismatchIdentity), { jobId: mismatchId });
    await waitForState(queue!, mismatchId, "waiting");
    const wrongIdentity = { ...mismatchIdentity, receiptId: `different-${unique}` };
    expect(await removePendingSubmitJobWithReceipt(
      redis!, key => queue!.toKey(key), wrongIdentity,
    )).toBe(false);
    expect(await queue!.getJob(mismatchId)).toBeDefined();
    expect(await removedEventsFor(queue!, redis!, mismatchId)).toHaveLength(0);

    const lockedIdentity = cancellationIdentity(createAttempt(`${unique}-locked`), lockedId);
    await queue!.add("apply", payloadFor(lockedIdentity), { jobId: lockedId });
    await waitForState(queue!, lockedId, "waiting");
    const lockKey = `${queue!.toKey(lockedId)}:lock`;
    await redis!.set(lockKey, "fixture-lock", "EX", 60);
    try {
      expect(await removePendingSubmitJobWithReceipt(
        redis!, key => queue!.toKey(key), lockedIdentity,
      )).toBe(false);
      expect(await queue!.getJob(lockedId)).toBeDefined();
      expect(await redis!.exists(lockKey)).toBe(1);
      expect(await removedEventsFor(queue!, redis!, lockedId)).toHaveLength(0);
    } finally {
      await redis!.del(lockKey);
    }

    const retryBaseIdentity = createAttempt(`${unique}-retry`);
    const retryIdentity = cancellationIdentity(retryBaseIdentity, retryId);
    await queue!.add("apply", payloadFor(retryBaseIdentity), { jobId: retryId });
    await waitForState(queue!, retryId, "waiting");
    let fenceCalls = 0;
    const simulateDatabaseFence = async (remove: () => Promise<boolean>) => {
      fenceCalls += 1;
      const removed = await remove();
      expect(removed).toBe(true);
      // The first callback models a transaction that rolls back after Redis removal.
      return fenceCalls > 1;
    };

    await expect(verifyAndCancelSubmissionJob({
      workerTaskId: retryId,
      expected: retryBaseIdentity,
      withExactAttemptFence: simulateDatabaseFence,
    })).resolves.toBe(false);
    expect(await queue!.getJob(retryId)).toBeUndefined();
    const receiptKey = queue!.toKey(`cancel-receipt:${createCancelOperationId(retryIdentity)}`);
    const receiptAfterRollback = await redis!.get(receiptKey);
    expect(receiptAfterRollback).not.toBeNull();

    await expect(verifyAndCancelSubmissionJob({
      workerTaskId: retryId,
      expected: retryBaseIdentity,
      withExactAttemptFence: simulateDatabaseFence,
    })).resolves.toBe(true);
    expect(fenceCalls).toBe(2);
    expect(await redis!.get(receiptKey)).toBe(receiptAfterRollback);
    await expectRemovalReceipt(queue!, redis!, retryIdentity, "wait");

    const changedIdentity = { ...retryBaseIdentity, receiptId: `different-${unique}` };
    const changedOperationId = createCancelOperationId(cancellationIdentity(changedIdentity, retryId));
    const changedReceiptKey = queue!.toKey(`cancel-receipt:${changedOperationId}`);
    let changedIdentityFenceCalls = 0;
    await expect(verifyAndCancelSubmissionJob({
      workerTaskId: retryId,
      expected: changedIdentity,
      withExactAttemptFence: async checkReceipt => {
        changedIdentityFenceCalls += 1;
        return checkReceipt();
      },
    })).resolves.toBe(false);
    expect(changedIdentityFenceCalls).toBe(1);
    expect(await queue!.getJob(retryId)).toBeUndefined();
    expect(await redis!.get(receiptKey)).toBe(receiptAfterRollback);
    expect(await redis!.exists(changedReceiptKey)).toBe(0);
    expect(await removedEventsFor(queue!, redis!, retryId)).toHaveLength(1);

    const jobKey = queue!.toKey(retryId);
    const receiptBeforeConflicts = await redis!.get(receiptKey);
    await redis!.hset(jobKey, "data", JSON.stringify(payloadFor(retryBaseIdentity)));
    try {
      expect(await removePendingSubmitJobWithReceipt(redis!, key => queue!.toKey(key), retryIdentity)).toBe(false);
      expect(await redis!.hget(jobKey, "data")).toBe(JSON.stringify(payloadFor(retryBaseIdentity)));
      expect(await redis!.get(receiptKey)).toBe(receiptBeforeConflicts);
      expect(await removedEventsFor(queue!, redis!, retryId)).toHaveLength(1);
    } finally {
      await redis!.del(jobKey);
    }

    const reappearedLockKey = `${jobKey}:lock`;
    await redis!.set(reappearedLockKey, "reappeared-lock", "EX", 60);
    try {
      expect(await removePendingSubmitJobWithReceipt(redis!, key => queue!.toKey(key), retryIdentity)).toBe(false);
      expect(await redis!.get(reappearedLockKey)).toBe("reappeared-lock");
      expect(await redis!.get(receiptKey)).toBe(receiptBeforeConflicts);
      expect(await removedEventsFor(queue!, redis!, retryId)).toHaveLength(1);
    } finally {
      await redis!.del(reappearedLockKey);
    }
  }, 30_000);

  it("leaves malformed jobs and unsupported or ambiguous Redis shapes untouched", async () => {
    const unique = randomUUID();
    const malformedId = `apply-cancel-${unique}-malformed`;
    const ambiguousId = `apply-cancel-${unique}-ambiguous`;
    const wrongWaitTypeId = `apply-cancel-${unique}-wrong-wait-type`;
    jobIds.push(malformedId, ambiguousId, wrongWaitTypeId);

    const malformedBase = createAttempt(`${unique}-malformed`);
    const malformedIdentity = cancellationIdentity(malformedBase, malformedId);
    await queue!.add("apply", payloadFor(malformedBase), { jobId: malformedId });
    await waitForState(queue!, malformedId, "waiting");
    const malformedJobKey = queue!.toKey(malformedId);
    const validData = await redis!.hget(malformedJobKey, "data");
    const malformedData = "{invalid-job-data";
    await redis!.hset(malformedJobKey, "data", malformedData);
    try {
      expect(await removePendingSubmitJobWithReceipt(redis!, key => queue!.toKey(key), malformedIdentity)).toBe(false);
      expect(await redis!.hget(malformedJobKey, "data")).toBe(malformedData);
      expect(await redis!.lpos(queue!.toKey("wait"), malformedId)).not.toBeNull();
      expect(await redis!.exists(queue!.toKey(`cancel-receipt:${createCancelOperationId(malformedIdentity)}`))).toBe(0);
      expect(await removedEventsFor(queue!, redis!, malformedId)).toHaveLength(0);
    } finally {
      if (validData !== null) await redis!.hset(malformedJobKey, "data", validData);
    }

    const scalarMetadata = [
      ["parentKey", "bull:parent:job"],
      ["parent", "parent"],
      ["deid", "deduplication-key"],
      ["rjk", "repeat-key"],
      ["repeatJobKey", "legacy-repeat-key"],
    ] as const;
    for (const [field, value] of scalarMetadata) {
      const id = `apply-cancel-${unique}-${field}`;
      jobIds.push(id);
      const baseIdentity = createAttempt(`${unique}-${field}`);
      const identity = cancellationIdentity(baseIdentity, id);
      await queue!.add("apply", payloadFor(baseIdentity), { jobId: id });
      await waitForState(queue!, id, "waiting");
      await expectRejectedPendingRemoval(
        queue!, redis!, identity,
        jobKey => redis!.hset(jobKey, field, value),
        async jobKey => { expect(await redis!.hget(jobKey, field)).toBe(value); },
        jobKey => redis!.hdel(jobKey, field),
      );
    }

    const sidecars = [
      {
        suffix: "dependencies",
        set: async (key: string) => redis!.sadd(key, "bull:parent:child"),
        assert: async (key: string) => expect(await redis!.sismember(key, "bull:parent:child")).toBe(1),
      },
      {
        suffix: "processed",
        set: async (key: string) => redis!.hset(key, "bull:parent:child", "{}"),
        assert: async (key: string) => expect(await redis!.hget(key, "bull:parent:child")).toBe("{}"),
      },
      {
        suffix: "failed",
        set: async (key: string) => redis!.hset(key, "bull:parent:child", "failed"),
        assert: async (key: string) => expect(await redis!.hget(key, "bull:parent:child")).toBe("failed"),
      },
      {
        suffix: "unsuccessful",
        set: async (key: string) => redis!.zadd(key, "1", "bull:parent:child"),
        assert: async (key: string) => expect(await redis!.zscore(key, "bull:parent:child")).toBe("1"),
      },
      {
        suffix: "logs",
        set: async (key: string) => redis!.set(key, "wrong-sidecar-type"),
        assert: async (key: string) => {
          expect(await redis!.type(key)).toBe("string");
          expect(await redis!.get(key)).toBe("wrong-sidecar-type");
        },
      },
    ];
    for (const sidecar of sidecars) {
      const id = `apply-cancel-${unique}-${sidecar.suffix}`;
      jobIds.push(id);
      const baseIdentity = createAttempt(`${unique}-${sidecar.suffix}`);
      const identity = cancellationIdentity(baseIdentity, id);
      await queue!.add("apply", payloadFor(baseIdentity), { jobId: id });
      await waitForState(queue!, id, "waiting");
      await expectRejectedPendingRemoval(
        queue!, redis!, identity,
        jobKey => sidecar.set(`${jobKey}:${sidecar.suffix}`),
        jobKey => sidecar.assert(`${jobKey}:${sidecar.suffix}`),
        jobKey => redis!.del(`${jobKey}:${sidecar.suffix}`),
      );
    }

    const ambiguousBase = createAttempt(`${unique}-ambiguous`);
    const ambiguousIdentity = cancellationIdentity(ambiguousBase, ambiguousId);
    await queue!.add("apply", payloadFor(ambiguousBase), { jobId: ambiguousId });
    await waitForState(queue!, ambiguousId, "waiting");
    const delayedKey = queue!.toKey("delayed");
    await redis!.zadd(delayedKey, "1", ambiguousId);
    try {
      expect(await removePendingSubmitJobWithReceipt(redis!, key => queue!.toKey(key), ambiguousIdentity)).toBe(false);
      expect(await redis!.hget(queue!.toKey(ambiguousId), "data")).toBe(JSON.stringify(payloadFor(ambiguousBase)));
      expect(await redis!.lpos(queue!.toKey("wait"), ambiguousId)).not.toBeNull();
      expect(await redis!.zscore(delayedKey, ambiguousId)).toBe("1");
      expect(await redis!.exists(queue!.toKey(`cancel-receipt:${createCancelOperationId(ambiguousIdentity)}`))).toBe(0);
      expect(await removedEventsFor(queue!, redis!, ambiguousId)).toHaveLength(0);
    } finally {
      await redis!.zrem(delayedKey, ambiguousId);
    }

    const wrongWaitBase = createAttempt(`${unique}-wrong-wait-type`);
    const wrongWaitIdentity = cancellationIdentity(wrongWaitBase, wrongWaitTypeId);
    await queue!.add("apply", payloadFor(wrongWaitBase), { jobId: wrongWaitTypeId });
    await waitForState(queue!, wrongWaitTypeId, "waiting");
    const waitKey = queue!.toKey("wait");
    const waitingJobs = await redis!.lrange(waitKey, 0, -1);
    await redis!.del(waitKey);
    await redis!.set(waitKey, "wrong-queue-key-type");
    try {
      expect(await removePendingSubmitJobWithReceipt(redis!, key => queue!.toKey(key), wrongWaitIdentity)).toBe(false);
      expect(await redis!.get(waitKey)).toBe("wrong-queue-key-type");
      expect(await redis!.hget(queue!.toKey(wrongWaitTypeId), "data")).toBe(JSON.stringify(payloadFor(wrongWaitBase)));
      expect(await redis!.exists(queue!.toKey(`cancel-receipt:${createCancelOperationId(wrongWaitIdentity)}`))).toBe(0);
      expect(await removedEventsFor(queue!, redis!, wrongWaitTypeId)).toHaveLength(0);
    } finally {
      await redis!.del(waitKey);
      if (waitingJobs.length) await redis!.rpush(waitKey, ...waitingJobs);
    }
    expect(await redis!.lrange(waitKey, 0, -1)).toEqual(waitingJobs);
  }, 30_000);
});
