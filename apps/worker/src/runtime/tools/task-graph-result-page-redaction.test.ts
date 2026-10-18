import { describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_RESULT_PAGE_SCHEMA, type TaskGraphResultPage } from "../subagents/task-graph-result-page-contract.js"
import { TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA } from "../subagents/task-graph-historical-discovery-page-contract.js"
import { isTaskGraphResultPageLike, prepareAgentListLifecycleInput, prepareTaskGraphResultPageOutput } from "./task-graph-result-page-redaction.js"

const numericUuid = "00000000-0000-4000-8000-000000000000"
const page: TaskGraphResultPage = {
  schemaVersion: TASK_GRAPH_RESULT_PAGE_SCHEMA, trust: "untrusted", availability: "available", graphRevision: 5,
  role: "analyst", taskStatus: "failed", resultStatus: "partial", totalCount: 4, evidenceCount: 7,
  offset: 3, nextOffset: null, items: [{ jobId: numericUuid, score: 8.5, evidenceKinds: ["job", "source"] }],
}
const historicalToken = "a".repeat(64)
const historicalPage = {
  schemaVersion: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "available",
  observation: "historical_discovery", verificationStatus: "unverified", sourceToken: historicalToken,
  sourceResultStatus: "completed", offset: 0, nextOffset: null, totalCount: 1, truncated: false,
  items: [{ jobId: numericUuid }],
}

describe("TaskGraph result-page lifecycle redaction", () => {
  it("restores only canonical item job IDs after generic redaction", () => {
    const prepared = prepareTaskGraphResultPageOutput(page)
    expect(prepared.safe).toMatchObject({ availability: "available", graphRevision: 5, items: [{ jobId: numericUuid }] })
  })

  it("accepts strict unavailable pages without introducing item fields", () => {
    const prepared = prepareTaskGraphResultPageOutput({
      schemaVersion: TASK_GRAPH_RESULT_PAGE_SCHEMA, trust: "untrusted", availability: "unavailable",
      graphRevision: 6, reason: "revision_mismatch",
    })
    expect(prepared.safe).toEqual({ schemaVersion: TASK_GRAPH_RESULT_PAGE_SCHEMA, trust: "untrusted", availability: "unavailable", graphRevision: 6, reason: "revision_mismatch" })
  })

  it("rejects extra PII before it can bypass redaction", () => {
    expect(() => prepareTaskGraphResultPageOutput({ ...page, email: "candidate@example.com" })).toThrow()
  })

  it("rejects accessors without executing them", () => {
    const getter = vi.fn(() => "untrusted")
    const malformed = { ...page }
    Object.defineProperty(malformed, "trust", { enumerable: true, get: getter })
    expect(() => prepareTaskGraphResultPageOutput(malformed)).toThrow()
    expect(getter).not.toHaveBeenCalled()
  })

  it("rejects symbols and proxies before inspecting their contents", () => {
    expect(() => prepareTaskGraphResultPageOutput({ ...page, [Symbol("extra")]: true })).toThrow()
    const trap = vi.fn(() => { throw new Error("proxy trap executed") })
    const proxy = new Proxy(page, { ownKeys: trap, get: trap, getOwnPropertyDescriptor: trap })
    expect(isTaskGraphResultPageLike(proxy)).toBe(true)
    expect(() => prepareTaskGraphResultPageOutput(proxy)).toThrow()
    expect(trap).not.toHaveBeenCalled()
  })

  it("classifies malformed page markers for the fail-closed agent.list lifecycle path", () => {
    expect(isTaskGraphResultPageLike({ schemaVersion: TASK_GRAPH_RESULT_PAGE_SCHEMA, email: "secret@example.com" })).toBe(true)
    expect(isTaskGraphResultPageLike({ tasks: [] })).toBe(false)
  })

  it("classifies and safely records valid or malformed historical discovery inputs as page mode", () => {
    expect(prepareAgentListLifecycleInput({ mode: "historical_discovery", offset: 0 }, 4_000)).toEqual({
      pageRequest: true, safeInput: { mode: "historical_discovery", offset: 0 },
    })
    expect(prepareAgentListLifecycleInput({ mode: "historical_discovery", offset: 3, sourceToken: historicalToken }, 4_000)).toEqual({
      pageRequest: true, safeInput: { mode: "historical_discovery", offset: 3, sourceToken: "[REDACTED]" },
    })
    expect(prepareAgentListLifecycleInput({ mode: "historical_discovery", offset: 3 }, 4_000).pageRequest).toBe(true)
    expect(isTaskGraphResultPageLike({ schemaVersion: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA, email: "secret@example.com" })).toBe(true)
    expect(isTaskGraphResultPageLike({ observation: "historical_discovery", verificationStatus: "unverified" })).toBe(true)
  })

  it("preserves only the validated historical page envelope and initial token through redaction", () => {
    expect(prepareTaskGraphResultPageOutput(historicalPage).safe).toEqual(historicalPage)
    const unavailable = {
      schemaVersion: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "unavailable",
      observation: "historical_discovery", verificationStatus: "unverified", reason: "no_source",
    }
    expect(prepareTaskGraphResultPageOutput(unavailable).safe).toEqual(unavailable)
    expect(() => prepareTaskGraphResultPageOutput({ ...historicalPage, email: "secret@example.com" })).toThrow()
    expect(() => prepareTaskGraphResultPageOutput({ ...historicalPage, observation: "current" })).toThrow()
  })
})
