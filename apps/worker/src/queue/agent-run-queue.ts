import { pinnedFetch } from "@jobcopilot/shared";
import { Queue, Worker } from "bullmq";
import { workerPollingOptions } from "./worker-polling-options.js";
import { redisConnection } from "../redis.js";
import { getPool } from "../db/apply-results.js";
import { recordWorkerExternalApiUsage } from "../api-usage/external-api-usage.js";

export const AGENT_RUN_QUEUE_NAME = "agent-runs";

export interface AgentRunTaskPayload {
  userId: string;
  sessionId: string;
}

const connection = redisConnection;

export const agentRunQueue = new Queue<AgentRunTaskPayload>(AGENT_RUN_QUEUE_NAME, { connection, skipVersionCheck: true });

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

    const startedAt = Date.now();
    const requestBody = JSON.stringify(task.data);
    let response: Response;
    try {
      response = await pinnedFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-agent-worker-secret": secret,
        },
        body: requestBody,
        signal: AbortSignal.timeout(Number(process.env.AGENT_RUN_TIMEOUT_MS ?? "300000")),
      });
      if (process.env.NODE_ENV !== "test") await recordWorkerExternalApiUsage({ pool: getPool(), userId: task.data.userId, provider: "internal-worker", operation: "agent_run", status: response.ok ? "success" : "error", httpStatus: response.status, errorCode: response.ok ? undefined : response.status === 429 ? "http_429" : response.status >= 500 ? "http_5xx" : "http_4xx", latencyMs: Date.now() - startedAt, inputBytes: Buffer.byteLength(requestBody) });
    } catch (error) {
      if (process.env.NODE_ENV !== "test") await recordWorkerExternalApiUsage({ pool: getPool(), userId: task.data.userId, provider: "internal-worker", operation: "agent_run", status: "error", errorCode: isTimeoutError(error) ? "timeout" : "network_error", latencyMs: Date.now() - startedAt, inputBytes: Buffer.byteLength(requestBody) });
      throw error;
    }
    // Suspension and entitlement changes are terminal for this queued run.
    // Returning a skipped result prevents BullMQ from repeatedly retrying an
    // action that the current account state no longer permits.
    if (response.status === 403) {
      return { status: "skipped", reason: "authorization-revoked" };
    }
    if (!response.ok) {
      throw new Error(`Agent run endpoint returned ${response.status}`);
    }

    const result = await response.json().catch(() => null) as { status?: string } | null;
    console.log(`[agent-run-worker] Session ${task.data.sessionId}: ${result?.status ?? "completed"}`);
    return result;
  },
  { connection, skipVersionCheck: true, ...workerPollingOptions(), concurrency: 1 },
);

function isTimeoutError(error: unknown): boolean {
  return (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) ||
    (error instanceof Error && error.name.toLowerCase() === "timeouterror");
}

export async function closeAgentRunResources() {
  await agentRunWorker.close();
  await agentRunQueue.close();
}
