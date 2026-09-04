import { randomUUID } from "node:crypto"

import { ObservabilityValidationError, type TraceContext } from "./types.js"

const MAX_TRACE_IDENTIFIER_LENGTH = 128
export const TRACE_ID_HEADER = "x-agent-trace-id"
export const PARENT_SPAN_ID_HEADER = "x-agent-parent-span-id"

export type TraceCarrier = { readonly traceId: string; readonly parentSpanId: string }
export type TraceHeaderReader = { readonly get: (name: string) => string | null }

export function createTraceContext(input: {
  readonly traceId?: string
  readonly spanId?: string
  readonly parentSpanId?: string | null
} = {}): TraceContext {
  const traceId = input.traceId ?? randomUUID()
  const spanId = input.spanId ?? randomUUID()
  assertTraceIdentifier(traceId, "traceId")
  assertTraceIdentifier(spanId, "spanId")
  if (input.parentSpanId !== undefined && input.parentSpanId !== null) assertTraceIdentifier(input.parentSpanId, "parentSpanId")
  return { traceId, spanId, parentSpanId: input.parentSpanId ?? null }
}

export function childTraceContext(parent: TraceContext): TraceContext {
  const normalized = createTraceContext(parent)
  return createTraceContext({ traceId: normalized.traceId, parentSpanId: normalized.spanId })
}

export function injectTraceContext(context: TraceContext): TraceCarrier {
  const normalized = createTraceContext(context)
  return { traceId: normalized.traceId, parentSpanId: normalized.spanId }
}

export function extractTraceContext(carrier: TraceCarrier, spanIdFactory: () => string = randomUUID): TraceContext {
  if (carrier === null || typeof carrier !== "object") throw new ObservabilityValidationError("trace carrier is required")
  assertTraceIdentifier(carrier.traceId, "traceId")
  assertTraceIdentifier(carrier.parentSpanId, "parentSpanId")
  return createTraceContext({ traceId: carrier.traceId, parentSpanId: carrier.parentSpanId, spanId: spanIdFactory() })
}

export function traceContextToHeaders(context: TraceContext): Record<string, string> {
  const carrier = injectTraceContext(context)
  return { [TRACE_ID_HEADER]: carrier.traceId, [PARENT_SPAN_ID_HEADER]: carrier.parentSpanId }
}

export function traceContextFromHeaders(headers: TraceHeaderReader, spanIdFactory: () => string = randomUUID): TraceContext | null {
  const traceId = headers.get(TRACE_ID_HEADER)
  const parentSpanId = headers.get(PARENT_SPAN_ID_HEADER)
  if (!traceId || !parentSpanId) return null
  return extractTraceContext({ traceId, parentSpanId }, spanIdFactory)
}

export function createRootTraceContext(input: { readonly idFactory?: () => string } = {}): TraceContext {
  const idFactory = input.idFactory ?? randomUUID
  return createTraceContext({ traceId: idFactory(), spanId: idFactory() })
}

export function createChildTraceContext(parent: TraceContext, idFactory: () => string = randomUUID): TraceContext {
  const normalized = createTraceContext(parent)
  return createTraceContext({ traceId: normalized.traceId, spanId: idFactory(), parentSpanId: normalized.spanId })
}

export function assertTraceContext(value: unknown): asserts value is TraceContext {
  if (value === null || typeof value !== "object") throw new ObservabilityValidationError("trace context is required")
  const candidate = value as Record<string, unknown>
  if (typeof candidate.traceId !== "string") throw new ObservabilityValidationError("traceId is required")
  if (typeof candidate.spanId !== "string") throw new ObservabilityValidationError("spanId is required")
  if (candidate.parentSpanId !== null && typeof candidate.parentSpanId !== "string") throw new ObservabilityValidationError("parentSpanId must be a string or null")
  assertTraceIdentifier(candidate.traceId, "traceId")
  assertTraceIdentifier(candidate.spanId, "spanId")
  if (candidate.parentSpanId !== null) assertTraceIdentifier(candidate.parentSpanId, "parentSpanId")
}

function assertTraceIdentifier(value: string, name: string): void {
  if (!value || value.length > MAX_TRACE_IDENTIFIER_LENGTH || /\s|[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ObservabilityValidationError(`${name} must be a non-empty opaque identifier`)
  }
}
