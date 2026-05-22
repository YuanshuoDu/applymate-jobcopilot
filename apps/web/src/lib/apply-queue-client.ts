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
  jobId: string;
  userId: string;
  applyUrl: string;
  personaId: string;
  resumePath: string;
  dryRun?: boolean;
}

export async function enqueueApplyTask(input: EnqueueApplyInput): Promise<string> {
  const job = await getApplyQueue().add("apply", input, {
    attempts: 3,
    backoff: { type: "exponential", delay: 60_000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  });
  return job.id!;
}
