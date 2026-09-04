import { describe, expect, it } from "vitest"

import { USAGE_AGGREGATION_INTERVAL_MS, aggregateUsage, queryUsage, type UsageEventRecord } from "./usage-aggregator"

const records: UsageEventRecord[] = [
  { userId: "user-1", model: "MiniMax-M3", toolName: "jobs.search", sessionId: "session-1", turnId: "turn-1", traceId: "trace-1", inputTokens: 10, outputTokens: 5, costMicros: 20, occurredAt: "2026-01-01T23:59:00.000Z" },
  { userId: "user-1", model: "MiniMax-M3", toolName: "jobs.search", sessionId: "session-1", turnId: "turn-1", traceId: "trace-1", inputTokens: 4, outputTokens: 6, costMicros: 8, occurredAt: "2026-01-01T23:59:30.000Z" },
  { userId: "user-1", model: "MiniMax-M3", toolName: null, sessionId: "session-2", turnId: "turn-2", traceId: "trace-2", inputTokens: 2, outputTokens: 1, costMicros: 3, occurredAt: "2026-01-02T00:01:00.000Z" },
  { userId: "user-2", model: "MiniMax-M3", toolName: "jobs.search", sessionId: "session-3", turnId: null, traceId: "trace-3", inputTokens: 1, outputTokens: 1, costMicros: 2, occurredAt: "2026-01-01T12:00:00.000Z" },
]

describe("usage aggregation", () => {
  it("groups by user, model, tool, and UTC day with cost lineage counts", () => {
    const result = aggregateUsage(records)
    const search = result.find((row) => row.userId === "user-1" && row.toolName === "jobs.search" && row.day === "2026-01-01")
    expect(search).toMatchObject({ eventCount: 2, inputTokens: 14, outputTokens: 11, totalTokens: 25, costMicros: 28, sessionCount: 1, turnCount: 1, traceCount: 1 })
    expect(search?.lineage).toEqual([{ sessionId: "session-1", turnId: "turn-1", traceId: "trace-1", eventCount: 2, inputTokens: 14, outputTokens: 11, costMicros: 28 }])
    expect(result.find((row) => row.toolName === null)).toMatchObject({ day: "2026-01-02", costMicros: 3 })
    expect(JSON.stringify(result)).not.toMatch(/email|text|ip/i)
  })

  it("queries only the injected five-minute window and aggregates its rows", async () => {
    let requested: { from: Date; to: Date; userId?: string } | undefined
    const result = await queryUsage({ read: async (window) => { requested = window; return records.slice(0, 2) } }, { now: new Date("2026-01-01T00:10:00.000Z"), userId: "user-1" })
    expect(requested?.to).toEqual(new Date("2026-01-01T00:10:00.000Z"))
    expect(requested?.from).toEqual(new Date("2026-01-01T00:05:00.000Z"))
    expect(requested?.userId).toBe("user-1")
    expect(result).toHaveLength(1)
  })

  it("rejects invalid numeric usage values", () => {
    expect(() => aggregateUsage([{ ...records[0], costMicros: -1 }])).toThrow()
  })
})
