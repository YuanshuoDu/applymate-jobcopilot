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

  it("continues independent tasks after one task fails", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new TypeError("private response body"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const scheduler = createAutomationScheduler({
      tasks: [
        { name: "automations", endpoint: "https://app.applymate.test/api/agent/automations/due", secret: "scheduler-secret" },
        { name: "alerts", endpoint: "https://app.applymate.test/api/admin/observability/alerts/evaluate", secret: "scheduler-secret" },
      ],
      intervalMs: 300_000,
      request,
      recordUsage,
    });

    await scheduler.run();

    expect(request).toHaveBeenCalledTimes(2);
    expect(scheduler.status().lastError).toBe("network_error");
    expect(recordUsage).toHaveBeenCalledTimes(2);
  });

  it("backs off a failing task instead of retrying it every scheduler tick", async () => {
    let currentTime = 0;
    const request = vi.fn().mockRejectedValue(new TypeError("private response body"));
    const scheduler = createAutomationScheduler({
      tasks: [{ name: "alerts", endpoint: "https://app.applymate.test/api/admin/observability/alerts/evaluate", secret: "scheduler-secret" }],
      intervalMs: 1_000,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 4_000,
      now: () => currentTime,
      request,
      recordUsage: vi.fn().mockResolvedValue(undefined),
    });

    await scheduler.run();
    currentTime = 999;
    await scheduler.run();
    expect(request).toHaveBeenCalledTimes(1);

    currentTime = 1_000;
    await scheduler.run();
    currentTime = 2_999;
    await scheduler.run();
    expect(request).toHaveBeenCalledTimes(2);

    currentTime = 3_000;
    await scheduler.run();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each([429, 503])("honors delay-seconds on HTTP %i responses", async (status) => {
    let currentTime = 0;
    const request = vi.fn()
      .mockResolvedValueOnce(new Response("retry later", { status, headers: { "Retry-After": "3" } }))
      .mockResolvedValue(new Response("ok"));
    const scheduler = createAutomationScheduler({
      tasks: [{ name: "automations", endpoint: "https://app.applymate.test/api/agent/automations/due", secret: "scheduler-secret" }],
      intervalMs: 1_000,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 5_000,
      now: () => currentTime,
      request,
      recordUsage: vi.fn().mockResolvedValue(undefined),
    });

    await scheduler.run();
    currentTime = 2_999;
    await scheduler.run();
    expect(request).toHaveBeenCalledTimes(1);

    currentTime = 3_000;
    await scheduler.run();
    expect(request).toHaveBeenCalledTimes(2);
    expect(scheduler.status().lastError).toBeNull();
  });

  it.each([429, 503])("honors HTTP-date on HTTP %i responses", async (status) => {
    const startTime = Date.parse("Mon, 01 Jan 2024 00:00:00 GMT");
    let currentTime = startTime;
    const request = vi.fn()
      .mockResolvedValueOnce(new Response("retry later", {
        status,
        headers: { "Retry-After": new Date(startTime + 5_000).toUTCString() },
      }))
      .mockResolvedValue(new Response("ok"));
    const scheduler = createAutomationScheduler({
      tasks: [{ name: "automations", endpoint: "https://app.applymate.test/api/agent/automations/due", secret: "scheduler-secret" }],
      intervalMs: 1_000,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 10_000,
      now: () => currentTime,
      request,
      recordUsage: vi.fn().mockResolvedValue(undefined),
    });

    await scheduler.run();
    currentTime = startTime + 4_999;
    await scheduler.run();
    expect(request).toHaveBeenCalledTimes(1);

    currentTime = startTime + 5_000;
    await scheduler.run();
    expect(request).toHaveBeenCalledTimes(2);
    expect(scheduler.status().lastError).toBeNull();
  });

  it.each([
    ["RFC850", "Sunday, 06-Nov-94 08:49:35 GMT"],
    ["asctime", "Sun Nov  6 08:49:35 1994"],
  ])("honors %s Retry-After values through the scheduler", async (_format, retryAfter) => {
    const startTime = Date.parse("Sun, 06 Nov 1994 08:49:30 GMT");
    let currentTime = startTime;
    const request = vi.fn()
      .mockResolvedValueOnce(new Response("retry later", { status: 429, headers: { "Retry-After": retryAfter } }))
      .mockResolvedValue(new Response("ok"));
    const scheduler = createAutomationScheduler({
      tasks: [{ name: "automations", endpoint: "https://app.applymate.test/api/agent/automations/due", secret: "scheduler-secret" }],
      intervalMs: 1_000,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 10_000,
      now: () => currentTime,
      request,
      recordUsage: vi.fn().mockResolvedValue(undefined),
    });

    await scheduler.run();
    currentTime = startTime + 4_999;
    await scheduler.run();
    expect(request).toHaveBeenCalledTimes(1);

    currentTime = startTime + 5_000;
    await scheduler.run();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("honors leap-second Retry-After as the next representable UTC second", async () => {
    const startTime = Date.parse("Sun, 06 Nov 1994 08:49:59 GMT");
    let currentTime = startTime;
    const request = vi.fn()
      .mockResolvedValueOnce(new Response("retry later", { status: 429, headers: { "Retry-After": "Sun Nov  6 08:49:60 1994" } }))
      .mockResolvedValue(new Response("ok"));
    const scheduler = createAutomationScheduler({
      tasks: [{ name: "automations", endpoint: "https://app.applymate.test/api/agent/automations/due", secret: "scheduler-secret" }],
      intervalMs: 1_000,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 10_000,
      now: () => currentTime,
      request,
      recordUsage: vi.fn().mockResolvedValue(undefined),
    });

    await scheduler.run();
    currentTime = startTime + 999;
    await scheduler.run();
    expect(request).toHaveBeenCalledTimes(1);

    currentTime = startTime + 1_000;
    await scheduler.run();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    { retryAfter: "3", telemetryDelayMs: 1_000, retryMaxDelayMs: 5_000, expectedDueAt: 3_000 },
    { retryAfter: "60", telemetryDelayMs: 2_000, retryMaxDelayMs: 4_000, expectedDueAt: 4_000 },
  ])("anchors Retry-After to response time across telemetry delay (%#)", async ({ retryAfter, telemetryDelayMs, retryMaxDelayMs, expectedDueAt }) => {
    let currentTime = 0;
    let advancedClock = false;
    const recordUsage = vi.fn().mockImplementation(async () => {
      if (!advancedClock) {
        currentTime += telemetryDelayMs;
        advancedClock = true;
      }
    });
    const request = vi.fn()
      .mockResolvedValueOnce(new Response("retry later", { status: 429, headers: { "Retry-After": retryAfter } }))
      .mockResolvedValue(new Response("ok"));
    const scheduler = createAutomationScheduler({
      tasks: [{ name: "automations", endpoint: "https://app.applymate.test/api/agent/automations/due", secret: "scheduler-secret" }],
      intervalMs: 1_000,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs,
      now: () => currentTime,
      request,
      recordUsage,
    });

    await scheduler.run();
    currentTime = expectedDueAt - 1;
    await scheduler.run();
    expect(request).toHaveBeenCalledTimes(1);

    currentTime = expectedDueAt;
    await scheduler.run();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    { retryAfter: "3", telemetryDelayMs: 5_000, retryMaxDelayMs: 5_000 },
    { retryAfter: "60", telemetryDelayMs: 5_000, retryMaxDelayMs: 4_000 },
  ])("does not extend a Retry-After deadline past telemetry latency (%#)", async ({ retryAfter, telemetryDelayMs, retryMaxDelayMs }) => {
    let currentTime = 0;
    const request = vi.fn()
      .mockResolvedValueOnce(new Response("retry later", { status: 429, headers: { "Retry-After": retryAfter } }))
      .mockResolvedValue(new Response("ok"));
    const recordUsage = vi.fn().mockImplementation(async () => { currentTime += telemetryDelayMs; });
    const scheduler = createAutomationScheduler({
      tasks: [{ name: "automations", endpoint: "https://app.applymate.test/api/agent/automations/due", secret: "scheduler-secret" }],
      intervalMs: 1_000,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs,
      now: () => currentTime,
      request,
      recordUsage,
    });

    await scheduler.run();
    expect(currentTime).toBe(telemetryDelayMs);
    await scheduler.run();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("caps Retry-After at the configured maximum delay", async () => {
    let currentTime = 0;
    const request = vi.fn()
      .mockResolvedValueOnce(new Response("retry later", { status: 429, headers: { "Retry-After": "60" } }))
      .mockResolvedValue(new Response("ok"));
    const scheduler = createAutomationScheduler({
      tasks: [{ name: "automations", endpoint: "https://app.applymate.test/api/agent/automations/due", secret: "scheduler-secret" }],
      intervalMs: 1_000,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 4_000,
      now: () => currentTime,
      request,
      recordUsage: vi.fn().mockResolvedValue(undefined),
    });

    await scheduler.run();
    currentTime = 3_999;
    await scheduler.run();
    expect(request).toHaveBeenCalledTimes(1);

    currentTime = 4_000;
    await scheduler.run();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("ignores Retry-After for statuses other than 429 and 503", async () => {
    let currentTime = 0;
    const request = vi.fn()
      .mockResolvedValueOnce(new Response("server error", { status: 500, headers: { "Retry-After": "60" } }))
      .mockResolvedValue(new Response("ok"));
    const scheduler = createAutomationScheduler({
      tasks: [{ name: "automations", endpoint: "https://app.applymate.test/api/agent/automations/due", secret: "scheduler-secret" }],
      intervalMs: 1_000,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 4_000,
      now: () => currentTime,
      request,
      recordUsage: vi.fn().mockResolvedValue(undefined),
    });

    await scheduler.run();
    currentTime = 999;
    await scheduler.run();
    expect(request).toHaveBeenCalledTimes(1);

    currentTime = 1_000;
    await scheduler.run();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not turn usage telemetry failures into scheduler failures", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    const recordUsage = vi.fn().mockRejectedValue(new Error("telemetry database unavailable"));
    const scheduler = createAutomationScheduler({
      tasks: [{ name: "automations", endpoint: "https://app.applymate.test/api/agent/automations/due", secret: "scheduler-secret" }],
      intervalMs: 300_000,
      request,
      recordUsage,
    });

    await scheduler.run();

    expect(scheduler.status().lastError).toBeNull();
    expect(scheduler.status().lastSuccessAt).not.toBeNull();
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
