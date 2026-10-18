import { types as nodeTypes } from "node:util"
import { Type, type Static } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import { isCanonicalTaskGraphJobId } from "./task-graph-result-page-contract.js"

export const TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA = "agent-harness.v2.task-graph.historical-discovery-page.v1" as const
export const TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SIZE = 3
export const TASK_GRAPH_HISTORICAL_DISCOVERY_MAX_JOB_IDS = 24
const TOKEN_PATTERN = "^[a-f0-9]{64}(?![\\s\\S])"
const Token = Type.String({ pattern: TOKEN_PATTERN })
const Offset = Type.Integer({ minimum: 0, maximum: TASK_GRAPH_HISTORICAL_DISCOVERY_MAX_JOB_IDS })
const InitialRequest = Type.Object({ mode: Type.Literal("historical_discovery"), offset: Type.Literal(0), sourceToken: Type.Optional(Token) }, { additionalProperties: false })
const ContinuationRequest = Type.Object({ mode: Type.Literal("historical_discovery"), offset: Type.Integer({ minimum: 1, maximum: TASK_GRAPH_HISTORICAL_DISCOVERY_MAX_JOB_IDS }), sourceToken: Token }, { additionalProperties: false })
export const TaskGraphHistoricalDiscoveryPageRequestSchema = Type.Union([InitialRequest, ContinuationRequest])
export type TaskGraphHistoricalDiscoveryPageRequest = Readonly<Static<typeof TaskGraphHistoricalDiscoveryPageRequestSchema>>

const Item = Type.Object({ jobId: Type.String({ pattern: "^(?:c[a-z0-9]{24}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?![\\s\\S])" }) }, { additionalProperties: false })
const Available = Type.Object({
  schemaVersion: Type.Literal(TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA), trust: Type.Literal("untrusted"),
  availability: Type.Literal("available"), observation: Type.Literal("historical_discovery"), verificationStatus: Type.Literal("unverified"),
  sourceToken: Token, sourceResultStatus: Type.Union([Type.Literal("completed"), Type.Literal("partial")]),
  offset: Offset, nextOffset: Type.Union([Offset, Type.Null()]),
  totalCount: Type.Integer({ minimum: 1, maximum: TASK_GRAPH_HISTORICAL_DISCOVERY_MAX_JOB_IDS }), truncated: Type.Boolean(),
  items: Type.Array(Item, { minItems: 1, maxItems: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SIZE }),
}, { additionalProperties: false })
const Unavailable = Type.Object({
  schemaVersion: Type.Literal(TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA), trust: Type.Literal("untrusted"),
  availability: Type.Literal("unavailable"),
  reason: Type.Union([Type.Literal("no_source"), Type.Literal("source_changed"), Type.Literal("offset_out_of_range")]),
}, { additionalProperties: false })
export type TaskGraphHistoricalDiscoveryPageAvailable = Static<typeof Available>
export type TaskGraphHistoricalDiscoveryPageUnavailable = Static<typeof Unavailable>
export type TaskGraphHistoricalDiscoveryPage = TaskGraphHistoricalDiscoveryPageAvailable | TaskGraphHistoricalDiscoveryPageUnavailable
export const TaskGraphHistoricalDiscoveryPageSchema = Type.Union([Available, Unavailable])

export function parseTaskGraphHistoricalDiscoveryPageRequest(value: unknown): TaskGraphHistoricalDiscoveryPageRequest | null {
  if (!safeData(value) || !Value.Check(TaskGraphHistoricalDiscoveryPageRequestSchema, value)) return null
  const row = value as Record<string, unknown>
  if (!Number.isSafeInteger(row.offset)) return null
  if (row.offset === 0) return { mode: "historical_discovery", offset: 0,
    ...(row.sourceToken === undefined ? {} : { sourceToken: row.sourceToken as string }) }
  return { mode: "historical_discovery", offset: row.offset as number, sourceToken: row.sourceToken as string }
}

export function parseTaskGraphHistoricalDiscoveryPage(value: unknown): TaskGraphHistoricalDiscoveryPage | null {
  if (!safeData(value) || !Value.Check(TaskGraphHistoricalDiscoveryPageSchema, value)) return null
  const row = value as Record<string, unknown>
  if (row.availability === "unavailable") return {
    schemaVersion: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "unavailable",
    reason: row.reason as TaskGraphHistoricalDiscoveryPageUnavailable["reason"],
  }
  const items = row.items as Array<{ jobId: string }>, offset = row.offset as number, totalCount = row.totalCount as number
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(totalCount) || offset >= totalCount
    || row.truncated === true && totalCount !== TASK_GRAPH_HISTORICAL_DISCOVERY_MAX_JOB_IDS
    || items.length !== Math.min(TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SIZE, totalCount - offset)
    || items.some(item => !isCanonicalTaskGraphJobId(item.jobId))
    || new Set(items.map(item => item.jobId)).size !== items.length) return null
  const nextOffset = offset + items.length < totalCount ? offset + items.length : null
  if (row.nextOffset !== nextOffset) return null
  return {
    schemaVersion: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "available",
    observation: "historical_discovery", verificationStatus: "unverified", sourceToken: row.sourceToken as string,
    sourceResultStatus: row.sourceResultStatus as "completed" | "partial", offset, nextOffset, totalCount,
    truncated: row.truncated as boolean, items: items.map(item => ({ jobId: item.jobId })),
  }
}

/** Rejects accessors, proxies, symbols, sparse arrays and cycles before TypeBox reads input. */
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
    const keys = Reflect.ownKeys(value)
    return keys.every(key => {
      if (typeof key !== "string") return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return Boolean(descriptor?.enumerable && "value" in descriptor && safeData(descriptor.value, seen))
    })
  } catch { return false }
  finally { seen.delete(value) }
}
