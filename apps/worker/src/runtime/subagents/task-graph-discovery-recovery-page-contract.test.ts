import { describe, expect, it, vi } from "vitest"
import {
  TASK_GRAPH_DISCOVERY_RECOVERY_PAGE_SCHEMA, parseTaskGraphDiscoveryRecoveryPage,
  parseTaskGraphDiscoveryRecoveryPageRequest,
} from "./task-graph-discovery-recovery-page-contract.js"

const id = (index: number) => `c${String(index).padStart(24, "0")}`
const request = { mode: "discovery_recovery", nodeKey: "scout-a", expectedRevision: 8, offset: 0 }
const firstPage = {
  schemaVersion: TASK_GRAPH_DISCOVERY_RECOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "available",
  observation: "partial_discovery", verificationStatus: "unverified", graphRevision: 8, attemptCount: 3,
  taskStatus: "failed", totalCount: 4, offset: 0, nextOffset: 3, truncated: false,
  items: [{ jobId: id(1) }, { jobId: id(2) }, { jobId: id(3) }],
}

describe("TaskGraph discovery-recovery page contract", () => {
  it("accepts only the exact start and attempt-pinned continuation modes", () => {
    expect(parseTaskGraphDiscoveryRecoveryPageRequest(request)).toEqual(request)
    expect(parseTaskGraphDiscoveryRecoveryPageRequest({ ...request, expectedAttemptCount: 3 })).toEqual({ ...request, expectedAttemptCount: 3 })
    expect(parseTaskGraphDiscoveryRecoveryPageRequest({ ...request, offset: 3 })).toBeNull()
    expect(parseTaskGraphDiscoveryRecoveryPageRequest({ ...request, offset: 3, expectedAttemptCount: 3 })).toEqual({ ...request, offset: 3, expectedAttemptCount: 3 })
    for (const invalid of [
      { ...request, mode: "result_page" }, { ...request, offset: 1, expectedAttemptCount: 3 },
      { ...request, offset: 24, expectedAttemptCount: 3 }, { ...request, expectedAttemptCount: 0 },
      { ...request, offset: 25, expectedAttemptCount: 3 }, { ...request, offset: 1, expectedAttemptCount: 1_000_001 },
      { ...request, taskId: "forged" }, { ...request, expectedAttemptCount: 2, extra: true },
    ]) expect(parseTaskGraphDiscoveryRecoveryPageRequest(invalid)).toBeNull()
  })

  it("validates bounded ID-only pages and their paging/truncation arithmetic", () => {
    expect(parseTaskGraphDiscoveryRecoveryPage(firstPage)).toMatchObject({ availability: "available", items: firstPage.items, nextOffset: 3 })
    expect(parseTaskGraphDiscoveryRecoveryPage({ ...firstPage, offset: 3, nextOffset: null, items: [{ jobId: id(4) }] }))
      .toMatchObject({ offset: 3, nextOffset: null, items: [{ jobId: id(4) }] })
    expect(parseTaskGraphDiscoveryRecoveryPage({ ...firstPage, totalCount: 24, truncated: true }))
      .toMatchObject({ totalCount: 24, truncated: true })
    for (const invalid of [
      { ...firstPage, score: 8 }, { ...firstPage, items: [{ jobId: "not-canonical" }, ...firstPage.items.slice(1)] },
      { ...firstPage, items: [{ jobId: id(1) }, { jobId: id(1) }, { jobId: id(3) }] },
      { ...firstPage, attemptCount: 0 }, { ...firstPage, taskStatus: "completed" },
      { ...firstPage, totalCount: 25 }, { ...firstPage, truncated: true },
      { ...firstPage, nextOffset: null }, { ...firstPage, offset: 1 },
      { ...firstPage, items: [...firstPage.items, { jobId: id(4) }] },
    ]) expect(parseTaskGraphDiscoveryRecoveryPage(invalid)).toBeNull()
  })

  it("keeps unavailable outcomes fixed and rejects accessors without executing them", () => {
    const unavailable = { schemaVersion: TASK_GRAPH_DISCOVERY_RECOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "unavailable",
      graphRevision: 8, reason: "recovery_unavailable" }
    expect(parseTaskGraphDiscoveryRecoveryPage(unavailable)).toEqual(unavailable)
    expect(parseTaskGraphDiscoveryRecoveryPage({ ...unavailable, jobIds: [id(1)] })).toBeNull()
    const getter = vi.fn(() => request.expectedRevision)
    const malformed = { ...request }
    Object.defineProperty(malformed, "expectedRevision", { enumerable: true, get: getter })
    expect(parseTaskGraphDiscoveryRecoveryPageRequest(malformed)).toBeNull()
    expect(getter).not.toHaveBeenCalled()
  })
})
