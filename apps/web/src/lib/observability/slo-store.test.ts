import { describe, expect, it, vi } from "vitest"

import { persistSloEvaluation } from "./slo-store"
import { evaluateSloRules } from "./slo-rules"

describe("SLO alert persistence", () => {
  it("writes one redacted row for each rule and keeps pass rows closed", async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 4 })
    const evaluation = evaluateSloRules({
      turnLatenciesMs: [60_000], toolInvocations: 1, toolFailures: 0,
      approvalRequests: 1, approvalTimeouts: 0, submissionAttempts: 1, submissionFailures: 0,
    }, { trace: { traceId: "trace-1", spanId: "span-1", parentSpanId: null }, idFactory: (() => { let i = 0; return () => `id-${i++}` })() })
    await persistSloEvaluation(evaluation, { harnessSloAlert: { createMany } })
    expect(createMany).toHaveBeenCalledOnce()
    const rows = vi.mocked(createMany).mock.calls[0][0].data as Array<Record<string, unknown>>
    expect(rows).toHaveLength(4)
    expect(rows.find((row) => row.ruleKey === "turn_p95_latency_ms")).toMatchObject({ status: "open", value: 60_000 })
    expect(rows.every((row) => !("payload" in row) && !("message" in row))).toBe(true)
  })
})
