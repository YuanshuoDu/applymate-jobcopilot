export const TRACE_ID_HEADER = "x-agent-trace-id"
export const PARENT_SPAN_ID_HEADER = "x-agent-parent-span-id"

export interface TraceContext {
  traceId: string
  spanId: string
  parentSpanId: string | null
}

export interface TraceCarrier {
  traceId: string
  parentSpanId: string
}

export type TraceIdFactory = () => string

export interface CreateTraceContextInput {
  traceId?: string
  spanId?: string
  parentSpanId?: string | null
}

function defaultIdFactory(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function requireId(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

export function assertTraceContext(context: TraceContext): TraceContext {
  requireId(context.traceId, "traceId")
  requireId(context.spanId, "spanId")
  if (context.parentSpanId !== null) requireId(context.parentSpanId, "parentSpanId")
  return context
}

export function createRootTraceContext(idFactory: TraceIdFactory = defaultIdFactory): TraceContext {
  const traceId = requireId(idFactory(), "traceId")
  const spanId = requireId(idFactory(), "spanId")
  return { traceId, spanId, parentSpanId: null }
}

/** Compatible constructor for callers that receive an upstream carrier. */
export function createTraceContext(
  input: CreateTraceContextInput = {},
  idFactory: TraceIdFactory = defaultIdFactory,
): TraceContext {
  const traceId = requireId(input.traceId ?? idFactory(), "traceId")
  const spanId = requireId(input.spanId ?? idFactory(), "spanId")
  const parentSpanId = input.parentSpanId ?? null
  if (parentSpanId !== null) requireId(parentSpanId, "parentSpanId")
  return { traceId, spanId, parentSpanId }
}

export function createChildTraceContext(
  parent: TraceContext,
  idFactory: TraceIdFactory = defaultIdFactory,
): TraceContext {
  assertTraceContext(parent)
  return {
    traceId: parent.traceId,
    spanId: requireId(idFactory(), "spanId"),
    parentSpanId: parent.spanId,
  }
}

export const childTraceContext = createChildTraceContext

/** Creates the carrier sent to a downstream Worker/Web boundary. */
export function injectTraceContext(context: TraceContext): TraceCarrier {
  assertTraceContext(context)
  return { traceId: context.traceId, parentSpanId: context.spanId }
}

/** Starts a new receiving span while preserving the upstream trace lineage. */
export function extractTraceContext(
  carrier: TraceCarrier,
  idFactory: TraceIdFactory = defaultIdFactory,
): TraceContext {
  requireId(carrier.traceId, "traceId")
  requireId(carrier.parentSpanId, "parentSpanId")
  return {
    traceId: carrier.traceId,
    spanId: requireId(idFactory(), "spanId"),
    parentSpanId: carrier.parentSpanId,
  }
}

export function traceContextToHeaders(context: TraceContext): Record<string, string> {
  const carrier = injectTraceContext(context)
  return {
    [TRACE_ID_HEADER]: carrier.traceId,
    [PARENT_SPAN_ID_HEADER]: carrier.parentSpanId,
  }
}

export function traceContextFromHeaders(
  headers: { get(name: string): string | null },
  idFactory: TraceIdFactory = defaultIdFactory,
): TraceContext | null {
  const traceId = headers.get(TRACE_ID_HEADER)
  const parentSpanId = headers.get(PARENT_SPAN_ID_HEADER)
  if (!traceId || !parentSpanId) return null
  return extractTraceContext({ traceId, parentSpanId }, idFactory)
}
