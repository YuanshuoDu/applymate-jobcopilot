import { getPool } from "../db/apply-results.js";
import { measureWorkerResponseBytes, recordWorkerExternalApiUsage } from "../api-usage/external-api-usage.js";
import { getWorkerRuntimeState } from "../admin/worker-state.js";
import { getSchedulerTaskState, markSchedulerTaskFailure, markSchedulerTaskSuccess, type SchedulerTaskState } from "./scheduler-retry.js";

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const MINIMUM_INTERVAL_MS = 60_000;
const AUDIT_CHECKPOINT_INTERVAL_MS = 24 * 60 * 60_000;
const RETENTION_CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;
const SUBSCRIPTION_LIFECYCLE_INTERVAL_MS = 15 * 60_000;
const MAX_RETRY_DELAY_MS = 60 * 60_000;

export interface AutomationSchedulerStatus {
  enabled: boolean;
  running: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export type PublicAutomationSchedulerStatus = Omit<AutomationSchedulerStatus, "lastError"> & {
  healthy: boolean;
};

export function publicAutomationSchedulerStatus(
  status: AutomationSchedulerStatus,
): PublicAutomationSchedulerStatus {
  const { lastError, ...safeStatus } = status;
  return { ...safeStatus, healthy: lastError === null };
}

export interface AutomationScheduler {
  run(): Promise<void>;
  close(): void;
  status(): AutomationSchedulerStatus;
}

export interface AutomationSchedulerConfig {
  tasks: ReadonlyArray<{ name: string; endpoint: string; secret: string; intervalMs?: number }>;
  intervalMs: number;
  request?: typeof fetch;
  recordUsage?: SchedulerUsageRecorder;
  shouldRun?: () => boolean;
  now?: () => number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}

type SchedulerUsageRecorder = (input: {
  operation: string;
  status: "success" | "error";
  latencyMs: number;
  httpStatus?: number;
  outputBytes?: number;
  errorCode?: string;
}) => Promise<void>;

export function automationSchedulerConfig(
  env: NodeJS.ProcessEnv = process.env,
): AutomationSchedulerConfig {
  const webUrl = env.AGENT_WEB_URL?.replace(/\/$/, "");
  const secret = env.AGENT_AUTOMATION_CRON_SECRET ?? env.CRON_SECRET;
  if (!webUrl) throw new Error("AGENT_WEB_URL is required for the automation scheduler");
  if (!secret) throw new Error("AGENT_AUTOMATION_CRON_SECRET is required for the automation scheduler");

  const configuredInterval = Number(env.AGENT_SCHEDULER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  const intervalMs = Number.isFinite(configuredInterval)
    ? Math.max(MINIMUM_INTERVAL_MS, configuredInterval)
    : DEFAULT_INTERVAL_MS;

  const maintenanceSecret = env.WEB_MAINTENANCE_CRON_SECRET ?? env.CRON_SECRET ?? secret;
  const auditCheckpointSecret = env.AUDIT_CHECKPOINT_CRON_SECRET ?? maintenanceSecret;
  return {
    tasks: [
      { name: "automations", endpoint: `${webUrl}/api/agent/automations/due`, secret },
      { name: "broadcasts", endpoint: `${webUrl}/api/notifications/broadcasts/due`, secret: maintenanceSecret },
      { name: "alerts", endpoint: `${webUrl}/api/admin/observability/alerts/evaluate`, secret: maintenanceSecret },
      { name: "audit-checkpoint", endpoint: `${webUrl}/api/admin/audit-checkpoint`, secret: auditCheckpointSecret, intervalMs: AUDIT_CHECKPOINT_INTERVAL_MS },
      { name: "retention-cleanup", endpoint: `${webUrl}/api/internal/maintenance/retention`, secret: maintenanceSecret, intervalMs: RETENTION_CLEANUP_INTERVAL_MS },
      { name: "subscription-lifecycle", endpoint: `${webUrl}/api/internal/maintenance/subscriptions`, secret: maintenanceSecret, intervalMs: SUBSCRIPTION_LIFECYCLE_INTERVAL_MS },
    ],
    intervalMs,
  };
}

export function createAutomationScheduler(config: AutomationSchedulerConfig): AutomationScheduler {
  const request = config.request ?? fetch;
  const recordUsage = config.recordUsage ?? defaultSchedulerUsageRecorder;
  const now = config.now ?? (() => Date.now());
  const state: AutomationSchedulerStatus = {
    enabled: true,
    running: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
  };
  const taskStates = new Map<string, SchedulerTaskState>();

  async function recordUsageSafely(input: Parameters<SchedulerUsageRecorder>[0]) {
    try {
      await recordUsage(input);
    } catch (error) {
      console.error(`[automation-scheduler] usage recording failed (${errorCode(error)})`);
    }
  }

  async function runTask(task: AutomationSchedulerConfig["tasks"][number], current: SchedulerTaskState) {
    const startedAt = now();
    try {
      const response = await request(task.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${task.secret}` },
        signal: AbortSignal.timeout(30_000),
      });
      const failure = response.ok ? undefined : `${task.name} returned ${response.status} (${httpErrorCode(response.status)})`;
      await recordUsageSafely({
        operation: `scheduler_${task.name}`,
        status: response.ok ? "success" : "error",
        httpStatus: response.status,
        outputBytes: await measureWorkerResponseBytes(response),
        errorCode: failure ? httpErrorCode(response.status) : undefined,
        latencyMs: now() - startedAt,
      });
      if (failure) {
        markSchedulerTaskFailure(current, failure, now(), task.intervalMs ?? config.intervalMs, config.retryBaseDelayMs ?? config.intervalMs, config.retryMaxDelayMs ?? MAX_RETRY_DELAY_MS);
        console.error(`[automation-scheduler] ${failure}; retry backoff engaged`);
        return failure;
      }
      markSchedulerTaskSuccess(current, now());
      return null;
    } catch (error) {
      const failure = errorCode(error);
      await recordUsageSafely({
        operation: `scheduler_${task.name}`,
        status: "error",
        errorCode: failure,
        latencyMs: now() - startedAt,
      });
      markSchedulerTaskFailure(current, failure, now(), task.intervalMs ?? config.intervalMs, config.retryBaseDelayMs ?? config.intervalMs, config.retryMaxDelayMs ?? MAX_RETRY_DELAY_MS);
      console.error(`[automation-scheduler] ${task.name} failed (${failure}); retry backoff engaged`);
      return failure;
    }
  }

  async function run() {
    if (state.running) return;
    if (config.shouldRun && !config.shouldRun()) return;
    state.running = true;
    state.lastAttemptAt = new Date(now()).toISOString();

    try {
      const failures: string[] = [];
      for (const task of config.tasks) {
        const current = getSchedulerTaskState(taskStates, task.name);
        const taskInterval = task.intervalMs ?? config.intervalMs;
        const currentTime = now();
        if (current.lastFailure && currentTime < current.nextAttemptAt) {
          failures.push(current.lastFailure);
          continue;
        }
        if (current.lastSuccessfulAt !== null && currentTime - current.lastSuccessfulAt < taskInterval) continue;
        const failure = await runTask(task, current);
        if (failure) failures.push(failure);
      }
      if (failures.length) {
        state.lastError = failures.join("; ");
        console.error(`[automation-scheduler] run failed (${state.lastError})`);
        return;
      }

      state.lastSuccessAt = new Date(now()).toISOString();
      state.lastError = null;
    } catch (error) {
      const message = errorCode(error);
      state.lastError = message;
      console.error(`[automation-scheduler] run failed (${message})`);
    } finally {
      state.running = false;
    }
  }

  return {
    run,
    close() {},
    status() {
      return { ...state };
    },
  };
}

async function defaultSchedulerUsageRecorder(input: Parameters<SchedulerUsageRecorder>[0]): Promise<void> {
  if (process.env.NODE_ENV === "test") return;
  await recordWorkerExternalApiUsage({
    pool: getPool(),
    provider: "internal-worker",
    operation: input.operation,
    status: input.status,
    latencyMs: input.latencyMs,
    httpStatus: input.httpStatus,
    outputBytes: input.outputBytes,
    errorCode: input.errorCode,
  });
}

function httpErrorCode(status: number): string {
  if (status === 429) return "http_429";
  if (status >= 500) return "http_5xx";
  if (status >= 400) return "http_4xx";
  return "provider_error";
}

function errorCode(error: unknown): string {
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) return "timeout";
  if (error instanceof Error && error.name.toLowerCase() === "timeouterror") return "timeout";
  return error instanceof TypeError ? "network_error" : "provider_error";
}

export function startAutomationScheduler(
  env: NodeJS.ProcessEnv = process.env,
): AutomationScheduler {
  if (env.AGENT_SCHEDULER_ENABLED === "0") {
    return {
      async run() {},
      close() {},
      status: () => ({
        enabled: false,
        running: false,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastError: null,
      }),
    };
  }

  const scheduler = createAutomationScheduler({
    ...automationSchedulerConfig(env),
    shouldRun: () => getWorkerRuntimeState().status !== "paused",
  });
  const interval = setInterval(() => void scheduler.run(), automationSchedulerConfig(env).intervalMs);
  void scheduler.run();

  return {
    ...scheduler,
    close() {
      clearInterval(interval);
      scheduler.close();
    },
  };
}
