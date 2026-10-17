import { Queue, type Job } from "bullmq";
import { Redis } from "ioredis";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { matchesApplyTaskSubmitPayload, type ApplyTaskSubmitPayload } from "@jobcopilot/shared";
import { asRecord, AutoApplyError } from "./auto-apply-guards";

type ApplyQueuePayload = EnqueueApplyInput;

export function createSubmitIntent(submitPayload: ApplyTaskSubmitPayload) {
  const digest = createHash("sha256").update(JSON.stringify([
    submitPayload.applicationTaskId, submitPayload.fillTurnId, submitPayload.receiptId,
  ]) ?? "").digest("hex");
  const workerTaskId = "apply-submit-" + digest;
  return {
    id: "application-submit-outbox-" + digest,
    topic: "application.submit.dispatch",
    aggregateId: submitPayload.sessionId,
    idempotencyKey: "application-submit:" + digest,
    payload: {
      applicationTaskId: submitPayload.applicationTaskId, userId: submitPayload.userId,
      jobId: submitPayload.jobId, sessionId: submitPayload.sessionId, fillTurnId: submitPayload.fillTurnId,
      receiptId: submitPayload.receiptId, constraintHash: submitPayload.constraintHash, workerTaskId, submitPayload,
    },
  };
}

type SubmitIntent = ReturnType<typeof createSubmitIntent>;

function matchesSubmitIntent(value: unknown, expected: SubmitIntent): boolean {
  const row = asRecord(value), payload = asRecord(row.payload), identity = expected.payload;
  return row.id === expected.id && row.topic === expected.topic && row.aggregateId === expected.aggregateId &&
    row.idempotencyKey === expected.idempotencyKey && payload.applicationTaskId === identity.applicationTaskId &&
    payload.userId === identity.userId && payload.jobId === identity.jobId && payload.sessionId === identity.sessionId &&
    payload.fillTurnId === identity.fillTurnId && payload.receiptId === identity.receiptId &&
    payload.constraintHash === identity.constraintHash && payload.workerTaskId === identity.workerTaskId &&
    matchesApplyTaskSubmitPayload(payload.submitPayload, identity);
}

function matchesSubmitEvent(value: unknown, expected: SubmitIntent): boolean {
  const event = asRecord(value), identity = expected.payload;
  return event.applicationTaskId === identity.applicationTaskId && event.userId === identity.userId &&
    event.jobId === identity.jobId && event.sessionId === identity.sessionId && event.fillTurnId === identity.fillTurnId &&
    event.approvalId === identity.receiptId && event.receiptId === identity.receiptId &&
    event.constraintHash === identity.constraintHash && event.workerTaskId === identity.workerTaskId;
}

export async function resolveExistingSubmitIntent(tx: Prisma.TransactionClient, intent: SubmitIntent): Promise<string> {
  const [outbox, events] = await Promise.all([
    tx.agentOutbox.findUnique({ where: { idempotencyKey: intent.idempotencyKey } }),
    tx.applicationTaskEvent.findMany({ where: { taskId: intent.payload.applicationTaskId, type: "submission_queued" }, select: { data: true } }),
  ]);
  if (!matchesSubmitIntent(outbox, intent) || !events.some(event => matchesSubmitEvent(event.data, intent))) {
    throw new AutoApplyError("The existing submit intent conflicts with the current approved attempt.");
  }
  return intent.payload.workerTaskId;
}

export function isReplayableSubmitState(status: string, checkpoint: string | null): boolean {
  return (status === "filling" && ["submission_authorized", "browser_active", "submission_request_started"].includes(checkpoint ?? "")) ||
    (status === "submitted" && checkpoint === "submission_verified") ||
    (status === "failed" && ["execution_failed", "submission_blocked", "worker_failed"].includes(checkpoint ?? ""));
}

let _queue: Queue<ApplyQueuePayload> | null = null;
let _redis: Redis | null = null;

function getApplyQueue(): Queue<ApplyQueuePayload> {
  if (!_queue) {
    const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    _redis = redis;
    _queue = new Queue<ApplyQueuePayload>("apply-tasks", { connection: redis });
  }
  return _queue;
}

export interface EnqueueApplyInput {
  applicationTaskId: string;
  operation: "fill" | "submit";
  jobId: string;
  userId: string;
  applyUrl: string;
  /** The worker loads the canonical persona from Postgres. Kept for callers
   * that already provide a persona identifier. */
  personaId?: string;
  /** The worker generates an ephemeral PDF from the selected resume. */
  resumePath?: string;
  dryRun?: boolean;
  receiptId?: string;
  constraintHash?: string;
  sessionId?: string;
  fillTurnId?: string;
}

/** Immutable identity copied from the append-only submission_queued event. */
export interface ApplyQueueSubmissionIdentity {
  applicationTaskId: string;
  userId: string;
  jobId: string;
  sessionId: string;
  fillTurnId: string;
  receiptId: string;
  constraintHash: string;
}

export interface VerifySubmissionJobInput {
  /** Exact BullMQ job ID resolved from submission_queued for the old Turn and approval. */
  workerTaskId: string | null | undefined;
  expected: ApplyQueueSubmissionIdentity | null | undefined;
  /** Set only after the transaction found exact Worker terminal evidence for this attempt. */
  allowMissingTerminalProof?: boolean;
  /** The caller runs removePendingJob inside the exact database attempt fence. */
  withExactAttemptFence?: (removePendingJob: () => Promise<boolean>) => Promise<boolean>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasExpectedIdentity(data: unknown, expected: ApplyQueueSubmissionIdentity): boolean {
  if (typeof data !== "object" || data === null) return false;
  const payload = data as Record<string, unknown>;
  return payload.operation === "submit"
    && payload.applicationTaskId === expected.applicationTaskId
    && payload.userId === expected.userId
    && payload.jobId === expected.jobId
    && payload.sessionId === expected.sessionId
    && payload.fillTurnId === expected.fillTurnId
    && payload.receiptId === expected.receiptId
    && payload.constraintHash === expected.constraintHash;
}

export function hasExactTerminalSubmitProof(events: readonly unknown[], expected: ApplyQueueSubmissionIdentity & { workerTaskId: string }): boolean {
  if (events.length !== 1) return false;
  const proof = asRecord(events[0]), attemptsMade = proof.attemptsMade, attempts = proof.attempts;
  return proof.applicationTaskId === expected.applicationTaskId && proof.userId === expected.userId
    && proof.jobId === expected.jobId && proof.sessionId === expected.sessionId && proof.fillTurnId === expected.fillTurnId
    && proof.workerTaskId === expected.workerTaskId && proof.approvalId === expected.receiptId && proof.receiptId === expected.receiptId
    && proof.constraintHash === expected.constraintHash && (proof.terminalState === "completed" || proof.terminalState === "failed")
    && Number.isSafeInteger(attemptsMade) && Number(attemptsMade) >= 0 && Number.isSafeInteger(attempts) && Number(attempts) >= 1
    && (proof.terminalState !== "failed" || Number(attemptsMade) >= Number(attempts));
}

export async function readExactTerminalSubmitProof(
  tx: Prisma.TransactionClient,
  expected: ApplyQueueSubmissionIdentity & { workerTaskId: string },
): Promise<"missing" | "valid" | "mismatch"> {
  const events = await tx.$queryRaw<Array<{ data: unknown }>>(Prisma.sql`SELECT "data" FROM "application_task_events"
    WHERE "taskId" = ${expected.applicationTaskId} AND "type" = 'submission_terminal_observed' AND "actor" = 'worker'
      AND "data"->>'fillTurnId' = ${expected.fillTurnId} FOR SHARE`);
  if (!events.length) return "missing";
  return hasExactTerminalSubmitProof(events.map(event => event.data), expected) ? "valid" : "mismatch";
}

function isValidIdentity(expected: ApplyQueueSubmissionIdentity | null | undefined): expected is ApplyQueueSubmissionIdentity {
  return expected !== null && expected !== undefined
    && isNonEmptyString(expected.applicationTaskId)
    && isNonEmptyString(expected.userId)
    && isNonEmptyString(expected.jobId)
    && isNonEmptyString(expected.sessionId)
    && isNonEmptyString(expected.fillTurnId)
    && isNonEmptyString(expected.receiptId)
    && isNonEmptyString(expected.constraintHash);
}

async function getMatchingSubmissionJob(
  queue: Queue<ApplyQueuePayload>,
  workerTaskId: string,
  expected: ApplyQueueSubmissionIdentity,
): Promise<Job<ApplyQueuePayload> | undefined> {
  const job = await queue.getJob(workerTaskId);
  if (!job || job.id !== workerTaskId || !hasExpectedIdentity(job.data, expected)) return undefined;
  return job;
}

async function hasNoExactLock(queue: Queue<ApplyQueuePayload>, workerTaskId: string): Promise<boolean> {
  if (!_redis) throw new Error("Apply queue Redis connection is unavailable");
  return await _redis.exists(`${queue.toKey(workerTaskId)}:lock`) === 0;
}

/** Verifies a terminal submit job or removes a pending one under its exact DB fence. */
export async function verifyAndCancelSubmissionJob(input: VerifySubmissionJobInput): Promise<boolean> {
  const workerTaskId = input.workerTaskId;
  const expected = input.expected;
  if (!isNonEmptyString(workerTaskId) || !isValidIdentity(expected)) return false;

  try {
    const queue = getApplyQueue();
    const found = await queue.getJob(workerTaskId);
    if (!found) return input.allowMissingTerminalProof === true && await hasNoExactLock(queue, workerTaskId);
    if (found.id !== workerTaskId || !hasExpectedIdentity(found.data, expected)) return false;
    const job = found;
    const state = await job.getState();
    if (!await hasNoExactLock(queue, workerTaskId)) return false;
    if (state === "completed") return true;
    if (state === "failed" && job.attemptsMade >= (job.opts.attempts ?? 1)) return true;
    if ((state !== "waiting" && state !== "delayed") || !input.withExactAttemptFence) return false;

    let removalInvoked = false;
    let removalSucceeded = false;
    const fencedResult = await input.withExactAttemptFence(async () => {
      if (removalInvoked) return false;
      removalInvoked = true;
      const current = await getMatchingSubmissionJob(queue, workerTaskId, expected);
      if (!current) return false;
      const currentState = await current.getState();
      if (currentState !== "waiting" && currentState !== "delayed") return false;
      if (!await hasNoExactLock(queue, workerTaskId)) return false;
      await current.remove();
      removalSucceeded = true;
      return true;
    });
    if (!fencedResult || !removalSucceeded) return false;

    const remaining = await queue.getJob(workerTaskId);
    return (remaining === undefined || remaining === null)
      && await hasNoExactLock(queue, workerTaskId);
  } catch {
    return false;
  }
}

export async function enqueueApplyTask(input: EnqueueApplyInput): Promise<string> {
  const job = await getApplyQueue().add("apply", {
    ...input,
    personaId: input.personaId ?? "server-side",
    resumePath: input.resumePath ?? "",
  }, {
    attempts: 3,
    backoff: { type: "exponential", delay: 60_000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  });
  return job.id!;
}

export async function closeApplyQueueClient(): Promise<void> {
  const queue = _queue;
  _queue = null;
  _redis = null;
  if (queue) await queue.close();
}
