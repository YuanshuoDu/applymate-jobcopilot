import { Buffer } from "node:buffer"
import { validateRoleResult, type AnalystResult, type ScoutResult, type StructuredRoleResult } from "./role-results.js"
import {
  TASK_GRAPH_RESULT_PROJECTION_SCHEMA,
  type TaskGraphAnalystProjectionItem,
  type TaskGraphProjectionEvidenceKind,
  type TaskGraphProjectionSource,
  type TaskGraphResultProjection,
  type TaskGraphScoutProjectionItem,
} from "./task-graph-command-port.js"

export const TASK_GRAPH_RESULT_SOURCE_BYTE_LIMIT = 16 * 1024
export const TASK_GRAPH_RESULT_PROJECTION_NODE_BYTE_LIMIT = 2 * 1024
export const TASK_GRAPH_RESULT_PROJECTION_TOTAL_BYTE_LIMIT = 16 * 1024
export const TASK_GRAPH_RESULT_PROJECTION_ITEMS_PER_NODE = 3
export const TASK_GRAPH_RESULT_PROJECTION_ITEMS_TOTAL = 24

const UNAVAILABLE: TaskGraphResultProjection = Object.freeze({
  schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "unavailable",
})
const RESULT_ENVELOPE_KEYS = "finalItemId,finalText,status,stepCount,structuredResult,toolCallCount"
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
const ATS_SOURCES = new Set<TaskGraphProjectionSource>(["greenhouse", "lever", "workday", "smartrecruiters", "personio"])
const EVIDENCE_KINDS: readonly TaskGraphProjectionEvidenceKind[] = ["job", "persona", "resume", "source"]

type CompletedResultEnvelope = Readonly<{ structuredResult: unknown }>

/**
 * Projects only a completed, exact Worker result envelope. The projection
 * contains typed result facts and deterministic counts, never model prose,
 * URLs, evidence IDs, refs, or execution metadata.
 */
export function projectTaskGraphResult(role: string, taskStatus: string, value: unknown): TaskGraphResultProjection {
  if (taskStatus !== "completed" || (role !== "scout" && role !== "analyst")) return UNAVAILABLE
  try {
    const envelope = parseCompletedEnvelope(value)
    const result = validateRoleResult(envelope.structuredResult, role)
    return projectValidatedRoleResult(result)
  } catch {
    return UNAVAILABLE
  }
}

export function projectValidatedRoleResult(value: StructuredRoleResult): TaskGraphResultProjection {
  try {
    const projection = value.role === "scout" ? projectScout(value) : projectAnalyst(value)
    return encodedBytes(projection) <= TASK_GRAPH_RESULT_PROJECTION_NODE_BYTE_LIMIT ? projection : UNAVAILABLE
  } catch {
    return UNAVAILABLE
  }
}

export function taskGraphResultProjectionItemCount(value: TaskGraphResultProjection): number {
  if (value.availability !== "available") return 0
  return value.role === "scout" ? value.candidates.length : value.findings.length
}

export function taskGraphResultProjectionBytes(value: TaskGraphResultProjection): number {
  return encodedBytes(value)
}

function projectScout(value: ScoutResult): Extract<TaskGraphResultProjection, { availability: "available"; role: "scout" }> {
  const candidates: TaskGraphScoutProjectionItem[] = value.candidates.slice(0, TASK_GRAPH_RESULT_PROJECTION_ITEMS_PER_NODE).map(item => {
    const jobId = safeJobId(item.jobId)
    if (!jobId) throw new Error("task_graph_result_projection_job_id_invalid")
    return {
      jobId,
      source: atsSource(item.source),
      evidenceKinds: linkedEvidenceKinds(item.evidenceIds, value),
    }
  })
  return {
    schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA,
    trust: "untrusted", availability: "available", role: "scout", status: value.status,
    candidateCount: value.candidates.length, evidenceCount: value.evidence.length, candidates,
  }
}

function projectAnalyst(value: AnalystResult): Extract<TaskGraphResultProjection, { availability: "available"; role: "analyst" }> {
  const findings: TaskGraphAnalystProjectionItem[] = value.findings.slice(0, TASK_GRAPH_RESULT_PROJECTION_ITEMS_PER_NODE).map(item => {
    const jobId = safeJobId(item.jobId)
    if (!jobId) throw new Error("task_graph_result_projection_job_id_invalid")
    return {
      jobId,
      score: item.score,
      evidenceKinds: linkedEvidenceKinds(item.evidenceIds, value),
    }
  })
  return {
    schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA,
    trust: "untrusted", availability: "available", role: "analyst", status: value.status,
    findingCount: value.findings.length, evidenceCount: value.evidence.length, findings,
  }
}

function linkedEvidenceKinds(ids: readonly string[], result: StructuredRoleResult): TaskGraphProjectionEvidenceKind[] {
  const evidenceById = new Map(result.evidence.map(item => [item.id, item.kind] as const))
  const kinds = new Set<TaskGraphProjectionEvidenceKind>()
  for (const id of ids) {
    const kind = evidenceById.get(id)
    if (kind && EVIDENCE_KINDS.includes(kind)) kinds.add(kind)
  }
  return [...kinds]
}

function atsSource(value: string): TaskGraphProjectionSource {
  const normalized = value.trim().toLowerCase()
  return ATS_SOURCES.has(normalized as TaskGraphProjectionSource) ? normalized as TaskGraphProjectionSource : "other"
}

function safeJobId(value: string): string | null {
  return SAFE_JOB_ID.test(value) ? value : null
}

function parseCompletedEnvelope(value: unknown): CompletedResultEnvelope {
  const bytes = persistedBytes(value)
  if (bytes > TASK_GRAPH_RESULT_SOURCE_BYTE_LIMIT) throw new Error("task_graph_result_source_too_large")
  let parsed: unknown = value
  if (typeof value === "string") {
    try { parsed = JSON.parse(value) as unknown } catch { throw new Error("task_graph_result_envelope_invalid") }
  }
  const row = plainRecord(parsed)
  if (!row || !exactKeys(row, RESULT_ENVELOPE_KEYS)
    || row.status !== "completed"
    || !Number.isSafeInteger(row.stepCount) || Number(row.stepCount) < 0
    || !Number.isSafeInteger(row.toolCallCount) || Number(row.toolCallCount) < 0
    || (row.finalItemId !== null && typeof row.finalItemId !== "string")
    || typeof row.finalText !== "string"
    || !Object.prototype.hasOwnProperty.call(row, "structuredResult")) {
    throw new Error("task_graph_result_envelope_invalid")
  }
  return { structuredResult: row.structuredResult }
}

function persistedBytes(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8")
  return encodedBytes(value)
}

function encodedBytes(value: unknown): number {
  let encoded: string | undefined
  try { encoded = JSON.stringify(value) } catch { throw new Error("task_graph_result_json_invalid") }
  if (typeof encoded !== "string") throw new Error("task_graph_result_json_invalid")
  return Buffer.byteLength(encoded, "utf8")
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(value).length === 0
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function exactKeys(value: Record<string, unknown>, expected: string): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.every((key): key is string => typeof key === "string") && keys.sort().join(",") === expected
}
