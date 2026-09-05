import { describe, expect, it } from "vitest"

import {
  PARENT_SPAN_ID_HEADER,
  TRACE_ID_HEADER,
  createChildTraceContext,
  createTraceContext,
  createRootTraceContext,
  extractTraceContext,
  injectTraceContext,
  traceContextFromHeaders,
  traceContextToHeaders,
} from "./trace-context"

const ids = (() => { let index = 0; return () => `id-${index++}` })()

describe("trace context", () => {
  it("creates a stable root and linked child span", () => {
    const root = createRootTraceContext(ids)
    const child = createChildTraceContext(root, ids)
    expect(root).toEqual({ traceId: "id-0", spanId: "id-1", parentSpanId: null })
    expect(child).toEqual({ traceId: "id-0", spanId: "id-2", parentSpanId: "id-1" })
  })

  it("supports the worker-compatible constructor", () => {
    expect(createTraceContext({ traceId: "trace", spanId: "span", parentSpanId: "upstream" })).toEqual({
      traceId: "trace", spanId: "span", parentSpanId: "upstream",
    })
  })

  it("propagates a downstream parent across headers", () => {
    const root = createRootTraceContext(() => "root")
    const headers = traceContextToHeaders(root)
    expect(headers).toEqual({ [TRACE_ID_HEADER]: "root", [PARENT_SPAN_ID_HEADER]: "root" })
    const received = traceContextFromHeaders({ get: (name) => headers[name] ?? null }, () => "web-span")
    expect(received).toEqual({ traceId: "root", spanId: "web-span", parentSpanId: "root" })
  })

  it("rejects incomplete carriers and returns null when headers are absent", () => {
    expect(() => extractTraceContext({ traceId: "", parentSpanId: "upstream" }, () => "span")).toThrow()
    expect(traceContextFromHeaders({ get: () => null }, () => "span")).toBeNull()
  })
})
