import type { Pool, PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LegacyApplicationTaskOutcomeResult,
  LegacyApplicationTaskOutcomeScope,
} from "../db/legacy-application-task-outcome.js";

type Outcome<T> = LegacyApplicationTaskOutcomeResult<T>;

const mocks = vi.hoisted(() => ({
  finish: vi.fn(),
  review: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  unavailable: vi.fn(),
  persist: vi.fn(async (
    client: PoolClient,
    _scope: LegacyApplicationTaskOutcomeScope,
    write: (client: PoolClient) => Promise<unknown>,
  ): Promise<Outcome<unknown>> => ({ status: "persisted", value: await write(client) })),
}));

vi.mock("../db/application-task-state.js", () => ({ finishApplicationTask: mocks.finish }));
vi.mock("../db/legacy-application-task-outcome.js", () => ({
  persistLegacyApplicationTaskOutcome: mocks.persist,
  writeLegacyFillReviewOutcome: mocks.review,
  writeLegacyFillSuccessOutcome: mocks.success,
  writeLegacyFillErrorOutcome: mocks.error,
  writeLegacyFillUnavailableOutcome: mocks.unavailable,
}));

import {
  persistLegacyFillErrorOutcome,
  persistLegacyFillHarnessOutcome,
  persistSuspendedLegacyFillOutcome,
  persistUnavailableLegacyFillOutcome,
} from "./legacy-apply-outcomes.js";

const scope = { applicationTaskId: "task-1", userId: "user-1", jobId: "job-1" };

function testPool(events: string[]): Pool {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql === "BEGIN") events.push("begin");
      else if (sql === "COMMIT") events.push("commit");
      else if (sql === "ROLLBACK") events.push("rollback");
      else events.push("configure-user");
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(() => events.push("release")),
  };
  return { connect: vi.fn(async () => client) } as unknown as Pool;
}

function harnessInput(
  pool: Pool,
  overrides: Partial<Parameters<typeof persistLegacyFillHarnessOutcome>[0]> = {},
): Parameters<typeof persistLegacyFillHarnessOutcome>[0] {
  return {
    pool, scope, harnessResult: { status: "manual", error: "Review", reviewReady: false }, flow: "greenhouse",
    usedFlow: "greenhouse", startedAt: Date.now(), task: { jobTitle: "Engineer", jobCompany: "Example", applyUrl: "https://example.test/apply" },
    inspectNeeds: async () => ({ missing: [], sensitive: [] }), turnStopped: false, submissionRequestStarted: false,
    applicationTaskFinalized: false, needsUserTakeover: () => false,
    notifyInApp: vi.fn(async () => undefined), notifyEmail: vi.fn(async () => undefined),
    purgeCoverLetters: vi.fn(async () => undefined), ...overrides,
  };
}

describe("legacy fill outcome orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.persist.mockImplementation(async (client, _scope, write) => ({ status: "persisted", value: await write(client) }));
    mocks.finish.mockResolvedValue(undefined);
    mocks.review.mockResolvedValue(true);
    mocks.success.mockResolvedValue({ taskFinalized: true });
    mocks.error.mockResolvedValue({ insertedResult: true, taskFinalized: true });
    mocks.unavailable.mockResolvedValue(true);
  });

  it("persists the review checkpoint and notifies only after commit", async () => {
    const events: string[] = [];
    const pool = testPool(events);
    mocks.review.mockImplementation(async () => { events.push("write-review"); return true; });
    const notifyInApp = vi.fn(async () => { events.push("notify"); });

    const result = await persistLegacyFillHarnessOutcome(harnessInput(pool, {
      harnessResult: { status: "manual", error: "Review", reviewReady: true },
      notifyInApp,
    }));

    expect(result).toEqual({ persisted: true, taskFinalized: false });
    expect(events.indexOf("commit")).toBeLessThan(events.indexOf("notify"));
    expect(notifyInApp).toHaveBeenCalledWith({
      userId: scope.userId, jobId: scope.jobId, jobTitle: "Engineer", jobCompany: "Example", status: "manual",
    });
  });

  it("notifies success and awaits retention cleanup only after the outcome transaction commits", async () => {
    const events: string[] = [];
    const pool = testPool(events);
    mocks.success.mockImplementation(async () => { events.push("write-success"); return { taskFinalized: true }; });
    const notifyInApp = vi.fn(async () => { events.push("notify-in-app"); });
    const notifyEmail = vi.fn(async () => { events.push("notify-email"); });
    const purgeCoverLetters = vi.fn(async () => { events.push("purge"); });

    const result = await persistLegacyFillHarnessOutcome(harnessInput(pool, {
      harnessResult: { status: "submitted", error: null }, notifyInApp, notifyEmail, purgeCoverLetters,
    }));

    expect(result).toEqual({ persisted: true, taskFinalized: true });
    expect(events.indexOf("commit")).toBeLessThan(events.indexOf("purge"));
    expect(events.indexOf("commit")).toBeLessThan(events.indexOf("notify-in-app"));
    expect(events.indexOf("commit")).toBeLessThan(events.indexOf("notify-email"));
  });

  it("does not write or notify when TaskGraph already owns the fill task", async () => {
    const events: string[] = [];
    const pool = testPool(events);
    mocks.persist.mockImplementation(async () => ({ status: "taskgraph_bound" }));
    const notifyInApp = vi.fn();

    await expect(persistLegacyFillHarnessOutcome(harnessInput(pool, { notifyInApp })))
      .resolves.toEqual({ persisted: false, taskFinalized: false });

    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(notifyInApp).not.toHaveBeenCalled();
    expect(events).toContain("commit");
  });

  it("commits suspended-account and unavailable-ATS outcomes before returning", async () => {
    const suspendedEvents: string[] = [];
    await persistSuspendedLegacyFillOutcome(testPool(suspendedEvents), scope);
    expect(mocks.finish).toHaveBeenCalledWith(expect.anything(), scope.applicationTaskId, "failed", "account_suspended", expect.any(String), "fill");
    expect(suspendedEvents).toContain("commit");

    const unavailableEvents: string[] = [];
    mocks.unavailable.mockImplementation(async () => { unavailableEvents.push("write-unavailable"); return true; });
    const notifyInApp = vi.fn(async () => { unavailableEvents.push("notify"); });
    await persistUnavailableLegacyFillOutcome({
      pool: testPool(unavailableEvents), scope, flow: "greenhouse", startedAt: Date.now(), message: "ATS unavailable", notifyInApp,
      task: { jobTitle: "Engineer", jobCompany: "Example" },
    });
    expect(unavailableEvents.indexOf("commit")).toBeLessThan(unavailableEvents.indexOf("notify"));
  });

  it("writes error outcome and notifies only when it inserted a result after commit", async () => {
    const events: string[] = [];
    mocks.error.mockImplementation(async () => { events.push("write-error"); return { insertedResult: true, taskFinalized: true }; });
    const notifyInApp = vi.fn(async () => { events.push("notify"); });

    await expect(persistLegacyFillErrorOutcome({
      pool: testPool(events), scope, error: "Worker failed", durationMs: 0,
      task: { jobTitle: "Engineer", jobCompany: "Example" },
      shouldInsertResult: true, browserAttemptStarted: false, applicationTaskFinalized: false, notifyInApp,
    })).resolves.toEqual({ insertedResult: true, taskFinalized: true });

    expect(events.indexOf("commit")).toBeLessThan(events.indexOf("notify"));
    expect(notifyInApp).toHaveBeenCalledWith({
      userId: scope.userId, jobId: scope.jobId, jobTitle: "Engineer", jobCompany: "Example", status: "failed",
    });
  });
});
