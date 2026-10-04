import type { TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { evaluateTaskGraphVerification, TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, type TaskGraphVerificationEvidenceProjection } from "../planning/task-graph-verification.js"
import { parseTaskGraphRepairReceipt, parseTaskGraphVerificationReport, taskGraphVerificationReportMatchesStatus, type TaskGraphRepairReceipt, type TaskGraphVerificationReport } from "./task-graph-command-port.js"
import { taskGraphResultDigest } from "./task-graph-pg-verification.js"
import { ROLE_RESULT_SCHEMA, validateRoleResult, type AnalystResult, type ScoutResult, type StructuredRole, type StructuredRoleResult } from "./role-results.js"
import type { Queryable } from "./pg-store-persistence.js"
import type { ScopedDependencyResult } from "./task-graph-dependency-context.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"

type Node = TaskGraphSnapshot["nodes"][number]
type Row = Record<string, unknown>
type RepairLineage = Array<Pick<TaskGraphRepairReceipt, "criterionIds" | "evidenceDigest" | "verifierVersion"> & { resultDigest: string }>
type RepairComposition = { result: unknown; report: TaskGraphVerificationReport; repairLineage: RepairLineage }
const BASE = "finalItemId,finalText,status,stepCount,structuredResult,toolCallCount"

/** Read a waiting task and its predecessors, composing only receipt-backed repairs. */
export async function loadScopedTaskGraphDependencyContext(
  client: Queryable, scope: GraphIdentityScope, childTaskId: string, dependencyKeys: readonly string[], graphNodes: readonly Node[],
): Promise<{ childContext: unknown; dependencies: ScopedDependencyResult[] }> {
  const nodeByKey = new Map(graphNodes.map(node => [node.key, node] as const))
  const repairs = graphNodes.filter(node => node.repairOf && dependencyKeys.includes(node.repairOf.nodeKey)
    && node.repairOf.graphRootTaskId === scope.rootTaskId)
  const ids = [...new Set([childTaskId, ...dependencyKeys.map(key => nodeByKey.get(key)?.taskId), ...repairs.map(node => node.taskId)])]
    .filter((id): id is string => typeof id === "string")
  const result = await client.query(`SELECT task."id", task."status", task."role", task."failureReason", task."expectedOutputSchema", task."result", task."context",
      task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", session."userId" AS "userId"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6`,
  [ids, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId])
  const byId = new Map(result.rows.map(raw => { const row = raw as Row; return [String(row.id), row] as const }))
  const child = byId.get(childTaskId)
  if (!child || child.status !== "waiting") throw new Error("task_graph_dependency_child_scope_invalid")
  const dependencies: ScopedDependencyResult[] = []
  for (const key of dependencyKeys) {
    const node = nodeByKey.get(key), row = node && byId.get(node.taskId)
    if (!node || !row) continue
    const related = repairs.filter(repair => repair.repairOf?.nodeKey === key && repair.repairOf.taskId === node.taskId)
    const task = scoped(row, key, node, scope)
    if (row.status === "failed") {
      const composite = composeRepairResult(task, node, related.map(repair => ({ node: repair, row: byId.get(repair.taskId) })), scope.rootTaskId)
      dependencies.push({ ...task, status: "completed", result: composite.result, failureReason: null, repairComposite: true,
        verificationReport: composite.report, repairLineage: composite.repairLineage })
    } else dependencies.push(task)
  }
  return { childContext: child.context ?? {}, dependencies }
}


/** Load only exact-scope dependency rows; repair-satisfied failures stay failed in storage. */
export async function loadTaskGraphDependencyResults(client: Queryable, scope: GraphIdentityScope, dependencyKeys: readonly string[], graphNodes: readonly Node[]): Promise<ScopedDependencyResult[]> {
  const byKey = new Map(graphNodes.map(node => [node.key, node] as const)), repairs = graphNodes.filter(node => node.repairOf && dependencyKeys.includes(node.repairOf.nodeKey) && node.repairOf.graphRootTaskId === scope.rootTaskId)
  const ids = [...new Set([...dependencyKeys.map(key => byKey.get(key)?.taskId), ...repairs.map(node => node.taskId)])].filter((id): id is string => typeof id === "string")
  if (!ids.length) return []
  const result = await client.query(`SELECT task."id", task."status", task."role", task."failureReason", task."expectedOutputSchema", task."result", task."context",
      task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", session."userId" AS "userId"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6`,
  [ids, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId])
  const rows = new Map(result.rows.map(raw => { const row = raw as Row; return [String(row.id), row] as const }))
  return dependencyKeys.flatMap(key => {
    const node = byKey.get(key), row = node && rows.get(node.taskId)
    if (!node || !row) return []
    const task = scoped(row, key, node, scope)
    if (row.status !== "failed") return [task]
    const related = repairs.filter(repair => repair.repairOf?.nodeKey === key && repair.repairOf.taskId === node.taskId)
    const composite = composeRepairResult(task, node, related.map(repair => ({ node: repair, row: rows.get(repair.taskId) })), scope.rootTaskId)
    return [{ ...task, status: "completed", result: composite.result, failureReason: null, repairComposite: true as const, verificationReport: composite.report, repairLineage: composite.repairLineage }]
  })
}
function scoped(row: Row, key: string, node: Node, scope: GraphIdentityScope): ScopedDependencyResult {
  return {
    key, taskId: node.taskId, status: String(row.status), role: String(row.role), expectedOutputSchema: row.expectedOutputSchema, result: row.result,
    ...(Object.hasOwn(row, "failureReason") ? { failureReason: row.failureReason === null ? null : String(row.failureReason) } : {}),
    ...(node.verificationDisposition ? { verificationDisposition: node.verificationDisposition } : {}),
    ...(node.verification ? { verification: node.verification } : {}), ...(node.repairOf ? { repairOf: node.repairOf } : {}),
    userId: String(row.userId), sessionId: String(row.sessionId), turnId: String(row.turnId),
    rootTaskId: String(row.rootTaskId), parentTaskId: String(row.parentTaskId),
    ...(row.sessionId !== scope.sessionId || row.turnId !== scope.turnId || row.rootTaskId !== scope.rootTaskId || row.parentTaskId !== scope.parentTaskId || row.userId !== scope.userId
      ? { failureReason: "task_graph_dependency_scope_mismatch" } : {}),
  }
}

function composeRepairResult(target: ScopedDependencyResult, node: Node, repairs: Array<{ node: Node; row?: Row }>, rootTaskId: string): RepairComposition {
  const ids = node.verification?.criteria.map(item => item.id) ?? []
  const original = record(parseResult(target.result)), report = node.verificationDisposition === "typed"
    ? parseTaskGraphVerificationReport(original?.taskGraphVerificationReport, ids) : undefined
  if (node.verificationDisposition !== "typed" || !node.verification || target.role !== node.verification.role
    || target.failureReason !== `task_graph_verification_${report?.status}` || !report
    || !taskGraphVerificationReportMatchesStatus(report, "failed")) throw new Error("task_graph_dependency_repair_source_invalid")
  const missing = new Set(report.criteria.filter(item => item.status !== "passed").map(item => item.criterionId))
  const coverage = new Map<string, number>(), results: Array<{ result: StructuredRoleResult; criterionIds: readonly string[] }> = [], repairLineage: RepairLineage = []
  for (const { node: repair, row } of repairs) {
    const relation = repair.repairOf, repairIds = repair.verification?.criteria.map(item => item.id) ?? []
    const stored = record(parseResult(row?.result)), proof = repair.verificationDisposition === "typed"
      ? parseTaskGraphVerificationReport(stored?.taskGraphVerificationReport, repairIds) : undefined
    const receipt = parseTaskGraphRepairReceipt(stored?.taskGraphRepairReceipt, {
      repairOf: relation, repairNodeKey: repair.key, repairTaskId: repair.taskId, report: proof,
    })
    if (!relation || relation.graphRootTaskId !== rootTaskId || relation.nodeKey !== node.key || relation.taskId !== node.taskId
      || row?.status !== "completed" || row.failureReason !== null || row.role !== target.role || !proof
      || !taskGraphVerificationReportMatchesStatus(proof, "completed") || !receipt
      || receipt.criterionIds.some(id => !missing.has(id))) continue
    const value = parseCompletedRepairResult(stored, repair, proof)
    results.push({ result: validateRoleResult(value, target.role as StructuredRole), criterionIds: receipt.criterionIds })
    if (!proof.resultDigest) throw new Error("task_graph_dependency_repair_result_digest_invalid")
    repairLineage.push({ criterionIds: receipt.criterionIds, evidenceDigest: receipt.evidenceDigest, verifierVersion: receipt.verifierVersion, resultDigest: proof.resultDigest })
    for (const id of receipt.criterionIds) coverage.set(id, (coverage.get(id) ?? 0) + 1)
  }
  if (!missing.size || [...missing].some(id => coverage.get(id) !== 1) || !results.length) {
    throw new Error("task_graph_dependency_repair_incomplete")
  }
  const originalResult = parseFailedOriginalResult(original, node, report, target.role as StructuredRole)
  if (originalResult) results.unshift({ result: originalResult, criterionIds: [] })
  const merged = mergeResults(results, node)
  if (merged.role !== "scout" && merged.role !== "analyst") throw new Error("task_graph_dependency_repair_role_unsupported")
  const roleResult = merged as ScoutResult | AnalystResult
  const projection = roleResult.role === "scout"
    ? { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role: roleResult.role, candidates: roleResult.candidates.map(({ jobId, evidenceIds }) => ({ jobId, evidenceIds })), evidenceIds: canonicalResultEvidenceIds(roleResult) }
    : { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role: roleResult.role, findings: roleResult.findings.map(({ jobId, score, evidenceIds }) => ({ jobId, score, evidenceIds })), evidenceIds: canonicalResultEvidenceIds(roleResult) }
  if (evaluateTaskGraphVerification(node.verification, projection as TaskGraphVerificationEvidenceProjection).status !== "passed") {
    throw new Error("task_graph_dependency_repair_composite_unverified")
  }
  return { report, repairLineage, result: { status: "completed", stepCount: 0, toolCallCount: 0, finalItemId: null,
    finalText: "Verified repair results.", structuredResult: merged } }
}

function canonicalResultEvidenceIds(value: ScoutResult | AnalystResult): string[] {
  for (const item of value.evidence) if (item.kind === "source" || item.id !== `read:${item.kind}:${item.ref}`) {
    throw new Error("task_graph_dependency_repair_evidence_unbound")
  }
  return value.evidence.map(item => item.id)
}

function parseFailedOriginalResult(value: Row | null, node: Node, report: NonNullable<ReturnType<typeof parseTaskGraphVerificationReport>>, role: StructuredRole): StructuredRoleResult | undefined {
  if (!value) return undefined
  const reportOnly = "taskGraphVerificationReport"
  const reportWithNullWorkerResult = "taskGraphVerificationReport,workerResult"
  const keys = Object.keys(value).sort().join(",")
  if (keys === reportOnly || keys === reportWithNullWorkerResult) {
    const storedReport = parseTaskGraphVerificationReport(value.taskGraphVerificationReport, node.verification?.criteria.map(item => item.id) ?? [])
    if (!hasExactPlainDataKeys(value, keys) || (keys === reportWithNullWorkerResult && value.workerResult !== null)
      || node.verificationDisposition !== "typed" || !node.verification || node.verification.role !== role
      || !storedReport || storedReport.status !== "unverified" || storedReport.reasonCode !== "result_invalid"
      || storedReport.evidenceDigest !== null || storedReport.resultDigest !== null
      || !taskGraphVerificationReportMatchesStatus(report, "failed")
      || !taskGraphVerificationReportMatchesStatus(storedReport, "failed")) {
      throw new Error("task_graph_dependency_repair_original_invalid")
    }
    return undefined
  }
  const without = ["finalItemId", "finalText", "status", "stepCount", "taskGraphVerificationReport", "toolCallCount"].sort().join(",")
  const withResult = [...BASE.split(","), "taskGraphVerificationReport"].sort().join(",")
  if ((keys !== without && keys !== withResult) || value.status !== "completed" || !taskGraphVerificationReportMatchesStatus(report, "failed")
    || !parseTaskGraphVerificationReport(value.taskGraphVerificationReport, node.verification?.criteria.map(item => item.id) ?? [])) {
    throw new Error("task_graph_dependency_repair_original_invalid")
  }
  if (!Object.hasOwn(value, "structuredResult")) { if (report.resultDigest !== null) throw new Error("task_graph_dependency_repair_original_digest_invalid"); return undefined }
  const result = validateRoleResult(value.structuredResult, role)
  if (report.resultDigest !== taskGraphResultDigest(result)) throw new Error("task_graph_dependency_repair_original_digest_invalid")
  return result
}

function hasExactPlainDataKeys(value: Row, expected: string): boolean {
  try {
    const keys = Reflect.ownKeys(value)
    if (Object.getPrototypeOf(value) !== Object.prototype || keys.some(key => typeof key !== "string")
      || keys.sort().join(",") !== expected) return false
    return Object.values(Object.getOwnPropertyDescriptors(value))
      .every(descriptor => descriptor.enumerable === true && Object.hasOwn(descriptor, "value"))
  } catch { return false }
}

function parseCompletedRepairResult(value: Row | null, node: Node, report: ReturnType<typeof parseTaskGraphVerificationReport>): unknown {
  if (!value || !node.verification) throw new Error("task_graph_dependency_repair_result_invalid")
  const receipt = value.taskGraphRepairReceipt, hasReceipt = receipt !== undefined
  const expected = [...BASE.split(","), "taskGraphVerificationReport", ...(hasReceipt ? ["taskGraphRepairReceipt"] : [])].sort().join(",")
  const normalized = validateRoleResult(value.structuredResult, node.verification.role)
  if (Object.keys(value).sort().join(",") !== expected || !taskGraphVerificationReportMatchesStatus(report!, "completed")
    || report?.resultDigest !== taskGraphResultDigest(normalized)
    || !parseTaskGraphRepairReceipt(receipt, { repairOf: node.repairOf, repairNodeKey: node.key, repairTaskId: node.taskId, report })) {
    throw new Error("task_graph_dependency_repair_result_invalid")
  }
  return value.structuredResult
}

function mergeResults(pieces: readonly { result: StructuredRoleResult; criterionIds: readonly string[] }[], target: Node): StructuredRoleResult {
  const values = pieces.map(piece => piece.result), first = values[0]!
  if (first.role === "scout") {
    const evidence = mergeEvidence(values), items = new Map<string, ScoutResult["candidates"][number]>()
    for (const [index, value] of values.entries()) {
      if (value.role !== "scout" || value.status !== "completed") throw new Error("task_graph_dependency_repair_role_conflict")
      for (const item of value.candidates) {
        const prior = items.get(item.jobId)
        if (prior && (prior.source !== item.source || prior.url !== item.url)) throw new Error("task_graph_dependency_repair_item_conflict")
        items.set(item.jobId, { ...item, evidenceIds: [...new Set([...(prior?.evidenceIds ?? []), ...item.evidenceIds])] })
      }
    }
    return validateRoleResult({ schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed", candidates: [...items.values()].sort((a, b) => a.jobId.localeCompare(b.jobId)), evidence, summary: "Verified repair results." }, "scout")
  }
  if (first.role === "analyst") {
    const evidence = mergeEvidence(values), items = new Map<string, AnalystResult["findings"][number]>(), repairedScores = new Set<string>()
    for (const [index, value] of values.entries()) {
      if (value.role !== "analyst" || value.status !== "completed") throw new Error("task_graph_dependency_repair_role_conflict")
      const replaceScore = pieces[index]!.criterionIds.some(id => target.verification?.criteria.some(item => item.id === id && item.check.kind === "reported_score_gte"))
      for (const item of value.findings) {
        const prior = items.get(item.jobId)
        if (prior && prior.score !== item.score && (!replaceScore || repairedScores.has(item.jobId))) throw new Error("task_graph_dependency_repair_item_conflict")
        items.set(item.jobId, { ...(prior && !replaceScore ? prior : item), evidenceIds: [...new Set([...(prior?.evidenceIds ?? []), ...item.evidenceIds])] })
        if (replaceScore) repairedScores.add(item.jobId)
      }
    }
    return validateRoleResult({ schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed", findings: [...items.values()].sort((a, b) => a.jobId.localeCompare(b.jobId)), evidence, summary: "Verified repair results." }, "analyst")
  }
  throw new Error("task_graph_dependency_repair_role_unsupported")
}

function mergeEvidence(values: readonly StructuredRoleResult[]) {
  const evidence = new Map<string, ScoutResult["evidence"][number]>()
  for (const value of values) {
    if (value.role !== "scout" && value.role !== "analyst") throw new Error("task_graph_dependency_repair_role_conflict")
    if (value.status !== "completed") throw new Error("task_graph_dependency_repair_partial")
    for (const item of value.evidence) {
      const prior = evidence.get(item.id)
      if (prior && (prior.kind !== item.kind || prior.ref !== item.ref || prior.source !== item.source)) throw new Error("task_graph_dependency_repair_evidence_conflict")
      evidence.set(item.id, item)
    }
  }
  return [...evidence.values()]
}

function parseResult(value: unknown): unknown { if (typeof value !== "string") return value; try { return JSON.parse(value) as unknown } catch { return null } }
function record(value: unknown): Row | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null }
