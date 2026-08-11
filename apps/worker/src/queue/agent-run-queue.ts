import { pinnedFetch } from "@jobcopilot/shared";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { workerPollingOptions } from "./worker-polling-options.js";

export const AGENT_RUN_QUEUE_NAME = "agent-runs";

export interface AgentRunTaskPayload {
  userId: string;
  sessionId: string;
}

const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

export const agentRunQueue = new Queue<AgentRunTaskPayload>(AGENT_RUN_QUEUE_NAME, { connection });

function internalRunUrl() {
  const base = process.env.AGENT_WEB_URL?.replace(/\/$/, "");
  return base ? `${base}/api/internal/agent-run` : null;
}

export const agentRunWorker = new Worker<AgentRunTaskPayload>(
  AGENT_RUN_QUEUE_NAME,
  async task => {
    const url = internalRunUrl();
    const secret = process.env.AGENT_WORKER_SECRET;
    if (!url) throw new Error("AGENT_WEB_URL is required for scheduled agent runs");
    if (!secret) throw new Error("AGENT_WORKER_SECRET is required for scheduled agent runs");

    const response = await pinnedFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-agent-worker-secret": secret,
      },
      body: JSON.stringify(task.data),
      signal: AbortSignal.timeout(Number(process.env.AGENT_RUN_TIMEOUT_MS ?? "300000")),
    });
    // Suspension and entitlement changes are terminal for this queued run.
    // Returning a skipped result prevents BullMQ from repeatedly retrying an
    // action that the current account state no longer permits.
    if (response.status === 403) {
      return { status: "skipped", reason: "authorization-revoked" };
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Agent run endpoint returned ${response.status}: ${body.slice(0, 300)}`);
    }

    const result = await response.json().catch(() => null) as { status?: string } | null;
    console.log(`[agent-run-worker] Session ${task.data.sessionId}: ${result?.status ?? "completed"}`);
    return result;
  },
  { connection, ...workerPollingOptions(), concurrency: 1 },
);

export async function closeAgentRunResources() {
  await agentRunWorker.close();
  await agentRunQueue.close();
  connection.disconnect();
}
