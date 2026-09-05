import { describe, expect, it } from "vitest"

import { calculateP95, evaluateSloRules, runSyntheticLatencyBreachDrill } from "./slo-rules"

const healthyWindow = {
  turnLatenciesMs: [100, 500, 1_000],
  toolInvocations: 100,
  toolFailures: 1,
  approvalRequests: 100,
  approvalTimeouts: 5,
  submissionAttempts: 100,
  submissionFailures: 2,
}

describe("Harness SLO rules", () => {
  it("evaluates all four rules and preserves zero-denominator pass semantics", () => {
    const result = evaluateSloRules({
      turnLatenciesMs: [], toolInvocations: 0, toolFailures: 0, approvalRequests: 0,
      approvalTimeouts: 0, submissionAttempts: 0, submissionFailures: 0,
    }, { evaluatedAt: "2026-01-01T00:00:00.000Z", trace: { traceId: "trace", spanId: "span", parentSpanId: null }, idFactory: (() => { let i = 0; return () => `alert-${i++}` })() })
    expect(result.alerts).toHaveLength(4)
    expect(result.alerts.every((alert) => alert.status === "pass")).toBe(true)
    expect(result.alerts.every((alert) => alert.traceId === "trace" && alert.parentSpanId === "span" && alert.spanId !== "span")).toBe(true)
  })

  it("passes exactly at the configured thresholds", () => {
    const result = evaluateSloRules(healthyWindow, { trace: { traceId: "trace", spanId: "span", parentSpanId: "parent" } })
    expect(result.breached).toBe(false)
    expect(result.alerts.map((alert) => alert.observedValue)).toEqual([1_000, 0.01, 0.05, 0.02])
  })

  it("detects a deterministic 60-second p95 breach", () => {
    const result = runSyntheticLatencyBreachDrill()
    expect(result.breached).toBe(true)
    expect(result.alerts.find((alert) => alert.ruleId === "turn_p95_latency_ms")).toMatchObject({ status: "breach", observedValue: 60_000, threshold: 30_000 })
  })

  it("uses nearest-rank p95 without mutating input", () => {
    const values = [30, 10, 20]
    expect(calculateP95(values)).toBe(30)
    expect(values).toEqual([30, 10, 20])
  })
})
