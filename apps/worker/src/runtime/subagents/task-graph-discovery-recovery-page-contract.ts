import { types as nodeTypes } from "node:util"
import { Type, type Static } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import { MAX_DISCOVERY_RECOVERY_JOB_IDS } from "./task-graph-discovery-recovery-contract.js"
import { isCanonicalTaskGraphJobId } from "./task-graph-result-page-contract.js"

export const TASK_GRAPH_DISCOVERY_RECOVERY_PAGE_SCHEMA = "agent-harness.v2.task-graph.discovery-recovery-page.v1" as const
export const TASK_GRAPH_DISCOVERY_RECOVERY_PAGE_SIZE = 3
export const TASK_GRAPH_DISCOVERY_RECOVERY_MAX_ATTEMPT_COUNT = 1_000_000
const MAX_GRAPH_REVISION = 2_147_483_646
const MAX_OFFSET = MAX_DISCOVERY_RECOVERY_JOB_IDS
const Id = Type.String({ pattern: "^(?:c[a-z0-9]{24}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?![\\s\\S])" })
const Attempt = Type.Integer({ minimum: 1, maximum: TASK_GRAPH_DISCOVERY_RECOVERY_MAX_ATTEMPT_COUNT })

const RequestBase = { mode: Type.Literal("discovery_recovery"), nodeKey: Type.String({ minLength: 1, maxLength: 128 }),
  expectedRevision: Type.Integer({ minimum: 0, maximum: MAX_GRAPH_REVISION }) }
const InitialRequest = Type.Object({ ...RequestBase, offset: Type.Literal(0), expectedAttemptCount: Type.Optional(Attempt) }, { additionalProperties: false })
const MAX_CONTINUATION_OFFSET = MAX_OFFSET - TASK_GRAPH_DISCOVERY_RECOVERY_PAGE_SIZE
const ContinuationRequest = Type.Object({ ...RequestBase,
  offset: Type.Integer({ minimum: TASK_GRAPH_DISCOVERY_RECOVERY_PAGE_SIZE, maximum: MAX_CONTINUATION_OFFSET,
    multipleOf: TASK_GRAPH_DISCOVERY_RECOVERY_PAGE_SIZE }), expectedAttemptCount: Attempt }, { additionalProperties: false })
export const TaskGraphDiscoveryRecoveryPageRequestSchema = Type.Union([InitialRequest, ContinuationRequest])
export type TaskGraphDiscoveryRecoveryPageRequest = Readonly<Static<typeof TaskGraphDiscoveryRecoveryPageRequestSchema>>

const Available = Type.Object({
  schemaVersion: Type.Literal(TASK_GRAPH_DISCOVERY_RECOVERY_PAGE_SCHEMA), trust: Type.Literal("untrusted"),
  availability: Type.Literal("available"), observation: Type.Literal("partial_discovery"),
  verificationStatus: Type.Literal("unverified"), graphRevision: Type.Integer({ minimum: 1, maximum: MAX_GRAPH_REVISION }),
  attemptCount: Attempt, taskStatus: Type.Literal("failed"), totalCount: Type.Integer({ minimum: 0, maximum: MAX_DISCOVERY_RECOVERY_JOB_IDS }),
  offset: Type.Integer({ minimum: 0, maximum: MAX_OFFSET }), nextOffset: Type.Union([Type.Integer({ minimum: 0, maximum: MAX_OFFSET }), Type.Null()]),
  truncated: Type.Boolean(), items: Type.Array(Type.Object({ jobId: Id }, { additionalProperties: false }), { maxItems: TASK_GRAPH_DISCOVERY_RECOVERY_PAGE_SIZE }),
}, { additionalProperties: false })
const Unavailable = Type.Object({
  schemaVersion: Type.Literal(TASK_GRAPH_DISCOVERY_RECOVERY_PAGE_SCHEMA), trust: Type.Literal("untrusted"),
  availability: Type.Literal("unavailable"), graphRevision: Type.Integer({ minimum: 0, maximum: MAX_GRAPH_REVISION }),
  reason: Type.Union([Type.Literal("no_graph"), Type.Literal("revision_mismatch"), Type.Literal("node_unavailable"),
    Type.Literal("recovery_unavailable"), Type.Literal("attempt_mismatch"), Type.Literal("offset_out_of_range")]),
}, { additionalProperties: false })

export type TaskGraphDiscoveryRecoveryPage = Static<typeof Available> | Static<typeof Unavailable>
export type TaskGraphDiscoveryRecoveryAvailablePage = Static<typeof Available>
export const TaskGraphDiscoveryRecoveryPageSchema = Type.Union([Available, Unavailable])

export function parseTaskGraphDiscoveryRecoveryPageRequest(value: unknown): TaskGraphDiscoveryRecoveryPageRequest | null {
  if (!safeData(value) || !Value.Check(TaskGraphDiscoveryRecoveryPageRequestSchema, value)) return null
  const row = value as Record<string, unknown>
  if (!Number.isSafeInteger(row.expectedRevision) || !Number.isSafeInteger(row.offset)
    || row.offset !== 0 && Number(row.offset) % TASK_GRAPH_DISCOVERY_RECOVERY_PAGE_SIZE !== 0
    || row.expectedAttemptCount !== undefined && !Number.isSafeInteger(row.expectedAttemptCount)) return null
  const base = { mode: "discovery_recovery" as const, nodeKey: row.nodeKey as string, expectedRevision: row.expectedRevision as number }
  return row.offset === 0
    ? { ...base, offset: 0, ...(row.expectedAttemptCount === undefined ? {} : { expectedAttemptCount: row.expectedAttemptCount as number }) }
    : { ...base, offset: row.offset as number, expectedAttemptCount: row.expectedAttemptCount as number }
}

export function parseTaskGraphDiscoveryRecoveryPage(value: unknown): TaskGraphDiscoveryRecoveryPage | null {
  if (!safeData(value) || !Value.Check(TaskGraphDiscoveryRecoveryPageSchema, value)) return null
  const row = value as Record<string, unknown>
  if (row.availability === "unavailable") {
    if (!Number.isSafeInteger(row.graphRevision)) return null
    return { schemaVersion: TASK_GRAPH_DISCOVERY_RECOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "unavailable",
      graphRevision: row.graphRevision as number, reason: row.reason as TaskGraphDiscoveryRecoveryPageUnavailable["reason"] }
  }
  const items = row.items as Array<{ jobId: string }>, totalCount = row.totalCount as number, offset = row.offset as number
  if (!safePageIntegers(row) || totalCount > MAX_DISCOVERY_RECOVERY_JOB_IDS || offset > totalCount || row.truncated === true && totalCount !== MAX_DISCOVERY_RECOVERY_JOB_IDS
    || items.length !== Math.min(TASK_GRAPH_DISCOVERY_RECOVERY_PAGE_SIZE, totalCount - offset)
    || items.some(item => !isCanonicalTaskGraphJobId(item.jobId))
    || new Set(items.map(item => item.jobId)).size !== items.length) return null
  const nextOffset = offset + items.length < totalCount ? offset + items.length : null
  if (row.nextOffset !== nextOffset) return null
  return { schemaVersion: TASK_GRAPH_DISCOVERY_RECOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "available",
    observation: "partial_discovery", verificationStatus: "unverified", graphRevision: row.graphRevision as number,
    attemptCount: row.attemptCount as number, taskStatus: "failed", totalCount, offset, nextOffset,
    truncated: row.truncated as boolean, items: items.map(item => ({ jobId: item.jobId })) }
}

type TaskGraphDiscoveryRecoveryPageUnavailable = Extract<TaskGraphDiscoveryRecoveryPage, { availability: "unavailable" }>

function safePageIntegers(value: Record<string, unknown>): boolean {
  return Number.isSafeInteger(value.graphRevision) && Number(value.graphRevision) > 0
    && Number.isSafeInteger(value.attemptCount) && Number(value.attemptCount) >= 1
    && Number(value.attemptCount) <= TASK_GRAPH_DISCOVERY_RECOVERY_MAX_ATTEMPT_COUNT
    && Number.isSafeInteger(value.totalCount) && Number(value.totalCount) >= 0
    && Number.isSafeInteger(value.offset) && Number(value.offset) >= 0
    && (value.nextOffset === null || Number.isSafeInteger(value.nextOffset) && Number(value.nextOffset) >= 0)
}

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
