import { describe, expect, it } from "vitest";
import { createSchedulerTaskState, markSchedulerTaskFailure, markSchedulerTaskSuccess } from "./scheduler-retry.js";

describe("scheduler retry state", () => {
  it("backs off repeated failures and resets after success", () => {
    const state = createSchedulerTaskState();

    markSchedulerTaskFailure(state, "network_error", 0, 1_000, 1_000, 4_000);
    expect(state).toMatchObject({ consecutiveFailures: 1, nextAttemptAt: 1_000, lastFailure: "network_error" });

    markSchedulerTaskFailure(state, "network_error", 1_000, 1_000, 1_000, 4_000);
    expect(state).toMatchObject({ consecutiveFailures: 2, nextAttemptAt: 3_000 });

    markSchedulerTaskSuccess(state, 3_000);
    expect(state).toEqual({ lastSuccessfulAt: 3_000, consecutiveFailures: 0, nextAttemptAt: 0, lastFailure: null });
  });
});
