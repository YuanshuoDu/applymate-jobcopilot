import type pg from "pg"
import {
  evaluateTaskGraphVerification,
  evaluateTaskGraphVerificationWithReverifiedEmptyAnalyst,
  taskGraphVerificationDependencyNodeKeys,
  TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
  type TaskGraphVerificationEvidenceProjection,
} from "../planning/task-graph-verification.js"
import type { GraphIdentityScope, LoadedGraph } from "./task-graph-pg-state.js"
import { emptyAnalystCoverageDigest, hasNoCurrentAttemptTaskGraphToolReceipts } from "./task-graph-empty-analyst-proof.js"
import { parseStoredTaskGraphVerificationReport, TASK_GRAPH_EMPTY_ANALYST_VERIFIER_VERSION } from "./task-graph-verification-report.js"
import { canonicalTaskGraphJson } from "./task-graph-snapshot.js"
import { verifyCompletedScoutDependencies } from "./task-graph-pg-completed-dependency-verification.js"
import { loadTaskGraphDependencyResults } from "./task-graph-pg-dependency-context-loader.js"
import { validateRoleResult } from "./role-results.js"
import { taskGraphResultDigest, type TaskGraphVerificationScope } from "./task-graph-pg-verification.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>

/** Verifies private source bindings before any current graph projection or completion decision. */
export async function revalidateTaskGraphDependencyBindings(client: Queryable, scope: GraphIdentityScope, loaded: LoadedGraph): Promise<LoadedGraph> {
  const snapshot = loaded.snapshot
  if (!snapshot) return loaded
  const typedNodes = snapshot.nodes.filter(node => node.verificationDisposition === "typed" && node.verification)
  if (!typedNodes.length) return loaded
  for (const node of typedNodes) {
    const task = loaded.tasks.get(node.taskId), result = parseObject(task?.result)
    const storedValue = parseObject(result?.taskGraphVerificationReport)
    const keys = taskGraphVerificationDependencyNodeKeys(node.verification!)
    if (!keys.length && !storedValue?.dependencyBindings) continue
    if (!result || !Object.hasOwn(result, "taskGraphVerificationReport")) continue
    const report = parseStoredTaskGraphVerificationReport(result.taskGraphVerificationReport, node.verification!.criteria.map(item => item.id), keys)
    if (!report) throw new Error("task_graph_verification_report_invalid")
    if (report.status !== "passed" && !report.dependencyBindings) continue
    const proof = await verifyCompletedScoutDependencies(client, scope, snapshot, node)
    if (!proof || !report.dependencyBindings
      || canonicalTaskGraphJson(report.dependencyBindings) !== canonicalTaskGraphJson(proof.bindings)) {
      throw new Error("task_graph_verification_report_invalid")
    }
    if (report.verifierVersion === TASK_GRAPH_EMPTY_ANALYST_VERIFIER_VERSION) {
      if (!task) throw new Error("task_graph_verification_report_invalid")
      await validateFailedEmptyAnalyst(client, scope, task, result, node, report, proof.projections, proof.bindings)
      continue
    }
    if (report.status === "passed") {
      if (!task) throw new Error("task_graph_verification_report_invalid")
      validateCurrentAnalyst(task, result, node, report, proof.projections)
    }
  }
  for (const key of loaded.state?.repairSatisfiedNodeKeys ?? []) {
    const target = snapshot.nodes.find(node => node.key === key)
    if (!target?.verification || !taskGraphVerificationDependencyNodeKeys(target.verification).length) continue
    const [composite] = await loadTaskGraphDependencyResults(client, scope, [key], snapshot.nodes)
    if (!composite?.repairComposite) throw new Error("task_graph_verification_report_invalid")
  }
  return loaded
}

async function validateFailedEmptyAnalyst(
  client: Queryable,
  scope: GraphIdentityScope,
  task: NonNullable<ReturnType<LoadedGraph["tasks"]["get"]>>,
  result: Row,
  node: NonNullable<LoadedGraph["snapshot"]>["nodes"][number],
  report: NonNullable<ReturnType<typeof parseStoredTaskGraphVerificationReport>>,
  dependencies: ReadonlyMap<string, TaskGraphVerificationEvidenceProjection>,
  dependencyBindings: Parameters<typeof emptyAnalystCoverageDigest>[0]["dependencyBindings"],
): Promise<void> {
  if (report.verifierVersion !== TASK_GRAPH_EMPTY_ANALYST_VERIFIER_VERSION || report.status !== "failed"
    || !node.verification || node.templateId !== "analyst" || task.role !== "analyst" || task.status !== "failed"
    || task.failureReason !== "task_graph_verification_failed" || !Number.isSafeInteger(task.attemptCount) || Number(task.attemptCount) < 1) {
    throw new Error("task_graph_verification_report_invalid")
  }
  let analyst: ReturnType<typeof validateRoleResult>
  try { analyst = validateRoleResult(result.structuredResult, "analyst") } catch { throw new Error("task_graph_verification_report_invalid") }
  if (analyst.role !== "analyst" || analyst.status !== "completed" || analyst.findings.length !== 0 || analyst.evidence.length !== 0) {
    throw new Error("task_graph_verification_report_invalid")
  }
  const resultDigest = taskGraphResultDigest(analyst)
  const dependencyNodeKeys = taskGraphVerificationDependencyNodeKeys(node.verification)
  const verificationScope: TaskGraphVerificationScope = { ...scope, taskId: node.taskId, attemptCount: Number(task.attemptCount) }
  if (resultDigest !== report.resultDigest || dependencyNodeKeys.length < 2
    || !await hasNoCurrentAttemptTaskGraphToolReceipts(client, verificationScope)) {
    throw new Error("task_graph_verification_report_invalid")
  }
  const projection: TaskGraphVerificationEvidenceProjection = {
    schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role: "analyst", findings: [], evidenceIds: [],
  }
  const evaluation = evaluateTaskGraphVerificationWithReverifiedEmptyAnalyst(node.verification, projection, dependencies)
  if (evaluation.status !== "failed" || canonicalTaskGraphJson({ status: evaluation.status, reasonCode: evaluation.reasonCode, criteria: evaluation.criteria })
    !== canonicalTaskGraphJson({ status: report.status, reasonCode: report.reasonCode, criteria: report.criteria })) {
    throw new Error("task_graph_verification_report_invalid")
  }
  const digest = emptyAnalystCoverageDigest({ scope: verificationScope, node, resultDigest, dependencyNodeKeys, dependencyBindings })
  if (!digest || digest !== report.evidenceDigest) throw new Error("task_graph_verification_report_invalid")
}

function validateCurrentAnalyst(
  task: NonNullable<ReturnType<LoadedGraph["tasks"]["get"]>>,
  result: Row,
  node: NonNullable<LoadedGraph["snapshot"]>["nodes"][number],
  report: NonNullable<ReturnType<typeof parseStoredTaskGraphVerificationReport>>,
  dependencies: ReadonlyMap<string, TaskGraphVerificationEvidenceProjection>,
): void {
  if (!node.verification || task.status !== "completed" || task.failureReason !== null || task.role !== "analyst") {
    throw new Error("task_graph_verification_report_invalid")
  }
  let analyst: ReturnType<typeof validateRoleResult>
  try { analyst = validateRoleResult(result.structuredResult, "analyst") } catch { throw new Error("task_graph_verification_report_invalid") }
  if (analyst.role !== "analyst" || analyst.status !== "completed"
    || taskGraphResultDigest(analyst) !== report.resultDigest) throw new Error("task_graph_verification_report_invalid")
  const projection: TaskGraphVerificationEvidenceProjection = {
    schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
    role: "analyst",
    findings: analyst.findings.map(({ jobId, score, evidenceIds }) => ({ jobId, score, evidenceIds })),
    evidenceIds: analyst.evidence.map(item => item.id),
  }
  const evaluation = evaluateTaskGraphVerification(node.verification, projection, dependencies)
  if (evaluation.status !== "passed" || canonicalTaskGraphJson({ status: evaluation.status, reasonCode: evaluation.reasonCode, criteria: evaluation.criteria })
    !== canonicalTaskGraphJson({ status: report.status, reasonCode: report.reasonCode, criteria: report.criteria })) {
    throw new Error("task_graph_verification_report_invalid")
  }
}

function parseObject(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : null } catch { return null }
}
