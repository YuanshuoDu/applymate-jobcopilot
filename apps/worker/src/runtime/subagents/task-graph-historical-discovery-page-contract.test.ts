import { describe, expect, it, vi } from "vitest"
import {
  TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA,
  parseTaskGraphHistoricalDiscoveryPage,
  parseTaskGraphHistoricalDiscoveryPageRequest,
} from "./task-graph-historical-discovery-page-contract.js"

const jobId = (index: number) => `c${String(index).padStart(24, "0")}`
const sourceToken = "a".repeat(64)
const toolRequest = { mode: "historical_discovery", offset: 0 }
const firstPage = {
  schemaVersion: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "available",
  observation: "historical_discovery", verificationStatus: "unverified", sourceToken,
  sourceResultStatus: "completed", totalCount: 4, offset: 0, nextOffset: 3, truncated: false,
  items: [{ jobId: jobId(1) }, { jobId: jobId(2) }, { jobId: jobId(3) }],
}

describe("TaskGraph historical-discovery page contract", () => {
  it("accepts only the initial and token-bound continuation request modes", () => {
    expect(parseTaskGraphHistoricalDiscoveryPageRequest(toolRequest)).toEqual({ offset: 0 })
    expect(parseTaskGraphHistoricalDiscoveryPageRequest({ ...toolRequest, sourceToken })).toEqual({ offset: 0, sourceToken })
    expect(parseTaskGraphHistoricalDiscoveryPageRequest({ mode: "historical_discovery", offset: 3, sourceToken }))
      .toEqual({ offset: 3, sourceToken })
    for (const invalid of [
      { mode: "historical_discovery", offset: 1 },
      { mode: "historical_discovery", offset: 0, sourceToken: "A".repeat(64) },
      { mode: "historical_discovery", offset: 25, sourceToken },
      { ...toolRequest, sourceToken: `${sourceToken}0` },
      { ...toolRequest, oldTurnId: "forged" },
      { ...toolRequest, rootTaskId: "forged" },
      { ...toolRequest, nodeKey: "forged" },
      { ...toolRequest, includeTerminal: true },
      { mode: "discovery_recovery", offset: 0 },
    ]) expect(parseTaskGraphHistoricalDiscoveryPageRequest(invalid)).toBeNull()
  })

  it("validates closed canonical pages and exact page arithmetic", () => {
    expect(parseTaskGraphHistoricalDiscoveryPage(firstPage)).toMatchObject({
      availability: "available", observation: "historical_discovery", verificationStatus: "unverified",
      sourceToken, sourceResultStatus: "completed", totalCount: 4, offset: 0, nextOffset: 3,
    })
    expect(parseTaskGraphHistoricalDiscoveryPage({ ...firstPage, offset: 3, nextOffset: null, items: [{ jobId: jobId(4) }] }))
      .toMatchObject({ offset: 3, nextOffset: null, items: [{ jobId: jobId(4) }] })
    expect(parseTaskGraphHistoricalDiscoveryPage({
      ...firstPage, totalCount: 24, truncated: true,
    })).toMatchObject({ totalCount: 24, truncated: true })
    for (const invalid of [
      { ...firstPage, sourceToken: "not-a-token" },
      { ...firstPage, sourceResultStatus: "failed" },
      { ...firstPage, sourceResultStatus: "partial" },
      { ...firstPage, sourceTaskId: "private-source" },
      { ...firstPage, evidence: [{ id: "private-evidence" }] },
      { ...firstPage, offset: 1 },
      { ...firstPage, nextOffset: null },
      { ...firstPage, truncated: true, totalCount: 4 },
      { ...firstPage, truncated: true, totalCount: 24, nextOffset: 6 },
      { ...firstPage, items: [{ jobId: jobId(1) }, { jobId: jobId(1) }, { jobId: jobId(3) }] },
      { ...firstPage, items: [{ jobId: "not-canonical" }, ...firstPage.items.slice(1)] },
      { ...firstPage, items: [] },
      { ...firstPage, ...{ score: 8 } },
    ]) expect(parseTaskGraphHistoricalDiscoveryPage(invalid)).toBeNull()
  })

  it("keeps unavailable outcomes fixed and does not turn an empty page into zero jobs", () => {
    for (const reason of ["no_source", "source_changed", "offset_out_of_range"] as const) {
      expect(parseTaskGraphHistoricalDiscoveryPage({
        schemaVersion: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "unavailable",
        observation: "historical_discovery", verificationStatus: "unverified", reason,
      })).toEqual({ schemaVersion: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "unavailable",
        observation: "historical_discovery", verificationStatus: "unverified", reason })
    }
    expect(parseTaskGraphHistoricalDiscoveryPage({ ...firstPage, totalCount: 0, items: [], nextOffset: null })).toBeNull()
    expect(parseTaskGraphHistoricalDiscoveryPage({
      schemaVersion: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "unavailable",
      observation: "historical_discovery", verificationStatus: "unverified", reason: "no_source", sourceRootId: "private-root",
    })).toBeNull()
  })

  it("rejects accessors and proxies without executing them", () => {
    const getter = vi.fn(() => 0)
    const malformed = { ...toolRequest }
    Object.defineProperty(malformed, "offset", { enumerable: true, get: getter })
    expect(parseTaskGraphHistoricalDiscoveryPageRequest(malformed)).toBeNull()
    expect(getter).not.toHaveBeenCalled()

    const trap = vi.fn(() => { throw new Error("proxy trap executed") })
    const proxy = new Proxy(firstPage, { ownKeys: trap, get: trap, getOwnPropertyDescriptor: trap })
    expect(parseTaskGraphHistoricalDiscoveryPage(proxy)).toBeNull()
    expect(trap).not.toHaveBeenCalled()
  })
})
