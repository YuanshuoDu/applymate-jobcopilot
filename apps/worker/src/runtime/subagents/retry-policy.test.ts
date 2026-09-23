import { describe, expect, it } from "vitest"

import {
  computeSubagentNextAttemptAt,
  isSubagentRetryDue,
  subagentRetryDelayMs,
  SUBAGENT_RETRY_MAX_DELAY_MS,
} from "./retry-policy.js"

const now = new Date("2026-09-14T00:00:00.000Z")

describe("subagent retry policy", () => {
  it("uses deterministic exponential delays with a cap", () => {
    expect([1, 2, 3, 4].map(subagentRetryDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000])
    expect(subagentRetryDelayMs(7)).toBe(SUBAGENT_RETRY_MAX_DELAY_MS)
  })

  it("computes a durable eligibility Date from the failed attempt", () => {
    expect(computeSubagentNextAttemptAt(2, now)).toEqual(new Date("2026-09-14T00:00:02.000Z"))
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects an invalid attempt count: %s", attempt => {
    expect(() => subagentRetryDelayMs(attempt)).toThrow(RangeError)
    expect(() => computeSubagentNextAttemptAt(attempt, now)).toThrow(RangeError)
  })

  it("treats a missing eligibility time as due and a future time as not due", () => {
    expect(isSubagentRetryDue(null, now)).toBe(true)
    expect(isSubagentRetryDue(undefined, now)).toBe(true)
    expect(isSubagentRetryDue(new Date(now.getTime() + 1), now)).toBe(false)
    expect(isSubagentRetryDue(new Date(now.getTime()), now)).toBe(true)
  })
})
