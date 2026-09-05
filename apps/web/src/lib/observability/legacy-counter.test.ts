import { describe, expect, it } from "vitest"
import {
  LEGACY_TRAFFIC_KEYS,
  createLegacyTrafficCounter,
  isLegacyTrafficKey,
  legacyTrafficCounter,
  legacyTrafficSnapshot,
  recordLegacyTraffic,
} from "./legacy-counter"

describe("legacy traffic counter", () => {
  it("counts only fixed endpoint and stream dimensions", () => {
    const counter = createLegacyTrafficCounter()
    const now = new Date("2026-09-05T12:00:00.000Z")

    counter.hit("agent_run_endpoint", now)
    counter.hit("agent_stream_connect", "2026-09-04T12:00:00.000Z")

    expect(counter.snapshot(now)).toEqual({
      asOf: now.toISOString(),
      windowStart: "2026-08-29T12:00:00.000Z",
      windowEnd: now.toISOString(),
      total: 2,
      byKey: { agent_run_endpoint: 1, agent_chat_endpoint: 0, agent_stream_connect: 1 },
      windowTotal: 2,
      windowByKey: { agent_run_endpoint: 1, agent_chat_endpoint: 0, agent_stream_connect: 1 },
      lastHitAt: "2026-09-05T12:00:00.000Z",
      zeroForSevenDays: false,
    })
  })

  it("does not retain unbounded or PII-bearing metric labels", () => {
    const counter = createLegacyTrafficCounter()

    expect(() => counter.hit("/api/agent/run?email=candidate@example.com" as never)).toThrow("not supported")
    expect(counter.snapshot("2026-09-05T00:00:00.000Z").byKey).toEqual({
      agent_run_endpoint: 0,
      agent_chat_endpoint: 0,
      agent_stream_connect: 0,
    })
    expect(isLegacyTrafficKey("candidate@example.com")).toBe(false)
    expect(LEGACY_TRAFFIC_KEYS).toHaveLength(3)
  })

  it("reports a seven-day zero window while retaining all-time totals", () => {
    const counter = createLegacyTrafficCounter()
    counter.hit("agent_chat_endpoint", "2026-08-20T00:00:00.000Z")

    expect(counter.snapshot("2026-09-05T00:00:00.000Z")).toMatchObject({
      total: 1,
      windowTotal: 0,
      zeroForSevenDays: true,
      lastHitAt: "2026-08-20T00:00:00.000Z",
    })
  })

  it("uses exact timestamps instead of whole UTC-day buckets", () => {
    const counter = createLegacyTrafficCounter()
    const now = new Date("2026-09-05T12:00:00.000Z")

    counter.hit("agent_run_endpoint", "2026-08-29T11:59:59.999Z")
    counter.hit("agent_chat_endpoint", "2026-09-05T12:00:00.001Z")

    expect(counter.snapshot(now)).toMatchObject({
      windowTotal: 0,
      windowByKey: { agent_run_endpoint: 0, agent_chat_endpoint: 0, agent_stream_connect: 0 },
      zeroForSevenDays: true,
    })
  })

  it("provides a process-wide convenience counter for future callers", () => {
    const before = legacyTrafficSnapshot("2026-09-05T00:00:00.000Z")
    recordLegacyTraffic("agent_stream_connect", "2026-09-05T00:00:00.000Z")
    const after = legacyTrafficSnapshot("2026-09-05T00:00:00.000Z")

    expect(after.total).toBe(before.total + 1)
    expect(after.windowByKey.agent_stream_connect).toBe(before.windowByKey.agent_stream_connect + 1)
  })

  it("rejects invalid timestamps", () => {
    expect(() => createLegacyTrafficCounter().hit("agent_run_endpoint", "not-a-date")).toThrow("valid date")
  })
})
