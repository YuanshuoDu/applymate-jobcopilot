import { describe, expect, it } from "vitest";
import {
  createSchedulerTaskState,
  markSchedulerTaskFailure,
  markSchedulerTaskSuccess,
  parseRetryAfterAt,
} from "./scheduler-retry.js";

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

  it("parses delay-seconds and caps even oversized server delays", () => {
    expect(parseRetryAfterAt("3", 10_000, 2_000)).toBe(12_000);
    expect(parseRetryAfterAt("2", 10_000, 5_000)).toBe(12_000);
    expect(parseRetryAfterAt("9007199254740992", 10_000, 5_000)).toBe(15_000);
  });

  it.each([
    ["IMF-fixdate", "Sun, 06 Nov 1994 08:49:35 GMT"],
    ["RFC850", "Sunday, 06-Nov-94 08:49:35 GMT"],
    ["asctime", "Sun Nov  6 08:49:35 1994"],
  ])("parses %s against the injected clock", (_format, value) => {
    const now = Date.parse("Sun, 06 Nov 1994 08:49:30 GMT");
    expect(parseRetryAfterAt(value, now, 5_000)).toBe(now + 5_000);
  });

  it.each([
    "Thu, 30 Jun 1994 23:59:60 GMT",
    "Thursday, 30-Jun-94 23:59:60 GMT",
    "Thu Jun 30 23:59:60 1994",
  ])("maps a valid leap second to the next UTC second (%s)", (value) => {
    const now = Date.parse("Thu, 30 Jun 1994 23:59:30 GMT");
    expect(parseRetryAfterAt(value, now, 60_000)).toBe(now + 30_000);
  });

  it.each([null, "", "  ", "tomorrow", "-1", "1.5"])(
    "ignores missing or malformed Retry-After values (%s)",
    (value) => {
      expect(parseRetryAfterAt(value, 10_000, 5_000)).toBeUndefined();
    },
  );

  it("ignores an HTTP date in the past", () => {
    const now = Date.parse("Mon, 01 Jan 2024 00:00:00 GMT");
    expect(parseRetryAfterAt("Sun, 31 Dec 2023 23:59:59 GMT", now, 5_000)).toBeUndefined();
  });

  it.each([
    "Mon, 06 Nov 1994 08:49:35 GMT",
    "Sunday, 6-Nov-94 08:49:35 GMT",
    "Sun Nov 6 08:49:35 1994",
    "Sun Nov  6 08:49:35 1994 GMT",
    "Sunday, 06-Nov-94 08:49:35 UTC",
    "Sun, 06 Nov 1994 08:49:60 GMT",
    "Sunday, 06-Nov-94 08:49:60 GMT",
    "Sun Nov  6 08:49:60 1994",
    "Sun, 06 Nov 1994 08:49:61 GMT",
    "Sunday, 06-Nov-94 08:49:61 GMT",
    "Sun Nov  6 08:49:61 1994",
  ])("rejects noncanonical or invalid HTTP dates (%s)", (value) => {
    const now = Date.parse("Sun, 06 Nov 1994 08:49:30 GMT");
    expect(parseRetryAfterAt(value, now, 5_000)).toBeUndefined();
  });

  it("applies the RFC850 two-digit-year rule relative to the injected clock", () => {
    const now = Date.parse("Thu, 01 Jan 2026 00:00:00 GMT");
    expect(parseRetryAfterAt("Saturday, 06-Nov-76 08:49:35 GMT", now, 5_000)).toBeUndefined();
    expect(parseRetryAfterAt("Wednesday, 01-Jan-76 00:00:00 GMT", now, 5_000)).toBe(now + 5_000);
  });

  it("uses Retry-After as a floor above exponential backoff and keeps the existing cap", () => {
    const state = createSchedulerTaskState();
    markSchedulerTaskFailure(state, "http_429", 0, 1_000, 1_000, 4_000, 3_000);
    expect(state.nextAttemptAt).toBe(3_000);

    markSchedulerTaskFailure(state, "http_429", 3_000, 1_000, 1_000, 4_000, 500);
    expect(state.nextAttemptAt).toBe(5_000);

    markSchedulerTaskFailure(state, "http_429", 5_000, 1_000, 1_000, 4_000, 60_000);
    expect(state.nextAttemptAt).toBe(9_000);
  });
});
