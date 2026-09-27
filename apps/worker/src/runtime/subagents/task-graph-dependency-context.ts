import { Buffer } from "node:buffer"
import { ROLE_RESULT_SCHEMA, validateRoleResult, type StructuredRoleResult } from "./role-results.js"
import { projectValidatedRoleResult } from "./task-graph-result-projection.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"

export const TASK_GRAPH_DEPENDENCY_RESULT_BYTE_LIMIT = 4 * 1024
export const TASK_GRAPH_DEPENDENCY_CONTEXT_BYTE_LIMIT = 8 * 1024
const TASK_GRAPH_DEPENDENCY_SOURCE_BYTE_LIMIT = 16 * 1024
const DEPENDENCY_CONTEXT_KEY = "taskGraphDependencyResults"
const PROJECTED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function isTaskGraphDependencyContextError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("task_graph_dependency_")
}

export type ScopedDependencyResult = GraphIdentityScope & Readonly<{
  key: string
  taskId: string
  status: string
  role: string
  expectedOutputSchema: unknown
  result: unknown
}>

/**
 * Produces a small, server-owned evidence projection for a child task. The
 * dependency keys are supplied in graph order and must be direct prerequisites.
 * Oversized or malformed results fail closed; they are never partially parsed
 * or silently truncated.
 */
export function materializeTaskGraphDependencyContext(
  templateContext: unknown,
  scope: GraphIdentityScope,
  dependencyKeys: readonly string[],
  dependencies: readonly ScopedDependencyResult[],
): unknown {
  if (!isPlainRecord(scope) || !scope.userId || !scope.sessionId || !scope.turnId
    || !scope.rootTaskId || !scope.parentTaskId || scope.parentTaskId !== scope.rootTaskId) {
    throw new Error("task_graph_dependency_scope_invalid")
  }
  if (new Set(dependencyKeys).size !== dependencyKeys.length || dependencies.length !== dependencyKeys.length) {
    throw new Error("task_graph_dependency_set_invalid")
  }
  const byKey = new Map(dependencies.map(dependency => [dependency.key, dependency] as const))
  const items = dependencyKeys.map(key => {
    const dependency = byKey.get(key)
    if (!dependency) throw new Error("task_graph_dependency_missing")
    if (dependency.userId !== scope.userId || dependency.sessionId !== scope.sessionId
      || dependency.turnId !== scope.turnId || dependency.rootTaskId !== scope.rootTaskId
      || dependency.parentTaskId !== scope.parentTaskId) {
      throw new Error("task_graph_dependency_scope_mismatch")
    }
    if (dependency.status !== "completed") throw new Error("task_graph_dependency_not_completed")
    if ((dependency.role !== "scout" && dependency.role !== "analyst") || !expectedSchema(dependency.expectedOutputSchema, dependency.role)) {
      throw new Error("task_graph_dependency_result_contract_invalid")
    }
    const sourceBytes = encodedBytes(dependency.result)
    if (sourceBytes > TASK_GRAPH_DEPENDENCY_SOURCE_BYTE_LIMIT) throw new Error("task_graph_dependency_source_too_large")
    let validated: StructuredRoleResult
    try {
      const envelope = parseCompletedResultEnvelope(dependency.result)
      validated = validateRoleResult(envelope.structuredResult, dependency.role)
    } catch {
      throw new Error("task_graph_dependency_result_invalid")
    }
    const projected = projectValidatedRoleResult(validated)
    if (projected.availability !== "available") throw new Error("task_graph_dependency_result_invalid")
    if (encodedBytes(projected) > TASK_GRAPH_DEPENDENCY_RESULT_BYTE_LIMIT) {
      throw new Error("task_graph_dependency_result_too_large")
    }
    return { dependencyKey: safeDependencyKey(dependency.key), role: dependency.role, taskStatus: "completed", result: projected }
  })
  const evidence = { schemaVersion: "agent-harness.v2.task-graph.dependency-evidence", items }
  if (encodedBytes(evidence) > TASK_GRAPH_DEPENDENCY_CONTEXT_BYTE_LIMIT) {
    throw new Error("task_graph_dependency_context_too_large")
  }
  const base = isPlainRecord(templateContext)
    ? { ...templateContext }
    : { templateContext: templateContext ?? {} }
  if (Object.prototype.hasOwnProperty.call(base, DEPENDENCY_CONTEXT_KEY)) {
    throw new Error("task_graph_dependency_context_reserved_key")
  }
  return { ...base, [DEPENDENCY_CONTEXT_KEY]: evidence }
}

function expectedSchema(value: unknown, role: "scout" | "analyst"): boolean {
  if (!isPlainRecord(value)) return false
  return Object.keys(value).sort().join(",") === "role,schemaVersion"
    && value.schemaVersion === ROLE_RESULT_SCHEMA && value.role === role
}

function parseResult(value: unknown): unknown {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) as unknown } catch { return null }
}

function parseCompletedResultEnvelope(value: unknown): { structuredResult: unknown } {
  const parsed = parseResult(value)
  if (!isPlainRecord(parsed)) throw new Error("task_graph_dependency_result_envelope_invalid")
  const keys = Object.keys(parsed).sort().join(",")
  if (keys !== "finalItemId,finalText,status,stepCount,structuredResult,toolCallCount"
    || parsed.status !== "completed" || typeof parsed.stepCount !== "number" || !Number.isSafeInteger(parsed.stepCount) || parsed.stepCount < 0
    || typeof parsed.toolCallCount !== "number" || !Number.isSafeInteger(parsed.toolCallCount) || parsed.toolCallCount < 0
    || (parsed.finalItemId !== null && typeof parsed.finalItemId !== "string")
    || typeof parsed.finalText !== "string" || !Object.prototype.hasOwnProperty.call(parsed, "structuredResult")) {
    throw new Error("task_graph_dependency_result_envelope_invalid")
  }
  return { structuredResult: parsed.structuredResult }
}

function encodedBytes(value: unknown): number {
  let encoded: string
  try { encoded = JSON.stringify(value) } catch { throw new Error("task_graph_dependency_result_invalid") }
  if (typeof encoded !== "string") throw new Error("task_graph_dependency_result_invalid")
  return Buffer.byteLength(encoded, "utf8")
}

function safeDependencyKey(value: string): string {
  if (!PROJECTED_ID.test(value)) throw new Error("task_graph_dependency_key_unsafe")
  return value
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
