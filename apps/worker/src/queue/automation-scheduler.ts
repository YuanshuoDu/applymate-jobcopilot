const DEFAULT_INTERVAL_MS = 15 * 60_000;
const MINIMUM_INTERVAL_MS = 60_000;

export interface AutomationSchedulerStatus {
  enabled: boolean;
  running: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export interface AutomationScheduler {
  run(): Promise<void>;
  close(): void;
  status(): AutomationSchedulerStatus;
}

export interface AutomationSchedulerConfig {
  endpoint: string;
  secret: string;
  intervalMs: number;
  request?: typeof fetch;
}

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

  return {
    endpoint: `${webUrl}/api/agent/automations/due`,
    secret,
    intervalMs,
  };
}

export function createAutomationScheduler(config: AutomationSchedulerConfig): AutomationScheduler {
  const request = config.request ?? fetch;
  const state: AutomationSchedulerStatus = {
    enabled: true,
    running: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
  };

  async function run() {
    if (state.running) return;
    state.running = true;
    state.lastAttemptAt = new Date().toISOString();

    try {
      const response = await request(config.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.secret}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Due automation endpoint returned ${response.status}: ${body.slice(0, 300)}`);
      }

      state.lastSuccessAt = new Date().toISOString();
      state.lastError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.lastError = message;
      console.error(`[automation-scheduler] ${message}`);
    } finally {
      state.running = false;
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    run,
    close() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    status() {
      return { ...state };
    },
  };
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

  const scheduler = createAutomationScheduler(automationSchedulerConfig(env));
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
