import { Buffer } from "node:buffer"
import { parseArtifactReference, ROLE_RESULT_SCHEMA, validateRoleResult, type ArtifactVersionReference, type StructuredRole, type StructuredRoleResult } from "./role-results.js"
import { projectValidatedRoleResult } from "./task-graph-result-projection.js"
import { parseTaskGraphRepairReceipt, parseTaskGraphVerificationReport, taskGraphVerificationReportMatchesStatus } from "./task-graph-command-port.js"
import { taskGraphResultDigest } from "./task-graph-pg-verification.js"
import type { TaskGraphRepairReceipt, TaskGraphVerificationReport } from "./task-graph-command-port.js"
import type { TaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { GraphIdentityScope, GraphTaskRow } from "./task-graph-pg-state.js"

export const TASK_GRAPH_DEPENDENCY_RESULT_BYTE_LIMIT = 4 * 1024
export const TASK_GRAPH_DEPENDENCY_CONTEXT_BYTE_LIMIT = 8 * 1024
const TASK_GRAPH_DEPENDENCY_SOURCE_BYTE_LIMIT = 16 * 1024
const DEPENDENCY_CONTEXT_KEY = "taskGraphDependencyResults"
const PROJECTED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function resolveTaskGraphRepairDependencies(snapshot: TaskGraphSnapshot, tasks: ReadonlyMap<string, GraphTaskRow>, rootTaskId: string): { satisfied: string[]; pending: string[] } {
  const unresolved = new Map<string, Set<string>>(), coverage = new Map<string, Map<string, number>>(), byKey = new Map(snapshot.nodes.map(node => [node.key, node] as const))
  for (const node of snapshot.nodes) {
    const task = tasks.get(node.taskId), ids = node.verification?.criteria.map(item => item.id) ?? [], result = parseResult(task?.result)
    const report = node.verificationDisposition === "typed" ? parseTaskGraphVerificationReport(isPlainRecord(result) ? result.taskGraphVerificationReport : undefined, ids) : undefined
    if (task?.status === "failed" && report && taskGraphVerificationReportMatchesStatus(report, task.status) && task.failureReason === `task_graph_verification_${report.status}`) {
      const failed = report.criteria.filter(item => item.status !== "passed").map(item => item.criterionId)
      if (failed.length) { unresolved.set(node.key, new Set(failed)); coverage.set(node.key, new Map()) }
    }
  }
  for (const repair of snapshot.nodes) {
    const relation = repair.repairOf, target = relation && byKey.get(relation.nodeKey), task = tasks.get(repair.taskId), ids = repair.verification?.criteria.map(item => item.id) ?? [], result = parseResult(task?.result)
    const report = repair.verificationDisposition === "typed" ? parseTaskGraphVerificationReport(isPlainRecord(result) ? result.taskGraphVerificationReport : undefined, ids) : undefined
    const receipt = parseTaskGraphRepairReceipt(isPlainRecord(result) ? result.taskGraphRepairReceipt : undefined, { repairOf: relation, repairNodeKey: repair.key, repairTaskId: repair.taskId, report })
    const missing = relation && unresolved.get(relation.nodeKey), counts = relation && coverage.get(relation.nodeKey)
    if (!relation || !target || relation.graphRootTaskId !== rootTaskId || target.taskId !== relation.taskId || task?.status !== "completed"
      || task.failureReason !== null || !report || !taskGraphVerificationReportMatchesStatus(report, "completed")
      || !receipt || !missing || !counts || !relation.criterionIds.every(id => missing.has(id))) continue
    for (const id of receipt.criterionIds) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const satisfied: string[] = [], pending: string[] = []
  for (const [key, ids] of unresolved) {
    const counts = coverage.get(key)!
    if ([...ids].every(id => counts.get(id) === 1)) satisfied.push(key); else pending.push(key)
  }
  return { satisfied, pending }
}

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
  failureReason?: string | null
  verificationDisposition?: TaskGraphSnapshot["nodes"][number]["verificationDisposition"]
  verification?: TaskGraphSnapshot["nodes"][number]["verification"]
  repairOf?: TaskGraphSnapshot["nodes"][number]["repairOf"]
  repairComposite?: true
  verificationReport?: TaskGraphVerificationReport
  repairLineage?: readonly (Pick<TaskGraphRepairReceipt, "criterionIds" | "evidenceDigest" | "verifierVersion"> & { resultDigest: string })[]
}>

/** Resolve the one direct Writer dependency from server-materialized Reviewer context. */
export function writerArtifactReferenceFromTaskContext(value: unknown, expectedJobId: string): ArtifactVersionReference {
  const context = isPlainRecord(value) ? value : null
  const selected = context && isPlainRecord(context.selectedJobPreparation) ? context.selectedJobPreparation : null
  const dependencyContext = context && isPlainRecord(context[DEPENDENCY_CONTEXT_KEY]) ? context[DEPENDENCY_CONTEXT_KEY] : null
  if (!selected || Object.keys(selected).sort().join(",") !== "jobId" || selected.jobId !== expectedJobId
    || !dependencyContext || dependencyContext.schemaVersion !== "agent-harness.v2.task-graph.dependency-evidence"
    || !Array.isArray(dependencyContext.items) || dependencyContext.items.length > 8) {
    throw new Error("task_graph_reviewer_writer_dependency_missing")
  }
  const writers = dependencyContext.items.filter(item => isPlainRecord(item) && item.role === "writer")
  if (writers.length !== 1) throw new Error("task_graph_reviewer_writer_dependency_missing")
  const item = writers[0]
  if (!isPlainRecord(item) || item.taskStatus !== "completed" || !isPlainRecord(item.result)) {
    throw new Error("task_graph_reviewer_writer_dependency_invalid")
  }
  const result = item.result
  if (result.schemaVersion !== "agent-harness.v2.task-graph.result-projection" || result.trust !== "untrusted"
    || result.availability !== "available" || result.role !== "writer" || result.status !== "completed"
    || Object.keys(result).sort().join(",") !== "artifactRef,availability,role,schemaVersion,status,trust") {
    throw new Error("task_graph_reviewer_writer_dependency_invalid")
  }
  try { return parseArtifactReference(result.artifactRef) } catch { throw new Error("task_graph_reviewer_writer_dependency_invalid") }
}

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
    let dependency = byKey.get(key)
    if (!dependency) throw new Error("task_graph_dependency_missing")
    if (dependency.userId !== scope.userId || dependency.sessionId !== scope.sessionId
      || dependency.turnId !== scope.turnId || dependency.rootTaskId !== scope.rootTaskId
      || dependency.parentTaskId !== scope.parentTaskId) {
      throw new Error("task_graph_dependency_scope_mismatch")
    }
    if (dependency.status !== "completed" || dependency.failureReason) throw new Error("task_graph_dependency_not_completed")
    if (!isStructuredRole(dependency.role) || !expectedSchema(dependency.expectedOutputSchema, dependency.role)) {
      throw new Error("task_graph_dependency_result_contract_invalid")
    }
    const sourceBytes = encodedBytes(dependency.result)
    if (sourceBytes > TASK_GRAPH_DEPENDENCY_SOURCE_BYTE_LIMIT) throw new Error("task_graph_dependency_source_too_large")
    let validated: StructuredRoleResult
    try {
      const envelope = parseCompletedResultEnvelope(dependency)
      validated = validateRoleResult(envelope.structuredResult, dependency.role)
      if (!dependency.repairComposite && envelope.verificationReport && envelope.verificationReport.resultDigest !== taskGraphResultDigest(validated)) throw new Error("task_graph_dependency_result_digest_invalid")
      if (envelope.verificationReport || envelope.repairLineage) dependency = {
        ...dependency, ...(envelope.verificationReport ? { verificationReport: envelope.verificationReport } : {}),
        ...(envelope.repairLineage ? { repairLineage: envelope.repairLineage } : {}),
      }
    } catch {
      throw new Error("task_graph_dependency_result_invalid")
    }
    const projected = projectValidatedRoleResult(validated)
    if (projected.availability !== "available") throw new Error("task_graph_dependency_result_invalid")
    if (encodedBytes(projected) > TASK_GRAPH_DEPENDENCY_RESULT_BYTE_LIMIT) {
      throw new Error("task_graph_dependency_result_too_large")
    }
    const verification = dependency.verificationReport ? {
      verifierVersion: dependency.verificationReport.verifierVersion, status: dependency.verificationReport.status,
      reasonCode: dependency.verificationReport.reasonCode, criteria: dependency.verificationReport.criteria,
      evidenceDigest: dependency.verificationReport.evidenceDigest, resultDigest: dependency.verificationReport.resultDigest,
    } : undefined
    return { dependencyKey: safeDependencyKey(dependency.key), role: dependency.role, taskStatus: "completed", result: projected,
      ...(verification ? { verification } : {}), ...(dependency.repairLineage ? { repairLineage: dependency.repairLineage } : {}) }
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

function expectedSchema(value: unknown, role: StructuredRole): boolean {
  if (!isPlainRecord(value)) return false
  return Object.keys(value).sort().join(",") === "role,schemaVersion"
    && value.schemaVersion === ROLE_RESULT_SCHEMA && value.role === role
}

function isStructuredRole(value: string): value is StructuredRole {
  return value === "scout" || value === "analyst" || value === "writer" || value === "reviewer"
}

function parseResult(value: unknown): unknown {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) as unknown } catch { return null }
}

function parseCompletedResultEnvelope(dependency: ScopedDependencyResult): {
  structuredResult: unknown; verificationReport?: TaskGraphVerificationReport
  repairLineage?: readonly (Pick<TaskGraphRepairReceipt, "criterionIds" | "evidenceDigest" | "verifierVersion"> & { resultDigest: string })[]
} {
  const parsed = parseResult(dependency.result)
  if (!isPlainRecord(parsed)) throw new Error("task_graph_dependency_result_envelope_invalid")
  const keys = Object.keys(parsed).sort().join(",")
  const base = "finalItemId,finalText,status,stepCount,structuredResult,toolCallCount"
  if (parsed.status !== "completed" || typeof parsed.stepCount !== "number" || !Number.isSafeInteger(parsed.stepCount) || parsed.stepCount < 0
    || typeof parsed.toolCallCount !== "number" || !Number.isSafeInteger(parsed.toolCallCount) || parsed.toolCallCount < 0
    || (parsed.finalItemId !== null && typeof parsed.finalItemId !== "string")
    || typeof parsed.finalText !== "string" || !Object.hasOwn(parsed, "structuredResult")) {
    throw new Error("task_graph_dependency_result_envelope_invalid")
  }
  if (dependency.repairComposite === true) {
    if (keys !== base || dependency.verificationDisposition !== "typed" || !dependency.verification || dependency.repairOf) {
      throw new Error("task_graph_dependency_result_envelope_invalid")
    }
    const report = parseTaskGraphVerificationReport(dependency.verificationReport, dependency.verification.criteria.map(item => item.id))
    const unresolved = report?.criteria.filter(item => item.status !== "passed").map(item => item.criterionId) ?? []
    const counts = new Map<string, number>()
    for (const receipt of dependency.repairLineage ?? []) {
      if (!Array.isArray(receipt.criterionIds) || !receipt.criterionIds.length || new Set(receipt.criterionIds).size !== receipt.criterionIds.length
        || !receipt.criterionIds.every(id => typeof id === "string") || !/^[a-f0-9]{64}$/.test(receipt.evidenceDigest) || !/^[a-f0-9]{64}$/.test(receipt.resultDigest)
        || receipt.verifierVersion !== report?.verifierVersion) throw new Error("task_graph_dependency_result_envelope_invalid")
      for (const id of receipt.criterionIds) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    if (!report || !taskGraphVerificationReportMatchesStatus(report, "failed")
      || unresolved.some(id => counts.get(id) !== 1) || [...counts.keys()].some(id => !unresolved.includes(id))) {
      throw new Error("task_graph_dependency_result_envelope_invalid")
    }
    return { structuredResult: parsed.structuredResult, verificationReport: report, repairLineage: dependency.repairLineage }
  } else if (dependency.verificationDisposition === "typed") {
    const report = dependency.verification && parseTaskGraphVerificationReport(
      parsed.taskGraphVerificationReport, dependency.verification.criteria.map(item => item.id),
    )
    const hasReceipt = Object.hasOwn(parsed, "taskGraphRepairReceipt")
    const expected = [...base.split(","), "taskGraphVerificationReport", ...(hasReceipt ? ["taskGraphRepairReceipt"] : [])].sort().join(",")
    const receipt = hasReceipt && dependency.repairOf && report ? parseTaskGraphRepairReceipt(parsed.taskGraphRepairReceipt, {
      repairOf: dependency.repairOf, repairNodeKey: dependency.key, repairTaskId: dependency.taskId, report,
    }) : undefined
    if (keys !== expected || !report || !taskGraphVerificationReportMatchesStatus(report, "completed")
      || dependency.failureReason || (dependency.repairOf && !receipt) || (!dependency.repairOf && hasReceipt)) {
      throw new Error("task_graph_dependency_result_envelope_invalid")
    }
    return { structuredResult: parsed.structuredResult, verificationReport: report, repairLineage: dependency.repairLineage }
  } else if (keys !== base || dependency.repairOf || Object.hasOwn(parsed, "taskGraphVerificationReport")
    || Object.hasOwn(parsed, "taskGraphRepairReceipt")) throw new Error("task_graph_dependency_result_envelope_invalid")
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
