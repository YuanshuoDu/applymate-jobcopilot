import { Queue } from "bullmq";
import { Redis } from "ioredis";

let _queue: Queue | null = null;

function getApplyQueue(): Queue {
  if (!_queue) {
    const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    _queue = new Queue("apply-tasks", { connection: redis });
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
