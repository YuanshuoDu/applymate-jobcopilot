import { createHash } from "node:crypto"
import { canonicalTaskGraphJson } from "./task-graph-snapshot.js"
import { TASK_GRAPH_RESULT_SOURCE_BYTE_LIMIT } from "./task-graph-result-projection.js"
import { ROLE_RESULT_SCHEMA, validateRoleResult, type StructuredRole } from "./role-results.js"
import type { TaskGraphNativeNodeView, TaskGraphNativeResultReceipt } from "./task-graph-native-command.js"
import { taskGraphNativeNodeView, type TaskGraphNativeDelegationMetadata } from "./task-graph-native-state.js"
import type { SubagentTaskStatus } from "./types.js"

export const TASK_GRAPH_NATIVE_RESULT_SCHEMA = "agent-harness.v2.task-graph.native-result.v1" as const
const MAX_NATIVE_RESULT_BYTES = 64 * 1024

/** Stores structural provenance only; the digest is never evidence of task quality or approval. */
export function taskGraphNativeResultReceipt(
  role: string,
  taskStatus: SubagentTaskStatus,
  value: unknown,
  expectedOutputSchema: unknown,
): TaskGraphNativeResultReceipt {
  const marker = outputMarker(expectedOutputSchema, role)
  if (value === null || value === undefined) {
    if (marker && taskStatus === "completed") throw new Error("task_graph_native_result_invalid")
    return { schemaVersion: TASK_GRAPH_NATIVE_RESULT_SCHEMA, role, taskStatus, disposition: "missing", resultDigest: null }
  }
  const encoded = encodedResult(value)
  const envelope = object(encoded.parsed), structured = envelope?.structuredResult, declared = object(structured)
  const declaresRoleResult = declared?.schemaVersion === ROLE_RESULT_SCHEMA
  if (marker && taskStatus === "completed") {
    try {
      if (!validEnvelope(envelope, encoded.bytes)) throw new Error("invalid")
      validateRoleResult(structured, marker.role)
    } catch { throw new Error("task_graph_native_result_invalid") }
  } else if (declaresRoleResult) {
    try {
      if (!validEnvelope(envelope, encoded.bytes)) throw new Error("invalid")
      if (!isStructuredRole(role)) throw new Error("role_mismatch")
      validateRoleResult(structured, role)
    } catch { throw new Error("task_graph_native_result_invalid") }
  }
  if (encoded.bytes > MAX_NATIVE_RESULT_BYTES) {
    return { schemaVersion: TASK_GRAPH_NATIVE_RESULT_SCHEMA, role, taskStatus, disposition: "opaque", resultDigest: null }
  }
  const digest = createHash("sha256").update(encoded.canonical, "utf8").digest("hex")
  return {
    schemaVersion: TASK_GRAPH_NATIVE_RESULT_SCHEMA, role, taskStatus,
    disposition: object(encoded.parsed) ? "structured" : "opaque", resultDigest: digest,
  }
}

function isStructuredRole(value: string): value is StructuredRole {
  return value === "scout" || value === "analyst" || value === "writer" || value === "reviewer"
}

export function taskGraphNativeCurrentView(metadata: TaskGraphNativeDelegationMetadata, child: Readonly<{
  role: string; taskType?: string; status: SubagentTaskStatus; result: unknown; expectedOutputSchema?: unknown
}>): Readonly<{ native: TaskGraphNativeNodeView; nativeResult: TaskGraphNativeResultReceipt }> {
  if (child.role !== metadata.role || child.taskType !== undefined && child.taskType !== metadata.taskType) {
    throw new Error("task_graph_native_child_contract_invalid")
  }
  return {
    native: taskGraphNativeNodeView(metadata),
    nativeResult: taskGraphNativeResultReceipt(metadata.role, child.status, child.result, child.expectedOutputSchema),
  }
}

function outputMarker(value: unknown, role: string): { role: StructuredRole } | null {
  if (value === undefined || value === null) return null
  const row = object(value)
  if (!row) throw new Error("task_graph_native_result_contract_invalid")
  if (Object.keys(row).length === 0) return null
  if (row.schemaVersion !== ROLE_RESULT_SCHEMA) return null
  if (Reflect.ownKeys(row).sort().join(",") !== "role,schemaVersion"
    || !["scout", "analyst", "writer", "reviewer"].includes(String(row.role)) || row.role !== role) {
    throw new Error("task_graph_native_result_contract_invalid")
  }
  return { role: row.role as StructuredRole }
}

function validEnvelope(row: Record<string, unknown> | null, bytes: number): row is Record<string, unknown> {
  return !!row && bytes <= TASK_GRAPH_RESULT_SOURCE_BYTE_LIMIT
    && Reflect.ownKeys(row).sort().join(",") === "finalItemId,finalText,status,stepCount,structuredResult,toolCallCount"
    && row.status === "completed" && Number.isSafeInteger(row.stepCount) && Number(row.stepCount) >= 0
    && Number.isSafeInteger(row.toolCallCount) && Number(row.toolCallCount) >= 0
    && (row.finalItemId === null || typeof row.finalItemId === "string") && typeof row.finalText === "string"
    && Object.hasOwn(row, "structuredResult")
}

function encodedResult(value: unknown): { parsed: unknown; canonical: string; bytes: number } {
  let parsed = value
  if (typeof value === "string") {
    try { parsed = JSON.parse(value) as unknown } catch { parsed = value }
  }
  let canonical: string
  try { canonical = canonicalTaskGraphJson(parsed) } catch { throw new Error("task_graph_native_result_invalid") }
  return { parsed, canonical, bytes: Buffer.byteLength(canonical, "utf8") }
}

function object(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try { return Object.getPrototypeOf(value) === Object.prototype ? value as Record<string, unknown> : null }
  catch { return null }
}
