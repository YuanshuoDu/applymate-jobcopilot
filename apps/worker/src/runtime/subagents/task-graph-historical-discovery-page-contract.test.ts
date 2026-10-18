import { describe, expect, it } from "vitest"
import {
  TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA, parseTaskGraphHistoricalDiscoveryPage,
  parseTaskGraphHistoricalDiscoveryPageRequest,
} from "./task-graph-historical-discovery-page-contract.js"

const token = "a".repeat(64)
const firstId = "c123456789012345678901234"
const secondId = "00000000-0000-4000-8000-000000000000"
const request = { mode: "historical_discovery", offset: 0 } as const
const page = {
  schemaVersion: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "available",
  observation: "historical_discovery", verificationStatus: "unverified", sourceToken: token,
  sourceResultStatus: "partial", offset: 0, nextOffset: null, totalCount: 2, truncated: false,
  items: [{ jobId: firstId }, { jobId: secondId }],
} as const

describe("historical discovery page contract", () => {
  it("parses initial selection and token-pinned continuations, rejecting caller-selected identities", () => {
    expect(parseTaskGraphHistoricalDiscoveryPageRequest(request)).toEqual(request)
    expect(parseTaskGraphHistoricalDiscoveryPageRequest({ ...request, sourceToken: token }))
      .toEqual({ ...request, sourceToken: token })
    expect(parseTaskGraphHistoricalDiscoveryPageRequest({ ...request, offset: 3, sourceToken: token }))
      .toEqual({ mode: "historical_discovery", offset: 3, sourceToken: token })
    for (const invalid of [
      { ...request, offset: 1 }, { ...request, offset: 25, sourceToken: token },
      { ...request, sourceToken: "A".repeat(64) }, { ...request, sourceToken: `${token}\n` },
      { ...request, sourceToken: token, taskId: "old-task" }, { ...request, sourceToken: token, turnId: "old-turn" },
      { ...request, sourceToken: token, nodeKey: "old-node" }, { ...request, sourceToken: token, expectedRevision: 4 },
      { ...request, includeTerminal: true }, { ...request, mode: "discovery_recovery" },
    ]) expect(parseTaskGraphHistoricalDiscoveryPageRequest(invalid)).toBeNull()
    let getterCalls = 0
    const getter = Object.defineProperty({}, "mode", { enumerable: true, get: () => { getterCalls += 1; return "historical_discovery" } })
    expect(parseTaskGraphHistoricalDiscoveryPageRequest(getter)).toBeNull()
    expect(getterCalls).toBe(0)
    expect(parseTaskGraphHistoricalDiscoveryPageRequest(new Proxy(request, {}))).toBeNull()
  })

  it("accepts only a closed untrusted historical-ID page with valid pagination", () => {
    expect(parseTaskGraphHistoricalDiscoveryPage(page)).toEqual(page)
    expect(parseTaskGraphHistoricalDiscoveryPage({ ...page, offset: 1, nextOffset: null })).toBeNull()
    expect(parseTaskGraphHistoricalDiscoveryPage({ ...page, totalCount: 3 })).toBeNull()
    expect(parseTaskGraphHistoricalDiscoveryPage({ ...page, sourceToken: "not-a-token" })).toBeNull()
    expect(parseTaskGraphHistoricalDiscoveryPage({ ...page, sourceResultStatus: "failed" })).toBeNull()
    expect(parseTaskGraphHistoricalDiscoveryPage({ ...page, evidence: [{ jobId: firstId }] })).toBeNull()
    expect(parseTaskGraphHistoricalDiscoveryPage({ ...page, items: [{ jobId: "job-123" }] })).toBeNull()
    expect(parseTaskGraphHistoricalDiscoveryPage({ ...page, items: [{ jobId: firstId }, { jobId: firstId }] })).toBeNull()
    expect(parseTaskGraphHistoricalDiscoveryPage({ ...page, truncated: true })).toBeNull()
    expect(parseTaskGraphHistoricalDiscoveryPage({ schemaVersion: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA,
      trust: "untrusted", availability: "unavailable", reason: "source_changed" })).toEqual({
      schemaVersion: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "unavailable", reason: "source_changed",
    })
  })

  it("enforces 3-ID pages and allows an exact 24-ID capture without truncation", () => {
    const ids = Array.from({ length: 24 }, (_, index) => `c${String(index).padStart(24, "0")}`)
    const full = { ...page, sourceResultStatus: "completed", totalCount: 24, offset: 21, items: ids.slice(21).map(jobId => ({ jobId })),
      nextOffset: null, truncated: false }
    expect(parseTaskGraphHistoricalDiscoveryPage(full)).toEqual(full)
    expect(parseTaskGraphHistoricalDiscoveryPage({ ...full, truncated: true })).toMatchObject({ availability: "available", truncated: true })
    expect(parseTaskGraphHistoricalDiscoveryPage({ ...full, offset: 20, items: ids.slice(20, 24).map(jobId => ({ jobId })) })).toBeNull()
  })

  it("rejects sparse, symbol-keyed and cyclic result envelopes", () => {
    expect(parseTaskGraphHistoricalDiscoveryPage({ ...page, items: new Array(2) })).toBeNull()
    expect(parseTaskGraphHistoricalDiscoveryPage(Object.assign({ ...page }, { [Symbol("extra")]: true }))).toBeNull()
    const cycle: Record<string, unknown> = { ...page }
    cycle.self = cycle
    expect(parseTaskGraphHistoricalDiscoveryPage(cycle)).toBeNull()
  })
})
