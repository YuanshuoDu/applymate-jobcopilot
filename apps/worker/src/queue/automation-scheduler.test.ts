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
        { name: "audit-checkpoint", endpoint: "https://app.applymate.test/api/admin/audit-checkpoint", secret: "scheduler-secret", intervalMs: 24 * 60 * 60_000 },
        { name: "retention-cleanup", endpoint: "https://app.applymate.test/api/internal/maintenance/retention", secret: "scheduler-secret", intervalMs: 24 * 60 * 60_000 },
        { name: "subscription-lifecycle", endpoint: "https://app.applymate.test/api/internal/maintenance/subscriptions", secret: "scheduler-secret", intervalMs: 15 * 60_000 },
      ],
      intervalMs: 60_000,
    });
  });

  it("uses a separate maintenance secret for broadcasts and alerts when configured", () => {
    expect(automationSchedulerConfig({
      AGENT_WEB_URL: "https://app.applymate.test",
      AGENT_AUTOMATION_CRON_SECRET: "automation-secret",
      WEB_MAINTENANCE_CRON_SECRET: "maintenance-secret",
    }).tasks).toEqual([
      { name: "automations", endpoint: "https://app.applymate.test/api/agent/automations/due", secret: "automation-secret" },
      { name: "broadcasts", endpoint: "https://app.applymate.test/api/notifications/broadcasts/due", secret: "maintenance-secret" },
      { name: "alerts", endpoint: "https://app.applymate.test/api/admin/observability/alerts/evaluate", secret: "maintenance-secret" },
      { name: "audit-checkpoint", endpoint: "https://app.applymate.test/api/admin/audit-checkpoint", secret: "maintenance-secret", intervalMs: 24 * 60 * 60_000 },
      { name: "retention-cleanup", endpoint: "https://app.applymate.test/api/internal/maintenance/retention", secret: "maintenance-secret", intervalMs: 24 * 60 * 60_000 },
      { name: "subscription-lifecycle", endpoint: "https://app.applymate.test/api/internal/maintenance/subscriptions", secret: "maintenance-secret", intervalMs: 15 * 60_000 },
    ]);
  });

  it("does not run the daily audit checkpoint more than once per day", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ verified: true })));
    const scheduler = createAutomationScheduler({
      tasks: [{ name: "audit-checkpoint", endpoint: "https://app.applymate.test/api/admin/audit-checkpoint", secret: "maintenance-secret", intervalMs: 24 * 60 * 60_000 }],
      intervalMs: 300_000,
      request,
    });

    await scheduler.run();
    await scheduler.run();

    expect(request).toHaveBeenCalledTimes(1);
    expect(scheduler.status().lastError).toBeNull();
  });

  it("does not issue scheduler requests while the worker runtime is paused", async () => {
    const request = vi.fn();
    const recordUsage = vi.fn();
    const scheduler = createAutomationScheduler({
      tasks: [{ name: "automations", endpoint: "https://app.applymate.test/api/agent/automations/due", secret: "scheduler-secret" }],
      intervalMs: 300_000,
      request,
      recordUsage,
      shouldRun: () => false,
    });

    await scheduler.run();

    expect(request).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
    expect(scheduler.status()).toMatchObject({ running: false, lastAttemptAt: null, lastSuccessAt: null, lastError: null });
  });

  it("requires the production web origin and secret", () => {
    expect(() => automationSchedulerConfig({ AGENT_AUTOMATION_CRON_SECRET: "secret" }))
      .toThrow("AGENT_WEB_URL");
    expect(() => automationSchedulerConfig({ AGENT_WEB_URL: "https://app.applymate.test" }))
      .toThrow("AGENT_AUTOMATION_CRON_SECRET");
  });

  it("calls the protected due endpoint and records success", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ started: [] }), { headers: { "content-length": "16" } }));
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const scheduler = createAutomationScheduler({
      tasks: [{ name: "automations", endpoint: "https://app.applymate.test/api/agent/automations/due", secret: "scheduler-secret" }],
      intervalMs: 300_000,
      request,
      recordUsage,
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
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      operation: "scheduler_automations",
      status: "success",
      httpStatus: 200,
      outputBytes: 16,
    }));
  });

  it("keeps the worker alive and reports a failed scheduler request", async () => {
    const request = vi.fn().mockResolvedValue(new Response("private upstream response", { status: 503 }));
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const scheduler = createAutomationScheduler({
      tasks: [{ name: "automations", endpoint: "https://app.applymate.test/api/agent/automations/due", secret: "scheduler-secret" }],
      intervalMs: 300_000,
      request,
      recordUsage,
    });

    await scheduler.run();

    expect(scheduler.status()).toMatchObject({ running: false, lastSuccessAt: null });
    expect(scheduler.status().lastError).toBe("automations returned 503 (http_5xx)");
    expect(scheduler.status().lastError).not.toContain("private upstream response");
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      operation: "scheduler_automations",
      status: "error",
      httpStatus: 503,
      errorCode: "http_5xx",
    }));
  });

  it("records a stable network error for each failed scheduler request", async () => {
    const request = vi.fn().mockRejectedValue(new TypeError("private response body"));
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const scheduler = createAutomationScheduler({
      tasks: [{ name: "alerts", endpoint: "https://app.applymate.test/api/admin/observability/alerts/evaluate", secret: "scheduler-secret" }],
      intervalMs: 300_000,
      request,
      recordUsage,
    });

    await scheduler.run();

    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      operation: "scheduler_alerts",
      status: "error",
      errorCode: "network_error",
    }));
    expect(scheduler.status().lastError).toBe("network_error");
  });

  it("records native timeout errors as timeout", async () => {
    const request = vi.fn().mockRejectedValue(new DOMException("private response body", "TimeoutError"));
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const scheduler = createAutomationScheduler({
      tasks: [{ name: "alerts", endpoint: "https://app.applymate.test/api/admin/observability/alerts/evaluate", secret: "scheduler-secret" }],
      intervalMs: 300_000,
      request,
      recordUsage,
    });

    await scheduler.run();

    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ operation: "scheduler_alerts", status: "error", errorCode: "timeout" }));
    expect(scheduler.status().lastError).toBe("timeout");
    expect(JSON.stringify(recordUsage.mock.calls[0][0])).not.toContain("private response body");
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
