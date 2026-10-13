import { Buffer } from "node:buffer"
import { types as nodeTypes } from "node:util"
import type { TaskGraphNode } from "../planning/task-graph.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { TASK_GRAPH_NATIVE_TEMPLATE_ID, parseTaskGraphNativeDelegation } from "./task-graph-native-state.js"
import { ROLE_RESULT_SCHEMA, validateRoleResult, type AnalystResult, type ScoutResult } from "./role-results.js"
import { isTerminalSubagentStatus } from "./types.js"
import type { LoadedGraph, GraphTaskRow } from "./task-graph-pg-state.js"
import type { StoredTaskGraphNode } from "./task-graph-snapshot.js"
import {
  isCanonicalTaskGraphJobId, TASK_GRAPH_RESULT_PAGE_SCHEMA, TASK_GRAPH_RESULT_PAGE_SIZE,
  TASK_GRAPH_RESULT_SOURCE_BYTE_LIMIT, type TaskGraphResultPage, type TaskGraphResultPageRequest,
} from "./task-graph-result-page-contract.js"

const ATS_SOURCES = new Set(["greenhouse", "lever", "workday", "smartrecruiters", "personio"])
const EVIDENCE_KINDS = ["job", "persona", "resume", "source"] as const
const MAX_REVISION = 2_147_483_646

/** Purely projects a bounded page from the owner-fenced, already-loaded current graph. */
export function projectTaskGraphResultPage(loaded: LoadedGraph, request: TaskGraphResultPageRequest): TaskGraphResultPage {
  if (!loaded.item) return unavailable(0, "no_graph")
  const revision = loaded.item.revision
  if (!validRevision(revision) || !loaded.snapshot || !loaded.state || loaded.state.revision !== revision) {
    return unavailable(validRevision(revision) ? revision : 0, "node_unavailable")
  }
  if (request.expectedRevision !== revision) return unavailable(revision, "revision_mismatch")

  const snapshotNode = loaded.snapshot.nodes.find(node => node.key === request.nodeKey)
  const currentNode = loaded.state.nodes.find(node => node.key === request.nodeKey)
  const task = snapshotNode ? loaded.tasks.get(snapshotNode.taskId) : undefined
  if (!snapshotNode || !currentNode || !task || !matchesCurrentNode(snapshotNode, currentNode, task)
    || !eligibleNode(snapshotNode, task, loaded.rootTaskId)) return unavailable(revision, "node_unavailable")
  if (!isTerminalSubagentStatus(task.status)) return unavailable(revision, "result_unavailable")

  const structured = persistedStructuredResult(task.result)
  if (!structured.present) return unavailable(revision, "result_unavailable")
  const encoded = encodeSource(structured.value)
  if (encoded === null) return unavailable(revision, "result_unavailable")
  if (encoded > TASK_GRAPH_RESULT_SOURCE_BYTE_LIMIT) return unavailable(revision, "source_too_large")
  let result: ScoutResult | AnalystResult
  try { result = validateRoleResult(structured.value, task.role as "scout" | "analyst") }
  catch { return unavailable(revision, "result_unavailable") }

  if (request.offset > resultCount(result)) return unavailable(revision, "offset_out_of_range")
  const allItems = result.role === "scout" ? result.candidates : result.findings
  if (allItems.some(item => !isCanonicalTaskGraphJobId(item.jobId))) return unavailable(revision, "result_unavailable")
  if (result.role === "scout") {
    const items = result.candidates.slice(request.offset, request.offset + TASK_GRAPH_RESULT_PAGE_SIZE).map(item => ({
      jobId: item.jobId, source: normalizeSource(item.source), evidenceKinds: evidenceKinds(item.evidenceIds, result),
    }))
    const next = request.offset + items.length
    return {
      schemaVersion: TASK_GRAPH_RESULT_PAGE_SCHEMA, trust: "untrusted", availability: "available", graphRevision: revision,
      role: "scout", taskStatus: task.status, resultStatus: result.status, totalCount: result.candidates.length,
      evidenceCount: result.evidence.length, offset: request.offset, nextOffset: next < result.candidates.length ? next : null, items,
    }
  }
  const items = result.findings.slice(request.offset, request.offset + TASK_GRAPH_RESULT_PAGE_SIZE).map(item => ({
    jobId: item.jobId, score: item.score, evidenceKinds: evidenceKinds(item.evidenceIds, result),
  }))
  const next = request.offset + items.length
  return {
    schemaVersion: TASK_GRAPH_RESULT_PAGE_SCHEMA, trust: "untrusted", availability: "available", graphRevision: revision,
    role: "analyst", taskStatus: task.status, resultStatus: result.status, totalCount: result.findings.length,
    evidenceCount: result.evidence.length, offset: request.offset, nextOffset: next < result.findings.length ? next : null, items,
  }
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_REVISION
}

function matchesCurrentNode(snapshot: StoredTaskGraphNode, current: TaskGraphNode, task: GraphTaskRow): boolean {
  return current.taskId === snapshot.taskId && current.templateId === snapshot.templateId
    && task.id === snapshot.taskId && current.status === task.status
}

function eligibleNode(node: StoredTaskGraphNode, task: GraphTaskRow, rootTaskId: string): boolean {
  if (node.templateId === TASK_GRAPH_NATIVE_TEMPLATE_ID) {
    const metadata = parseTaskGraphNativeDelegation(node.nativeDelegation)
    return Boolean(metadata && metadata.callerTaskId === rootTaskId && metadata.role === task.role
      && metadata.taskType === task.taskType && isBusinessRole(task.role) && outputMarker(task.expectedOutputSchema, task.role))
  }
  const template = node.templateId === "scout" || node.templateId === "analyst" ? TASK_GRAPH_TEMPLATES[node.templateId] : undefined
  return Boolean(template && task.role === template.role && task.taskType === template.taskType
    && isBusinessRole(task.role) && outputMarker(task.expectedOutputSchema, task.role))
}

function isBusinessRole(value: string): value is "scout" | "analyst" { return value === "scout" || value === "analyst" }

function outputMarker(value: unknown, role: string): boolean {
  if (!plainData(value) || !value || typeof value !== "object" || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return Reflect.ownKeys(row).sort().join(",") === "role,schemaVersion"
    && row.schemaVersion === ROLE_RESULT_SCHEMA && row.role === role
}

function persistedStructuredResult(value: unknown): { present: boolean; value?: unknown } {
  let parsed = value
  if (typeof value === "string") {
    try { parsed = JSON.parse(value) as unknown } catch { return { present: false } }
  }
  if (!plainData(parsed) || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { present: false }
  const envelope = parsed as Record<string, unknown>
  return Object.hasOwn(envelope, "structuredResult")
    ? { present: true, value: envelope.structuredResult } : { present: false }
}

function encodeSource(value: unknown): number | null {
  if (!plainData(value)) return null
  try {
    const encoded = JSON.stringify(value)
    return typeof encoded === "string" ? Buffer.byteLength(encoded, "utf8") : null
  } catch { return null }
}

function plainData(value: unknown, seen = new Set<object>()): boolean {
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
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || !plainData(descriptor.value, seen)) return false
      }
      return keys.every(key => key === "length" || typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    const keys = Reflect.ownKeys(value)
    return keys.every(key => {
      if (typeof key !== "string") return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return Boolean(descriptor?.enumerable && Object.hasOwn(descriptor, "value") && plainData(descriptor.value, seen))
    })
  } catch { return false }
  finally { seen.delete(value) }
}

function resultCount(result: ScoutResult | AnalystResult): number {
  return result.role === "scout" ? result.candidates.length : result.findings.length
}

function normalizeSource(value: string): "greenhouse" | "lever" | "workday" | "smartrecruiters" | "personio" | "other" {
  const normalized = value.trim().toLowerCase()
  return ATS_SOURCES.has(normalized) ? normalized as ReturnType<typeof normalizeSource> : "other"
}

function evidenceKinds(ids: readonly string[], result: ScoutResult | AnalystResult): Array<typeof EVIDENCE_KINDS[number]> {
  const linked = new Set(result.evidence.filter(item => ids.includes(item.id)).map(item => item.kind))
  return EVIDENCE_KINDS.filter(kind => linked.has(kind))
}

function unavailable(graphRevision: number, reason: Extract<TaskGraphResultPage, { availability: "unavailable" }>["reason"]): TaskGraphResultPage {
  return { schemaVersion: TASK_GRAPH_RESULT_PAGE_SCHEMA, trust: "untrusted", availability: "unavailable", graphRevision, reason }
}
