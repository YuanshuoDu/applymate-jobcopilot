import { Queue } from "bullmq";
import { Redis } from "ioredis";

export interface AgentRunTaskInput {
  userId: string;
  sessionId: string;
  /** Canonical TurnEngine dispatch; omitted for reversible legacy fallback. */
  turnId?: string;
  executionId?: string;
}

let queue: Queue<AgentRunTaskInput> | null = null;

function agentRunQueue() {
  if (!queue) {
    const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    queue = new Queue<AgentRunTaskInput>("agent-runs", { connection });
  }
  return queue;
}

export async function enqueueAgentRun(input: AgentRunTaskInput): Promise<string> {
  const job = await agentRunQueue().add("run", input, {
    attempts: 3,
    backoff: { type: "exponential", delay: 60_000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  });
  return job.id!;
}
