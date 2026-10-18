import { types as nodeTypes } from "node:util"
import { Type, type Static } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import { isCanonicalTaskGraphJobId } from "./task-graph-result-page-contract.js"

export const TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA = "agent-harness.v2.task-graph.historical-discovery-page.v1" as const
export const TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SIZE = 3
export const TASK_GRAPH_HISTORICAL_DISCOVERY_MAX_JOB_IDS = 24
export const TASK_GRAPH_HISTORICAL_DISCOVERY_MAX_OFFSET = TASK_GRAPH_HISTORICAL_DISCOVERY_MAX_JOB_IDS
const SOURCE_TOKEN_PATTERN = "^[0-9a-f]{64}(?![\\s\\S])"
const SourceToken = Type.String({ pattern: SOURCE_TOKEN_PATTERN })
const SourceResultStatus = Type.Literal("completed")

const RequestBase = { mode: Type.Literal("historical_discovery") }
const InitialRequest = Type.Object({ ...RequestBase, offset: Type.Literal(0), sourceToken: Type.Optional(SourceToken) }, { additionalProperties: false })
const ContinuationRequest = Type.Object({ ...RequestBase,
  offset: Type.Integer({ minimum: 1, maximum: TASK_GRAPH_HISTORICAL_DISCOVERY_MAX_OFFSET }), sourceToken: SourceToken,
}, { additionalProperties: false })
export const TaskGraphHistoricalDiscoveryPageRequestSchema = Type.Union([InitialRequest, ContinuationRequest])
export type TaskGraphHistoricalDiscoveryPageRequest = Readonly<{
  offset: number
  sourceToken?: string
}>

const Available = Type.Object({
  schemaVersion: Type.Literal(TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA), trust: Type.Literal("untrusted"),
  availability: Type.Literal("available"), observation: Type.Literal("historical_discovery"),
  verificationStatus: Type.Literal("unverified"), sourceToken: SourceToken,
  sourceResultStatus: SourceResultStatus, offset: Type.Integer({ minimum: 0, maximum: TASK_GRAPH_HISTORICAL_DISCOVERY_MAX_OFFSET }),
  nextOffset: Type.Union([Type.Integer({ minimum: 0, maximum: TASK_GRAPH_HISTORICAL_DISCOVERY_MAX_OFFSET }), Type.Null()]),
  totalCount: Type.Integer({ minimum: 1, maximum: TASK_GRAPH_HISTORICAL_DISCOVERY_MAX_JOB_IDS }), truncated: Type.Boolean(),
  items: Type.Array(Type.Object({ jobId: Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false }),
    { minItems: 1, maxItems: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SIZE }),
}, { additionalProperties: false })
const Unavailable = Type.Object({
  schemaVersion: Type.Literal(TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA), trust: Type.Literal("untrusted"),
  availability: Type.Literal("unavailable"), observation: Type.Literal("historical_discovery"),
  verificationStatus: Type.Literal("unverified"),
  reason: Type.Union([Type.Literal("no_source"), Type.Literal("source_changed"), Type.Literal("offset_out_of_range")]),
}, { additionalProperties: false })
export type TaskGraphHistoricalDiscoveryPage = Static<typeof Available> | Static<typeof Unavailable>
export type TaskGraphHistoricalDiscoveryAvailablePage = Static<typeof Available>
export const TaskGraphHistoricalDiscoveryPageSchema = Type.Union([Available, Unavailable])

export function parseTaskGraphHistoricalDiscoveryPageRequest(value: unknown): TaskGraphHistoricalDiscoveryPageRequest | null {
  if (!safeData(value) || !Value.Check(TaskGraphHistoricalDiscoveryPageRequestSchema, value)) return null
  const row = value as Record<string, unknown>
  if (!Number.isSafeInteger(row.offset)) return null
  return { offset: row.offset as number, ...(row.sourceToken === undefined ? {} : { sourceToken: row.sourceToken as string }) }
}

export function parseTaskGraphHistoricalDiscoveryPage(value: unknown): TaskGraphHistoricalDiscoveryPage | null {
  if (!safeData(value) || !Value.Check(TaskGraphHistoricalDiscoveryPageSchema, value)) return null
  const row = value as Record<string, unknown>
  if (row.availability === "unavailable") {
    return { schemaVersion: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "unavailable",
      observation: "historical_discovery", verificationStatus: "unverified",
      reason: row.reason as TaskGraphHistoricalDiscoveryPageUnavailable["reason"] }
  }
  const items = row.items as Array<{ jobId: string }>
  const totalCount = row.totalCount as number
  const offset = row.offset as number
  const nextOffset = offset + items.length < totalCount ? offset + items.length : null
  if (offset % TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SIZE !== 0 || offset >= totalCount
    || items.length !== Math.min(TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SIZE, totalCount - offset)
    || row.nextOffset !== nextOffset || row.truncated === true && totalCount !== TASK_GRAPH_HISTORICAL_DISCOVERY_MAX_JOB_IDS
    || items.some(item => !isCanonicalTaskGraphJobId(item.jobId))
    || new Set(items.map(item => item.jobId)).size !== items.length) return null
  return {
    schemaVersion: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "available",
    observation: "historical_discovery", verificationStatus: "unverified", sourceToken: row.sourceToken as string,
    sourceResultStatus: row.sourceResultStatus as "completed", offset, nextOffset, totalCount,
    truncated: row.truncated as boolean, items: items.map(item => ({ jobId: item.jobId })),
  }
}

type TaskGraphHistoricalDiscoveryPageUnavailable = Extract<TaskGraphHistoricalDiscoveryPage, { availability: "unavailable" }>

/** Reject proxies, accessors, symbols, sparse arrays and cycles before schema checks read properties. */
function safeData(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object" || nodeTypes.isProxy(value) || seen.has(value)) return false
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value)
      if (keys.length !== value.length + 1 || !keys.includes("length")) return false
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !("value" in descriptor) || !safeData(descriptor.value, seen)) return false
      }
      return keys.every(key => key === "length" || typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    return Reflect.ownKeys(value).every(key => {
      if (typeof key !== "string") return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return Boolean(descriptor?.enumerable && "value" in descriptor && safeData(descriptor.value, seen))
    })
  } catch { return false }
  finally { seen.delete(value) }
}
