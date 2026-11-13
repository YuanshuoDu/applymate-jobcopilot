import type { TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, type TaskGraphVerificationEvidenceProjection } from "../planning/task-graph-verification.js"
import { parseTaskGraphRepairReceipt, parseTaskGraphVerificationReport, taskGraphVerificationReportMatchesStatus, type TaskGraphRepairReceipt, type TaskGraphVerificationReport } from "./task-graph-command-port.js"
import { validateRoleResult, type AnalystResult, type ScoutResult, type StructuredRole, type StructuredRoleResult } from "./role-results.js"
import type { Queryable } from "./pg-store-persistence.js"
import type { ScopedDependencyResult } from "./task-graph-dependency-context.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import { verifyRepairedTaskGraphFindings } from "./task-graph-pg-completed-dependency-verification.js"
import { canonicalResultEvidenceIds, mergeRepairedRoleResults, mergeReverifiedScoutLocationEvidence, parseCompletedRepairResult, parseFailedOriginalResult, reverifyCompletedScoutLocationRepair, reverifyFailedScoutLocationPartial, type ReverifiedScoutEvidencePiece } from "./task-graph-repair-evidence-projection.js"

type Node = TaskGraphSnapshot["nodes"][number]
type Row = Record<string, unknown>
type RepairLineage = Array<Pick<TaskGraphRepairReceipt, "criterionIds" | "evidenceDigest" | "verifierVersion"> & { resultDigest: string }>
type RepairComposition = { result: unknown; report: TaskGraphVerificationReport; repairLineage: RepairLineage }

/** Read a waiting task and its predecessors, composing only receipt-backed repairs. */
export async function loadScopedTaskGraphDependencyContext(
  client: Queryable, scope: GraphIdentityScope, childTaskId: string, dependencyKeys: readonly string[], graphNodes: readonly Node[],
): Promise<{ childContext: unknown; dependencies: ScopedDependencyResult[] }> {
  const nodeByKey = new Map(graphNodes.map(node => [node.key, node] as const))
  const repairs = graphNodes.filter(node => node.repairOf && dependencyKeys.includes(node.repairOf.nodeKey)
    && node.repairOf.graphRootTaskId === scope.rootTaskId)
  const ids = [...new Set([childTaskId, ...dependencyKeys.map(key => nodeByKey.get(key)?.taskId), ...repairs.map(node => node.taskId)])]
    .filter((id): id is string => typeof id === "string")
  const result = await client.query(`SELECT task."id", task."status", task."role", task."failureReason", task."attemptCount", task."taskType", task."allowedActions", task."expectedOutputSchema", task."result", task."context",
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
      const composite = await composeRepairResult(task, row, node, related.map(repair => ({ node: repair, row: byId.get(repair.taskId) })), scope, graphNodes, client)
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
  const result = await client.query(`SELECT task."id", task."status", task."role", task."failureReason", task."attemptCount", task."taskType", task."allowedActions", task."expectedOutputSchema", task."result", task."context",
      task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", session."userId" AS "userId"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6`,
  [ids, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId])
  const rows = new Map(result.rows.map(raw => { const row = raw as Row; return [String(row.id), row] as const }))
  return (await Promise.all(dependencyKeys.map(async key => {
    const node = byKey.get(key), row = node && rows.get(node.taskId)
    if (!node || !row) return []
    const task = scoped(row, key, node, scope)
    if (row.status !== "failed") return [task]
    const related = repairs.filter(repair => repair.repairOf?.nodeKey === key && repair.repairOf.taskId === node.taskId)
    const composite = await composeRepairResult(task, row, node, related.map(repair => ({ node: repair, row: rows.get(repair.taskId) })), scope, graphNodes, client)
    return [{ ...task, status: "completed", result: composite.result, failureReason: null, repairComposite: true as const, verificationReport: composite.report, repairLineage: composite.repairLineage }]
  }))).flat()
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

async function composeRepairResult(target: ScopedDependencyResult, targetRow: Row, node: Node, repairs: Array<{ node: Node; row?: Row }>, scope: GraphIdentityScope, graphNodes: readonly Node[], client: Queryable): Promise<RepairComposition> {
  const ids = node.verification?.criteria.map(item => item.id) ?? []
  const original = record(parseResult(target.result)), report = node.verificationDisposition === "typed"
    ? parseTaskGraphVerificationReport(original?.taskGraphVerificationReport, ids) : undefined
  if (node.verificationDisposition !== "typed" || !node.verification || target.role !== node.verification.role
    || target.failureReason !== `task_graph_verification_${report?.status}` || !report
    || !taskGraphVerificationReportMatchesStatus(report, "failed")) throw new Error("task_graph_dependency_repair_source_invalid")
  const missing = new Set(report.criteria.filter(item => item.status !== "passed").map(item => item.criterionId))
  const locationEnabled = node.templateId === "scout" && node.verification?.criteria.some(item => item.check.kind === "candidate_location_in") === true
  const coverage = new Map<string, number>(), results: Array<{ result: StructuredRoleResult; criterionIds: readonly string[] }> = [], repairLineage: RepairLineage = [], locationPieces: ReverifiedScoutEvidencePiece[] = []
  const originalResult = parseFailedOriginalResult(original, node, report, target.role as StructuredRole)
  if (locationEnabled) {
    if (!originalResult) throw new Error("task_graph_dependency_repair_original_partial_unavailable")
    const verifiedOriginal = await reverifyFailedScoutLocationPartial({ client, scope, snapshot: { schemaVersion: "agent-harness.v2.task-graph", nodes: graphNodes }, node, row: targetRow, report, structuredResult: originalResult })
    if (!verifiedOriginal) throw new Error("task_graph_dependency_repair_original_provenance_unavailable")
    locationPieces.push(verifiedOriginal)
  }
  for (const { node: repair, row } of repairs) {
    const relation = repair.repairOf, repairIds = repair.verification?.criteria.map(item => item.id) ?? []
    const stored = record(parseResult(row?.result)), proof = repair.verificationDisposition === "typed"
      ? parseTaskGraphVerificationReport(stored?.taskGraphVerificationReport, repairIds) : undefined
    const receipt = parseTaskGraphRepairReceipt(stored?.taskGraphRepairReceipt, {
      repairOf: relation, repairNodeKey: repair.key, repairTaskId: repair.taskId, report: proof,
    })
    if (!relation || relation.graphRootTaskId !== scope.rootTaskId || relation.nodeKey !== node.key || relation.taskId !== node.taskId
      || row?.status !== "completed" || row.failureReason !== null || row.role !== target.role || !proof
      || !taskGraphVerificationReportMatchesStatus(proof, "completed") || !receipt
      || receipt.criterionIds.some(id => !missing.has(id))) {
      if (locationEnabled && row?.status === "completed") throw new Error("task_graph_dependency_repair_repair_provenance_unavailable")
      continue
    }
    const value = parseCompletedRepairResult(stored, repair, proof)
    const roleResult = validateRoleResult(value, target.role as StructuredRole)
    if (locationEnabled) {
      const verifiedRepair = await reverifyCompletedScoutLocationRepair({ client, scope, snapshot: { schemaVersion: "agent-harness.v2.task-graph", nodes: graphNodes }, node: repair, row, report: proof, structuredResult: roleResult })
      if (!verifiedRepair) throw new Error("task_graph_dependency_repair_repair_provenance_unavailable")
      locationPieces.push(verifiedRepair)
      results.push({ result: validateRoleResult(verifiedRepair.structuredResult, "scout"), criterionIds: receipt.criterionIds })
    } else results.push({ result: roleResult, criterionIds: receipt.criterionIds })
    if (!proof.resultDigest) throw new Error("task_graph_dependency_repair_result_digest_invalid")
    repairLineage.push({ criterionIds: receipt.criterionIds, evidenceDigest: receipt.evidenceDigest, verifierVersion: receipt.verifierVersion, resultDigest: proof.resultDigest })
    for (const id of receipt.criterionIds) coverage.set(id, (coverage.get(id) ?? 0) + 1)
  }
  if (!missing.size || [...missing].some(id => coverage.get(id) !== 1) || !results.length) {
    throw new Error("task_graph_dependency_repair_incomplete")
  }
  if (originalResult) results.unshift({ result: originalResult, criterionIds: [] })
  const merged = mergeRepairedRoleResults(results, node)
  if (merged.role !== "scout" && merged.role !== "analyst") throw new Error("task_graph_dependency_repair_role_unsupported")
  const roleResult = merged as ScoutResult | AnalystResult
  const legacyProjection = roleResult.role === "scout"
    ? { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role: roleResult.role, candidates: roleResult.candidates.map(({ jobId, evidenceIds }) => ({ jobId, evidenceIds })), evidenceIds: canonicalResultEvidenceIds(roleResult) }
    : { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role: roleResult.role, findings: roleResult.findings.map(({ jobId, score, evidenceIds }) => ({ jobId, score, evidenceIds })), evidenceIds: canonicalResultEvidenceIds(roleResult) }
  const projection = locationEnabled ? mergeReverifiedScoutLocationEvidence(locationPieces) : legacyProjection
  if (!projection || !await verifyRepairedTaskGraphFindings(client, scope, { schemaVersion: "agent-harness.v2.task-graph", nodes: graphNodes }, node, projection as TaskGraphVerificationEvidenceProjection)) {
    throw new Error("task_graph_dependency_repair_composite_unverified")
  }
  return { report, repairLineage, result: { status: "completed", stepCount: 0, toolCallCount: 0, finalItemId: null,
    finalText: "Verified repair results.", structuredResult: merged } }
}

function parseResult(value: unknown): unknown { if (typeof value !== "string") return value; try { return JSON.parse(value) as unknown } catch { return null } }
function record(value: unknown): Row | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null }
