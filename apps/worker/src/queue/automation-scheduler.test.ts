import { describe, expect, it, vi } from "vitest";
import {
  automationSchedulerConfig,
  createAutomationScheduler,
  publicAutomationSchedulerStatus,
  startAutomationScheduler,
} from "./automation-scheduler.js";

describe("automation scheduler", () => {
  it("checks worker-maintained web tasks every five minutes by default", () => {
    expect(automationSchedulerConfig({
      AGENT_WEB_URL: "https://app.applymate.test",
      AGENT_AUTOMATION_CRON_SECRET: "scheduler-secret",
    }).intervalMs).toBe(5 * 60_000);
  });

  it("uses the worker web origin and dedicated scheduler secret", () => {
    expect(automationSchedulerConfig({
      AGENT_WEB_URL: "https://app.applymate.test/",
      AGENT_AUTOMATION_CRON_SECRET: "scheduler-secret",
      AGENT_SCHEDULER_INTERVAL_MS: "5000",
    })).toEqual({
      tasks: [
        { name: "automations", endpoint: "https://app.applymate.test/api/agent/automations/due", secret: "scheduler-secret" },
        { name: "broadcasts", endpoint: "https://app.applymate.test/api/notifications/broadcasts/due", secret: "scheduler-secret" },
        { name: "alerts", endpoint: "https://app.applymate.test/api/admin/observability/alerts/evaluate", secret: "scheduler-secret" },
      ],
      intervalMs: 60_000,
    });
  });

  it("requires the production web origin and secret", () => {
    expect(() => automationSchedulerConfig({ AGENT_AUTOMATION_CRON_SECRET: "secret" }))
      .toThrow("AGENT_WEB_URL");
    expect(() => automationSchedulerConfig({ AGENT_WEB_URL: "https://app.applymate.test" }))
      .toThrow("AGENT_AUTOMATION_CRON_SECRET");
  });

  it("calls the protected due endpoint and records success", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ started: [] })));
    const scheduler = createAutomationScheduler({
      tasks: [{ name: "automations", endpoint: "https://app.applymate.test/api/agent/automations/due", secret: "scheduler-secret" }],
      intervalMs: 300_000,
      request,
    });

    await scheduler.run();

    expect(request).toHaveBeenCalledWith(
      "https://app.applymate.test/api/agent/automations/due",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer scheduler-secret" },
      }),
    );
    expect(scheduler.status()).toMatchObject({ running: false, lastError: null });
    expect(scheduler.status().lastSuccessAt).not.toBeNull();
  });

  it("keeps the worker alive and reports a failed scheduler request", async () => {
    const request = vi.fn().mockResolvedValue(new Response("Unavailable", { status: 503 }));
    const scheduler = createAutomationScheduler({
      tasks: [{ name: "automations", endpoint: "https://app.applymate.test/api/agent/automations/due", secret: "scheduler-secret" }],
      intervalMs: 300_000,
      request,
    });

    await scheduler.run();

    expect(scheduler.status()).toMatchObject({ running: false, lastSuccessAt: null });
    expect(scheduler.status().lastError).toContain("503");
  });

  it("can be explicitly disabled for local worker usage", () => {
    const scheduler = startAutomationScheduler({ AGENT_SCHEDULER_ENABLED: "0" });
    expect(scheduler.status().enabled).toBe(false);
  });

  it("does not expose upstream error text through public health status", () => {
    expect(publicAutomationSchedulerStatus({
      enabled: true,
      running: false,
      lastAttemptAt: "2026-08-09T00:00:00.000Z",
      lastSuccessAt: null,
      lastError: "Due automation endpoint returned 503: internal diagnostic",
    })).toEqual({
      enabled: true,
      running: false,
      lastAttemptAt: "2026-08-09T00:00:00.000Z",
      lastSuccessAt: null,
      healthy: false,
    });
  });
});
