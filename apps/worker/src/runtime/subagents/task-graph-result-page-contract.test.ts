import { describe, expect, it } from "vitest"
import {
  TASK_GRAPH_RESULT_PAGE_SCHEMA, TASK_GRAPH_RESULT_PAGE_V1_SCHEMA, isCanonicalTaskGraphJobId,
  parseTaskGraphResultPage, parseTaskGraphResultPageV1,
  parseTaskGraphResultPageRequest,
} from "./task-graph-result-page-contract.js"

const UUID = "abcdefab-abcd-4abc-8abc-abcdefabcdef"
const CUID = "c123456789012345678901234"

describe("TaskGraph result page contract", () => {
  it("parses the exact bounded request and rejects mixed, extra, or unsafe shapes", () => {
    expect(parseTaskGraphResultPageRequest({ nodeKey: "scout-1", expectedRevision: 4, offset: 3 }))
      .toEqual({ nodeKey: "scout-1", expectedRevision: 4, offset: 3 })
    expect(parseTaskGraphResultPageRequest({ nodeKey: "scout-1", expectedRevision: 4, offset: 3, jobId: UUID })).toBeNull()
    expect(parseTaskGraphResultPageRequest({ nodeKey: "scout-1", expectedRevision: 2_147_483_647, offset: 0 })).toBeNull()
    expect(parseTaskGraphResultPageRequest({ nodeKey: "scout-1", expectedRevision: 4, offset: Number.MAX_SAFE_INTEGER + 1 })).toBeNull()

    let getterCalls = 0
    const getter = Object.defineProperty({}, "nodeKey", { enumerable: true, get: () => { getterCalls += 1; return "scout-1" } })
    expect(parseTaskGraphResultPageRequest(getter)).toBeNull()
    expect(getterCalls).toBe(0)
    expect(parseTaskGraphResultPageRequest(new Proxy({ nodeKey: "scout-1", expectedRevision: 4, offset: 0 }, {}))).toBeNull()
    expect(parseTaskGraphResultPageRequest(Object.assign({ nodeKey: "scout-1", expectedRevision: 4, offset: 0 }, { [Symbol("hidden")]: true }))).toBeNull()
  })

  it("accepts only canonical CUID v1 and lowercase UUID v4 job IDs", () => {
    expect(isCanonicalTaskGraphJobId(CUID)).toBe(true)
    expect(isCanonicalTaskGraphJobId(UUID)).toBe(true)
    expect(isCanonicalTaskGraphJobId(UUID.toUpperCase())).toBe(false)
    expect(isCanonicalTaskGraphJobId("00000000-0000-1000-8000-000000000000")).toBe(false)
    expect(isCanonicalTaskGraphJobId("job-123")).toBe(false)

    const page = {
      schemaVersion: TASK_GRAPH_RESULT_PAGE_SCHEMA, trust: "untrusted", availability: "available", graphRevision: 1,
      role: "scout", taskStatus: "completed", resultStatus: "completed", totalCount: 1, evidenceCount: 1,
      offset: 0, nextOffset: null, items: [{ jobId: CUID, source: "other", evidenceKinds: ["job"] }],
    }
    for (const invalidJobId of [`${CUID}\n`, `${UUID}\r\n`, `${CUID}x`]) {
      expect(isCanonicalTaskGraphJobId(invalidJobId)).toBe(false)
      expect(parseTaskGraphResultPage({ ...page, items: [{ ...page.items[0]!, jobId: invalidJobId }] })).toBeNull()
    }
  })

  it("reconstructs an exact public envelope and rejects altered or hostile output", () => {
    const page = {
      schemaVersion: TASK_GRAPH_RESULT_PAGE_SCHEMA, trust: "untrusted", availability: "available", graphRevision: 7,
      role: "analyst", taskStatus: "failed", resultStatus: "partial", totalCount: 1, evidenceCount: 2,
      offset: 0, nextOffset: null, items: [{ jobId: UUID, score: 8.5, evidenceKinds: ["job", "persona"] }],
    }
    expect(parseTaskGraphResultPage(page)).toEqual(page)
    expect(parseTaskGraphResultPage({ ...page, nextOffset: 1 })).toBeNull()
    expect(parseTaskGraphResultPage({ ...page, totalCount: 3 })).toBeNull()
    expect(parseTaskGraphResultPage({ ...page, privateSummary: "discarded?" })).toBeNull()
    expect(parseTaskGraphResultPage({ ...page, items: [{ ...page.items[0]!, jobId: "job-123" }] })).toBeNull()
    expect(parseTaskGraphResultPage({ ...page, items: [{ ...page.items[0]!, evidenceKinds: ["job", "job"] }] })).toBeNull()

    let getterCalls = 0
    const hostile = { ...page }
    Object.defineProperty(hostile, "role", { enumerable: true, get: () => { getterCalls += 1; return "analyst" } })
    expect(parseTaskGraphResultPage(hostile)).toBeNull()
    expect(getterCalls).toBe(0)
    expect(parseTaskGraphResultPage({ schemaVersion: TASK_GRAPH_RESULT_PAGE_SCHEMA, trust: "untrusted", availability: "unavailable",
      graphRevision: 0, reason: "no_graph" })).toEqual({ schemaVersion: TASK_GRAPH_RESULT_PAGE_SCHEMA, trust: "untrusted",
      availability: "unavailable", graphRevision: 0, reason: "no_graph" })
  })

  it("accepts only well-formed bounded summaries on completed Analyst offset-zero pages", () => {
    const analystPage = {
      schemaVersion: TASK_GRAPH_RESULT_PAGE_SCHEMA, trust: "untrusted", availability: "available", graphRevision: 7,
      role: "analyst", taskStatus: "completed", resultStatus: "completed", totalCount: 1, evidenceCount: 1,
      offset: 0, nextOffset: null, analysisSummary: "🌱".repeat(128), analysisSummaryTruncated: false,
      items: [{ jobId: CUID, score: 8, evidenceKinds: ["job"] }],
    }
    expect(parseTaskGraphResultPage(analystPage)).toEqual(analystPage)
    expect(parseTaskGraphResultPage({ ...analystPage, analysisSummary: "🌱".repeat(129) })).toBeNull()
    expect(parseTaskGraphResultPage({ ...analystPage, analysisSummary: "bad\ud800text" })).toBeNull()
    expect(parseTaskGraphResultPage({ ...analystPage, analysisSummaryTruncated: undefined })).toBeNull()
    expect(parseTaskGraphResultPage({ ...analystPage, totalCount: 4, offset: 3, nextOffset: null,
      items: [{ jobId: CUID, score: 8, evidenceKinds: ["job"] }] })).toBeNull()
    expect(parseTaskGraphResultPage({ ...analystPage, resultStatus: "partial" })).toBeNull()
    expect(parseTaskGraphResultPage({ ...analystPage, taskStatus: "failed" })).toBeNull()
    expect(parseTaskGraphResultPage({ ...analystPage, role: "scout", items: [{ jobId: CUID, source: "other", evidenceKinds: ["job"] }] })).toBeNull()
  })

  it("reads only exact v1 pages for historical compatibility, outside the v2 output schema", () => {
    const v1 = {
      schemaVersion: TASK_GRAPH_RESULT_PAGE_V1_SCHEMA, trust: "untrusted", availability: "available", graphRevision: 7,
      role: "analyst", taskStatus: "completed", resultStatus: "completed", totalCount: 1, evidenceCount: 1,
      offset: 0, nextOffset: null, items: [{ jobId: CUID, score: 8, evidenceKinds: ["job"] }],
    }
    expect(parseTaskGraphResultPageV1(v1)).toEqual(v1)
    expect(parseTaskGraphResultPage(v1)).toBeNull()
    expect(parseTaskGraphResultPageV1({ ...v1, analysisSummary: "not part of v1" })).toBeNull()
    expect(parseTaskGraphResultPageV1({ ...v1, schemaVersion: TASK_GRAPH_RESULT_PAGE_SCHEMA })).toBeNull()
  })

  it("rejects sparse arrays, symbol keys, proxies and cycles before validation reads them", () => {
    const page = {
      schemaVersion: TASK_GRAPH_RESULT_PAGE_SCHEMA, trust: "untrusted", availability: "available", graphRevision: 7,
      role: "scout", taskStatus: "completed", resultStatus: "completed", totalCount: 1, evidenceCount: 1,
      offset: 0, nextOffset: null, items: [{ jobId: CUID, source: "greenhouse", evidenceKinds: ["job"] }],
    }
    const sparse = { ...page, items: new Array(1) }
    expect(parseTaskGraphResultPage(sparse)).toBeNull()
    expect(parseTaskGraphResultPage(Object.assign({ ...page }, { [Symbol("extra")]: true }))).toBeNull()
    expect(parseTaskGraphResultPage(new Proxy(page, {}))).toBeNull()
    const cycle: Record<string, unknown> = { ...page }
    cycle.self = cycle
    expect(parseTaskGraphResultPage(cycle)).toBeNull()
  })
})
