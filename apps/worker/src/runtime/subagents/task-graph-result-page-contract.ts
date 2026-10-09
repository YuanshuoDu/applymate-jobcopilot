import { types as nodeTypes } from "node:util"
import { Type, type Static } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"


export const TASK_GRAPH_RESULT_PAGE_SCHEMA = "agent-harness.v2.task-graph.result-page.v1" as const
export const TASK_GRAPH_RESULT_PAGE_SIZE = 3
export const TASK_GRAPH_RESULT_SOURCE_BYTE_LIMIT = 256 * 1024
const MAX_GRAPH_REVISION = 2_147_483_646
const CanonicalJobId = Type.String({ pattern: "^(?:c[a-z0-9]{24}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$" })
const EvidenceKind = Type.Union([Type.Literal("job"), Type.Literal("persona"), Type.Literal("resume"), Type.Literal("source")])
const AtsSource = Type.Union([
  Type.Literal("greenhouse"), Type.Literal("lever"), Type.Literal("workday"),
  Type.Literal("smartrecruiters"), Type.Literal("personio"), Type.Literal("other"),
])
const ScoutItem = Type.Object({ jobId: CanonicalJobId, source: AtsSource, evidenceKinds: Type.Array(EvidenceKind, { minItems: 1, maxItems: 4 }) }, { additionalProperties: false })
const AnalystItem = Type.Object({ jobId: CanonicalJobId, score: Type.Number({ minimum: 0, maximum: 10 }), evidenceKinds: Type.Array(EvidenceKind, { minItems: 1, maxItems: 4 }) }, { additionalProperties: false })
const TerminalStatus = Type.Union([
  Type.Literal("completed"), Type.Literal("failed"), Type.Literal("interrupted"), Type.Literal("cancelled"), Type.Literal("closed"),
])
const ResultStatus = Type.Union([Type.Literal("completed"), Type.Literal("partial")])
const Common = {
  schemaVersion: Type.Literal(TASK_GRAPH_RESULT_PAGE_SCHEMA),
  trust: Type.Literal("untrusted"),
  availability: Type.Literal("available"),
  graphRevision: Type.Integer({ minimum: 1, maximum: MAX_GRAPH_REVISION }),
  taskStatus: TerminalStatus,
  resultStatus: ResultStatus,
  totalCount: Type.Integer({ minimum: 0 }),
  evidenceCount: Type.Integer({ minimum: 0 }),
  offset: Type.Integer({ minimum: 0 }),
  nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
}
const AvailableScout = Type.Object({ ...Common, role: Type.Literal("scout"), items: Type.Array(ScoutItem, { maxItems: TASK_GRAPH_RESULT_PAGE_SIZE }) }, { additionalProperties: false })
const AvailableAnalyst = Type.Object({ ...Common, role: Type.Literal("analyst"), items: Type.Array(AnalystItem, { maxItems: TASK_GRAPH_RESULT_PAGE_SIZE }) }, { additionalProperties: false })
const Unavailable = Type.Object({
  schemaVersion: Type.Literal(TASK_GRAPH_RESULT_PAGE_SCHEMA), trust: Type.Literal("untrusted"),
  availability: Type.Literal("unavailable"), graphRevision: Type.Integer({ minimum: 0, maximum: MAX_GRAPH_REVISION }),
  reason: Type.Union([
    Type.Literal("no_graph"), Type.Literal("revision_mismatch"), Type.Literal("node_unavailable"),
    Type.Literal("result_unavailable"), Type.Literal("offset_out_of_range"), Type.Literal("source_too_large"),
  ]),
}, { additionalProperties: false })

export const TaskGraphResultPageRequestSchema = Type.Object({
  nodeKey: Type.String({ minLength: 1, maxLength: 128 }),
  expectedRevision: Type.Integer({ minimum: 0, maximum: MAX_GRAPH_REVISION }),
  offset: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
export type TaskGraphResultPageRequest = Readonly<Static<typeof TaskGraphResultPageRequestSchema>>
export type TaskGraphResultPageAvailable = Static<typeof AvailableScout> | Static<typeof AvailableAnalyst>
export type TaskGraphResultPageUnavailable = Static<typeof Unavailable>
export type TaskGraphResultPage = TaskGraphResultPageAvailable | TaskGraphResultPageUnavailable
export const TaskGraphResultPageSchema = Type.Union([AvailableScout, AvailableAnalyst, Unavailable])

export function isCanonicalTaskGraphJobId(value: unknown): value is string {
  return typeof value === "string" && /^(?:c[a-z0-9]{24}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.test(value)
}

export function parseTaskGraphResultPageRequest(value: unknown): TaskGraphResultPageRequest | null {
  if (!safeData(value) || !Value.Check(TaskGraphResultPageRequestSchema, value)) return null
  const row = value as Record<string, unknown>
  if (!Number.isSafeInteger(row.expectedRevision) || !Number.isSafeInteger(row.offset)) return null
  return { nodeKey: row.nodeKey as string, expectedRevision: row.expectedRevision as number, offset: row.offset as number }
}

export function parseTaskGraphResultPage(value: unknown): TaskGraphResultPage | null {
  if (!safeData(value) || !Value.Check(TaskGraphResultPageSchema, value)) return null
  const row = value as Record<string, unknown>
  if (row.availability === "unavailable") {
    if (!Number.isSafeInteger(row.graphRevision)) return null
    return { schemaVersion: TASK_GRAPH_RESULT_PAGE_SCHEMA, trust: "untrusted", availability: "unavailable",
      graphRevision: row.graphRevision as number, reason: row.reason as TaskGraphResultPageUnavailable["reason"] }
  }
  if (!safePageIntegers(row)) return null
  const totalCount = row.totalCount as number, offset = row.offset as number
  if (offset > totalCount || !Array.isArray(row.items)
    || row.items.length !== Math.min(TASK_GRAPH_RESULT_PAGE_SIZE, totalCount - offset)) return null
  const expectedNextOffset = offset + row.items.length < totalCount ? offset + row.items.length : null
  if (row.nextOffset !== expectedNextOffset) return null
  const evidenceKinds = (items: unknown[]): boolean => items.every(item => {
    const kinds = (item as { evidenceKinds: unknown[] }).evidenceKinds
    return new Set(kinds).size === kinds.length && kinds.every((kind, index) => EVIDENCE_KIND_ORDER.indexOf(kind as typeof EVIDENCE_KIND_ORDER[number])
      > (index === 0 ? -1 : EVIDENCE_KIND_ORDER.indexOf(kinds[index - 1] as typeof EVIDENCE_KIND_ORDER[number])))
  })
  if (!evidenceKinds(row.items)) return null
  if (row.role === "scout") return {
    schemaVersion: TASK_GRAPH_RESULT_PAGE_SCHEMA, trust: "untrusted", availability: "available", graphRevision: row.graphRevision as number,
    role: "scout", taskStatus: row.taskStatus as Static<typeof TerminalStatus>, resultStatus: row.resultStatus as "completed" | "partial",
    totalCount: row.totalCount as number, evidenceCount: row.evidenceCount as number, offset: row.offset as number,
    nextOffset: row.nextOffset as number | null,
    items: (row.items as Array<{ jobId: string; source: string; evidenceKinds: string[] }>).map(item => ({
      jobId: item.jobId, source: item.source as Static<typeof AtsSource>, evidenceKinds: [...item.evidenceKinds] as Array<Static<typeof EvidenceKind>>,
    })),
  }
  return {
    schemaVersion: TASK_GRAPH_RESULT_PAGE_SCHEMA, trust: "untrusted", availability: "available", graphRevision: row.graphRevision as number,
    role: "analyst", taskStatus: row.taskStatus as Static<typeof TerminalStatus>, resultStatus: row.resultStatus as "completed" | "partial",
    totalCount: row.totalCount as number, evidenceCount: row.evidenceCount as number, offset: row.offset as number,
    nextOffset: row.nextOffset as number | null,
    items: (row.items as Array<{ jobId: string; score: number; evidenceKinds: string[] }>).map(item => ({
      jobId: item.jobId, score: item.score, evidenceKinds: [...item.evidenceKinds] as Array<Static<typeof EvidenceKind>>,
    })),
  }
}

const EVIDENCE_KIND_ORDER = ["job", "persona", "resume", "source"] as const

function safePageIntegers(value: unknown): boolean {
  const row = value as Record<string, unknown>
  const integer = (candidate: unknown): candidate is number => Number.isSafeInteger(candidate) && Number(candidate) >= 0
  return integer(row.graphRevision) && row.graphRevision > 0 && integer(row.totalCount) && integer(row.evidenceCount) && integer(row.offset)
    && (row.nextOffset === null || integer(row.nextOffset))
}

/** Rejects proxies, accessors, symbols, sparse arrays and cycles before schema checks read properties. */
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
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || !safeData(descriptor.value, seen)) return false
      }
      return keys.every(key => key === "length" || typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    const keys = Reflect.ownKeys(value)
    if (!keys.every((key): key is string => typeof key === "string")) return false
    return keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return Boolean(descriptor?.enumerable && Object.hasOwn(descriptor, "value") && safeData(descriptor.value, seen))
    })
  } catch { return false }
  finally { seen.delete(value) }
}
