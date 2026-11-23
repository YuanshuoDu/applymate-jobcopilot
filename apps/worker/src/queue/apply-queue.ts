import { Queue, Worker } from "bullmq";
import { type ApplyTaskPayload } from "@jobcopilot/shared";
import { getPool } from "../db/apply-results.js";
import { redisConnection } from "../redis.js";
import { reconcileTerminalSubmitJob } from "./application-submit-outbox-terminal-recovery.js";
import { workerPollingOptions } from "./worker-polling-options.js";
import { createApplyJobProcessor, type StagedApplicationSubmissionStopProtocol } from "./apply-job-runner.js";

export const connection = redisConnection;
export const QUEUE_NAME = "apply-tasks";
export const applyQueue = new Queue<ApplyTaskPayload>(QUEUE_NAME, {
  connection,
  skipVersionCheck: true,
});

export function createApplyWorker(options: { stagedSubmissionStopProtocol?: StagedApplicationSubmissionStopProtocol } = {}) {
  const worker = new Worker<ApplyTaskPayload>(
    QUEUE_NAME,
    createApplyJobProcessor({
      isQueuePaused: () => applyQueue.isPaused(),
      ...(options.stagedSubmissionStopProtocol ? { stagedSubmissionStopProtocol: options.stagedSubmissionStopProtocol } : {}),
    }),
    {
    connection,
    autorun: false,
    skipVersionCheck: true,
    ...workerPollingOptions(),
    concurrency: Number(process.env.CLOAK_MAX_WORKERS ?? "1"),
    },
  );

  worker.on("completed", async (job) => {
    try { await reconcileTerminalSubmitJob(getPool(), applyQueue, job, "completed"); }
    catch (error: unknown) {
      console.warn("[apply-worker] Terminal submit recovery failed:", error instanceof Error ? error.message : String(error));
    }
  });
  worker.on("failed", async (job) => {
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    try { await reconcileTerminalSubmitJob(getPool(), applyQueue, job, "failed"); }
    catch (error: unknown) {
      console.warn("[apply-worker] Terminal submit recovery failed:", error instanceof Error ? error.message : String(error));
    }
  });
  return worker;
}

export const applyWorker = createApplyWorker();
