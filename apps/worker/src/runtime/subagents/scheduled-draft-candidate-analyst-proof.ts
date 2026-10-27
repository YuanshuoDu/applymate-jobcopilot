import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import type pg from "pg"
import { evaluateTaskGraphVerification, taskGraphVerificationDependencyNodeKeys, type TaskGraphVerificationContract,
  type TaskGraphVerificationEvidenceProjection } from "../planning/task-graph-verification.js"
import { verifyCompletedScoutDependencies } from "./task-graph-pg-completed-dependency-verification.js"
import { verifyCompletedTaskGraphNodeEvidence, taskGraphResultDigest } from "./task-graph-pg-verification.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson, type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { parseStoredTaskGraphVerificationReport, type TaskGraphVerificationDependencyBinding } from "./task-graph-verification-report.js"
import { ROLE_RESULT_SCHEMA, validateRoleResult, type AnalystResult } from "./role-results.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
export type ScheduledDraftAnalystProof = Readonly<{
  result: AnalystResult
  binding: Readonly<{ nodeKey: string; taskId: string; attemptCount: number; resultDigest: string; evidenceDigest: string;
    reportDigest: string; scouts: readonly TaskGraphVerificationDependencyBinding[] }>
}>

export function hasScheduledDraftMembershipRequirement(verification: TaskGraphVerificationContract | undefined): boolean {
  return Boolean(verification?.criteria.some(({ check }) => check.kind === "findings_from_scout_dependency"
    || check.kind === "findings_from_scout_union"))
}

export async function readScheduledDraftAnalystProof(client: Queryable, scope: GraphIdentityScope,
  snapshot: TaskGraphSnapshot, node: StoredTaskGraphNode): Promise<ScheduledDraftAnalystProof | null> {
  const verification = node.verification, keys = verification ? taskGraphVerificationDependencyNodeKeys(verification) : []
  if (node.templateId !== "analyst" || node.verificationDisposition !== "typed" || verification?.role !== "analyst"
    || !hasScheduledDraftMembershipRequirement(verification) || !keys.length || keys.some(key => !node.dependsOn.includes(key))) return null
  const scouts = await verifyCompletedScoutDependencies(client, scope, snapshot, node)
  if (!scouts?.bindings.length) return null
  const query = await client.query(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", task."attemptCount", task."status",
      task."role", task."taskType", task."failureReason", task."expectedOutputSchema", task."allowedActions", task."result",
      turn."rootTaskId" AS "turnRootTaskId", session."userId" AS "userId"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
      AND task."parentTaskId" = $5 AND turn."rootTaskId" = $4 AND session."userId" = $6 AND turn."userId" = $6`,
  [node.taskId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId])
  const task = query.rows[0] as Row | undefined
  if (query.rows.length !== 1 || !task || task.id !== node.taskId || task.sessionId !== scope.sessionId || task.turnId !== scope.turnId
    || task.rootTaskId !== scope.rootTaskId || task.parentTaskId !== scope.parentTaskId || task.turnRootTaskId !== scope.rootTaskId
    || task.userId !== scope.userId || task.status !== "completed" || task.failureReason !== null || task.role !== "analyst"
    || !validAttempt(task.attemptCount) || !validAnalystEnvelope(task.taskType, task.expectedOutputSchema, task.allowedActions)) return null
  const envelope = parseCompletedEnvelope(task.result)
  if (!envelope) return null
  let result: AnalystResult
  try { result = validateRoleResult(envelope.structuredResult, "analyst") } catch { return null }
  const report = parseStoredTaskGraphVerificationReport(envelope.report, verification.criteria.map(item => item.id), keys)
  if (!report || report.status !== "passed" || canonicalTaskGraphJson(report.dependencyBindings) !== canonicalTaskGraphJson(scouts.bindings)) return null
  const proof = await verifyCompletedTaskGraphNodeEvidence(client, { scope: { ...scope, taskId: node.taskId, attemptCount: Number(task.attemptCount) }, snapshot, node, structuredResult: envelope.structuredResult })
  if (!proof.projection || proof.projection.role !== "analyst") return null
  const evaluation = evaluateTaskGraphVerification(verification, proof.projection, scouts.projections)
  if (evaluation.status !== report.status || evaluation.reasonCode !== report.reasonCode
    || canonicalTaskGraphJson(evaluation.criteria) !== canonicalTaskGraphJson(report.criteria)
    || proof.report.evidenceDigest !== report.evidenceDigest || proof.report.resultDigest !== report.resultDigest
    || taskGraphResultDigest(result) !== report.resultDigest) return null
  const binding = { nodeKey: node.key, taskId: node.taskId, attemptCount: Number(task.attemptCount), resultDigest: proof.report.resultDigest!,
    evidenceDigest: proof.report.evidenceDigest!, reportDigest: digest(report), scouts: [...scouts.bindings].sort((a, b) => compareBytesText(a.nodeKey, b.nodeKey)) }
  return { result, binding }
}

function parseCompletedEnvelope(value: unknown): { structuredResult: unknown; report: unknown } | undefined {
  const row = plainRecord(parseJson(value))
  if (!row || Object.keys(row).sort().join(",") !== "finalItemId,finalText,status,stepCount,structuredResult,taskGraphVerificationReport,toolCallCount"
    || row.status !== "completed" || (row.finalItemId !== null && typeof row.finalItemId !== "string") || typeof row.finalText !== "string"
    || !Number.isSafeInteger(row.stepCount) || Number(row.stepCount) < 0 || !Number.isSafeInteger(row.toolCallCount) || Number(row.toolCallCount) < 0 || !Object.hasOwn(row, "structuredResult")) return undefined
  return { structuredResult: row.structuredResult, report: row.taskGraphVerificationReport }
}
function validAnalystEnvelope(taskType: unknown, schema: unknown, actions: unknown): boolean {
  const marker = plainRecord(parseJson(schema))
  const exactActions = (expected: readonly string[]) => Array.isArray(actions) && actions.length === expected.length
    && Reflect.ownKeys(actions).length === actions.length + 1 && expected.every((action, index) => actions[index] === action)
  return Boolean(marker && Reflect.ownKeys(marker).every(key => typeof key === "string") && Object.keys(marker).sort().join(",") === "role,schemaVersion"
    && marker.schemaVersion === ROLE_RESULT_SCHEMA && marker.role === "analyst" && taskType === TASK_GRAPH_TEMPLATES.analyst.taskType
    && (exactActions(TASK_GRAPH_TEMPLATES.analyst.allowedActions) || exactActions(["jobs.get", "persona.retrieve", "resume.get_base"])))
}
function validAttempt(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 1 }
function digest(value: unknown): string { return createHash("sha256").update(canonicalTaskGraphJson(value)).digest("hex") }
function compareBytesText(left: string, right: string): number { return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")) }
function parseJson(value: unknown): unknown { if (typeof value !== "string") return value; try { return JSON.parse(value) as unknown } catch { return undefined } }
function plainRecord(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null ? value as Row : undefined } catch { return undefined }
}
