import { describe, expect, it } from "vitest"

import { assertTraceContext, childTraceContext, createTraceContext, extractTraceContext, injectTraceContext, traceContextFromHeaders, traceContextToHeaders } from "./trace-context.js"
import { ObservabilityValidationError } from "./types.js"

describe("Worker observability trace context", () => {
  it("creates a root and propagates the parent span to a child", () => {
    const root = createTraceContext({ traceId: "trace-1", spanId: "span-1" })
    const child = childTraceContext(root)
    expect(root).toEqual({ traceId: "trace-1", spanId: "span-1", parentSpanId: null })
    expect(child.traceId).toBe(root.traceId)
    expect(child.parentSpanId).toBe(root.spanId)
    expect(child.spanId).not.toBe(root.spanId)
  })

  it("validates all fields at a Worker/Web boundary", () => {
    expect(() => assertTraceContext({ traceId: "trace-1", spanId: "span-1", parentSpanId: null })).not.toThrow()
    expect(() => assertTraceContext({ traceId: "", spanId: "span-1", parentSpanId: null })).toThrow(ObservabilityValidationError)
    expect(() => assertTraceContext({ traceId: "trace-1", spanId: "span-1", parentSpanId: 7 })).toThrow(ObservabilityValidationError)
    expect(() => createTraceContext({ traceId: "trace with whitespace" })).toThrow(ObservabilityValidationError)
  })

  it("injects the current span and extracts a receiving span without losing the trace", () => {
    const upstream = createTraceContext({ traceId: "trace-1", spanId: "span-upstream" })
    const carrier = injectTraceContext(upstream)
    expect(carrier).toEqual({ traceId: "trace-1", parentSpanId: "span-upstream" })
    expect(traceContextToHeaders(upstream)).toEqual({ "x-agent-trace-id": "trace-1", "x-agent-parent-span-id": "span-upstream" })
    const receiving = extractTraceContext(carrier, () => "span-worker")
    expect(receiving).toEqual({ traceId: "trace-1", spanId: "span-worker", parentSpanId: "span-upstream" })
    expect(traceContextFromHeaders({ get: (name) => traceContextToHeaders(upstream)[name] ?? null }, () => "span-web")).toEqual({
      traceId: "trace-1", spanId: "span-web", parentSpanId: "span-upstream",
    })
  })
})
