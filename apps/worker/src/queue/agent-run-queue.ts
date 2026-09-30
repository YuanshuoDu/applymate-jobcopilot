import { pinnedFetch } from "@jobcopilot/shared";
import { Queue, Worker } from "bullmq";
import { workerPollingOptions } from "./worker-polling-options.js";
import { redisConnection } from "../redis.js";
import { getPool } from "../db/apply-results.js";
import { measureWorkerResponseBytes, recordWorkerExternalApiUsage } from "../api-usage/external-api-usage.js";
import { runCanonicalAgentTurn } from "./agent-run-turn-executor.js";
import { createAgentRunCanonicalProducer, type AgentRunCanonicalProducer } from "./agent-run-canonical-dispatch.js";
import { resolveProductionAgentFlags } from "../runtime/production-agent-flags.js";
import { TURN_QUEUE_NAME } from "../runtime/turns/turn-queue.js";
import { AGENT_EXECUTION_DISPATCH_POLL_MS, dispatchPendingAgentExecutionOutbox } from "./agent-execution-dispatch-recovery.js";
import { reconcilePublishedAgentExecutionDispatches } from "./agent-execution-dispatch-published-recovery.js";
import { failStaleUnnamespacedLegacyResume, failTurnScopedLegacyResume, legacyResumeFailureReasonFromBull, legacyResumeStaleBefore, legacyResumeTerminalizationFailure, type LegacyResumeFailureReason } from "./agent-run-legacy-terminal-failure.js";

export const AGENT_RUN_QUEUE_NAME = "agent-runs";

export interface AgentRunTaskPayload {
  userId: string;
  sessionId: string;
  /** Present for TurnEngine dispatch; omitted for reversible legacy fallback. */
  turnId?: string;
  executionId?: string;
  attemptCount?: number;
  questionId?: string;
  legacyTurnId?: string;
}
const connection = redisConnection;

export const agentRunQueue = new Queue<AgentRunTaskPayload>(AGENT_RUN_QUEUE_NAME, { connection, skipVersionCheck: true });
const agentRunCanonicalProducer = createAgentRunCanonicalProducer();

function internalRunUrl() {
  const base = process.env.AGENT_WEB_URL?.replace(/\/$/, "");
  return base ? `${base}/api/internal/agent-run` : null;
}
type AgentRunJob = { id?: string; data: AgentRunTaskPayload; attemptsMade: number; opts?: { attempts?: number } }
const AUTHORIZATION_FAILURE = "Authorization was revoked before this agent run started."
const RETRY_EXHAUSTED_FAILURE = "This agent run could not start after retrying. Please try again."
const MIN_DISPATCH_POLL_MS = 250; const MAX_DISPATCH_POLL_MS = 30_000

async function markQueuedExecutionFailed(task: AgentRunJob, visibleError: string): Promise<boolean> {
  const { executionId, attemptCount, userId, sessionId } = task.data
  if (!task.id || !executionId || !userId || !sessionId) return false
  if (attemptCount !== undefined && (!Number.isSafeInteger(attemptCount) || attemptCount < 0)) return false
  const values: unknown[] = [executionId, userId, sessionId, task.id, visibleError]
  const attemptFence = attemptCount === undefined ? "" : `AND "attemptCount" = $6`; if (attemptCount !== undefined) values.push(attemptCount)
  const result = await getPool().query(`UPDATE "agent_executions"
    SET "status" = 'failed', "error" = $5, "completedAt" = CURRENT_TIMESTAMP
    WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3
      AND "workerTaskId" = $4 AND "status" = 'queued' ${attemptFence}`, values)
  return result.rowCount === 1
}

function isFinalAttempt(task: AgentRunJob): boolean { return task.attemptsMade + 1 >= (task.opts?.attempts ?? 1) }

function isTurnScopedLegacyResume(task: AgentRunJob): task is AgentRunJob & { id: string; data: AgentRunTaskPayload & Required<Pick<AgentRunTaskPayload, "executionId" | "attemptCount" | "questionId" | "legacyTurnId">> } {
  const { executionId, attemptCount, questionId, legacyTurnId } = task.data
  return Boolean(task.id && executionId && questionId && legacyTurnId && questionId.startsWith(`agent-question:${legacyTurnId}:legacy:`) && Number.isSafeInteger(attemptCount) && Number(attemptCount) >= 0)
}

function isUnnamespacedLegacyResume(task: AgentRunJob): task is AgentRunJob & { id: string; data: AgentRunTaskPayload & Required<Pick<AgentRunTaskPayload, "executionId" | "attemptCount" | "questionId">> } {
  const { turnId, executionId, attemptCount, questionId, legacyTurnId } = task.data
  return Boolean(task.id && !turnId && !legacyTurnId && executionId && questionId && !questionId.startsWith("agent-question:") && Number.isSafeInteger(attemptCount) && Number(attemptCount) >= 0 && Number(attemptCount) < Number.MAX_SAFE_INTEGER)
}

async function failTurnScopedResume(task: AgentRunJob, reason: LegacyResumeFailureReason): Promise<boolean> {
  if (!isTurnScopedLegacyResume(task)) return false
  const staleBefore = reason === "authorization_revoked" ? legacyResumeStaleBefore() : null
  const staleRunning = staleBefore && task.data.attemptCount < Number.MAX_SAFE_INTEGER - 1
    ? { staleBefore }
    : undefined
  return failTurnScopedLegacyResume(getPool(), { userId: task.data.userId, sessionId: task.data.sessionId,
    executionId: task.data.executionId, attemptCount: task.data.attemptCount, workerTaskId: task.id,
    questionId: task.data.questionId, legacyTurnId: task.data.legacyTurnId, reason,
    ...(staleRunning ? { staleRunning } : {}) })
}

function startExecutionDispatchRecovery() {
  const interval = Number(process.env.AGENT_EXECUTION_DISPATCH_POLL_MS ?? AGENT_EXECUTION_DISPATCH_POLL_MS)
  if (!Number.isInteger(interval) || interval < 1) throw new RangeError("Agent execution dispatch recovery interval must be positive")
  const pollMs = Math.max(MIN_DISPATCH_POLL_MS, Math.min(MAX_DISPATCH_POLL_MS, interval))
  let closed = false
  let inFlight: Promise<unknown> | null = null
  const run = () => {
    if (closed || inFlight) return
    const pendingScan = (async () => {
      try { await dispatchPendingAgentExecutionOutbox(getPool(), agentRunQueue) }
      catch (error: unknown) { console.error("[agent-execution-dispatch] pending scan failed:", error) }
    })()
    const publishedScan = (async () => {
      try { await reconcilePublishedAgentExecutionDispatches(getPool(), agentRunQueue) }
      catch (error: unknown) { console.error("[agent-execution-dispatch] published scan failed:", error) }
    })()
    const current = Promise.all([pendingScan, publishedScan]).finally(() => { if (inFlight === current) inFlight = null })
    inFlight = current
  }
  const timer = setInterval(run, pollMs)
  timer.unref?.()
  run()
  return { async close() { closed = true; clearInterval(timer); await inFlight } }
}

export function createAgentRunProcessor(canonicalProducer: AgentRunCanonicalProducer = agentRunCanonicalProducer) {
  return async (task: AgentRunJob) => {
    if (task.data.turnId) {
      if (!resolveProductionAgentFlags().canonicalAutomationEnabled) {
        // Gate-off is an explicit, durable rollback to the existing pipeline
        // adapter so a queued automation still reaches a terminal outcome.
        return runCanonicalAgentTurn(task, getPool());
      }
      await canonicalProducer.enqueue({ sessionId: task.data.sessionId, turnId: task.data.turnId });
      return { status: "routed" as const, queue: TURN_QUEUE_NAME, turnId: task.data.turnId };
    }
    try {
      return await processScheduledAgentRun(task)
    } catch (error: unknown) {
      if (isFinalAttempt(task) && isTurnScopedLegacyResume(task)) {
        const reason = legacyResumeFailureReasonFromBull(error) ?? "retry_exhausted"
        try { await failTurnScopedResume(task, reason) }
        catch (terminalError: unknown) { throw legacyResumeTerminalizationFailure(reason, terminalError) }
      } else if (isFinalAttempt(task)) {
        await markQueuedExecutionFailed(task, RETRY_EXHAUSTED_FAILURE)
      }
      throw error
    }
  };
}

async function processScheduledAgentRun(task: AgentRunJob) {
    const url = internalRunUrl();
    const secret = process.env.AGENT_WORKER_SECRET;
    if (!url) throw new Error("AGENT_WEB_URL is required for scheduled agent runs");
    if (!secret) throw new Error("AGENT_WORKER_SECRET is required for scheduled agent runs");

    const startedAt = Date.now();
    const { attemptCount, ...taskInput } = task.data
    const requestBody = JSON.stringify({
      ...taskInput,
      ...(attemptCount === undefined ? {} : { expectedAttemptCount: attemptCount }),
      ...(task.id ? { workerTaskId: task.id } : {}),
    });
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
      if (process.env.NODE_ENV !== "test") await recordWorkerExternalApiUsage({ pool: getPool(), userId: task.data.userId, provider: "internal-worker", operation: "agent_run", status: response.ok ? "success" : "error", httpStatus: response.status, errorCode: response.ok ? undefined : response.status === 429 ? "http_429" : response.status >= 500 ? "http_5xx" : "http_4xx", latencyMs: Date.now() - startedAt, inputBytes: Buffer.byteLength(requestBody), outputBytes: await measureWorkerResponseBytes(response) });
    } catch (error) {
      if (process.env.NODE_ENV !== "test") await recordWorkerExternalApiUsage({ pool: getPool(), userId: task.data.userId, provider: "internal-worker", operation: "agent_run", status: "error", errorCode: isTimeoutError(error) ? "timeout" : "network_error", latencyMs: Date.now() - startedAt, inputBytes: Buffer.byteLength(requestBody) });
      throw error;
    }
    // Keep suspension and entitlement revocation terminal for this queued run.
    if (response.status === 403) {
      if (isTurnScopedLegacyResume(task)) {
        try { await failTurnScopedResume(task, "authorization_revoked") }
        catch (terminalError: unknown) { throw legacyResumeTerminalizationFailure("authorization_revoked", terminalError) }
      } else {
        const queuedFailed = await markQueuedExecutionFailed(task, AUTHORIZATION_FAILURE)
        if (!queuedFailed && isUnnamespacedLegacyResume(task)) {
          const staleBefore = legacyResumeStaleBefore()
          if (staleBefore) {
            try {
              await failStaleUnnamespacedLegacyResume(getPool(), {
                userId: task.data.userId,
                sessionId: task.data.sessionId,
                executionId: task.data.executionId,
                attemptCount: task.data.attemptCount,
                workerTaskId: task.id,
                questionId: task.data.questionId,
                reason: "authorization_revoked",
                staleBefore,
              })
            } catch (terminalError: unknown) {
              throw legacyResumeTerminalizationFailure("authorization_revoked", terminalError)
            }
          }
        }
      }
      return { status: "skipped", reason: "authorization-revoked" };
    }
    // Web has committed the terminal Turn event/outbox before returning 429.
    if (response.status === 429 && isTurnScopedLegacyResume(task)) {
      return { status: "skipped", reason: "dispatch-preflight-rejected" };
    }
    if (!response.ok) {
      throw new Error(`Agent run endpoint returned ${response.status}`);
    }

    const result = await response.json().catch(() => null) as { status?: string } | null;
    console.log(`[agent-run-worker] Session ${task.data.sessionId}: ${result?.status ?? "completed"}`);
    return result;
}

export const agentRunWorker = new Worker<AgentRunTaskPayload>(
  AGENT_RUN_QUEUE_NAME,
  createAgentRunProcessor(),
  // Wait for the canonical consumer and recovery scanner before routing jobs.
  { connection, skipVersionCheck: true, autorun: false, ...workerPollingOptions(), concurrency: 1 },
);

let agentRunWorkerStarted = false;
let agentExecutionDispatchRecovery: ReturnType<typeof startExecutionDispatchRecovery> | null = null;

/** Start the routing worker after canonical Worker resources are ready. */
export function startAgentRunWorker(): void {
  if (agentRunWorkerStarted) return;
  agentExecutionDispatchRecovery ??= startExecutionDispatchRecovery();
  agentRunWorkerStarted = true;
  void agentRunWorker.run().catch((error: unknown) => {
    console.error("[agent-run-worker] worker loop failed:", error);
  });
}

function isTimeoutError(error: unknown): boolean {
  return (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) ||
    (error instanceof Error && error.name.toLowerCase() === "timeouterror");
}

export async function closeAgentRunResources() {
  let firstError: unknown;
  try {
    await agentExecutionDispatchRecovery?.close();
  } catch (error: unknown) {
    firstError = error;
  }
  agentExecutionDispatchRecovery = null;
  try {
    await agentRunWorker.close();
  } catch (error: unknown) {
    if (firstError === undefined) firstError = error;
  }
  try {
    await agentRunCanonicalProducer.close();
  } catch (error: unknown) {
    if (firstError === undefined) firstError = error;
  }
  try {
    await agentRunQueue.close();
  } catch (error: unknown) {
    if (firstError === undefined) firstError = error;
  }
  if (firstError !== undefined) throw firstError;
}
