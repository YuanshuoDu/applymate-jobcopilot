import { createHash } from "node:crypto"
import type pg from "pg"
import { evaluateTaskGraphVerification, taskGraphVerificationDependencyNodeKeys, type TaskGraphVerificationEvidenceProjection } from "../planning/task-graph-verification.js"
import { validateTaskGraphVerificationDependencySelectors } from "../planning/task-graph-verification-cross-node.js"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import { verifyCompletedTaskGraphNodeEvidence } from "./task-graph-pg-verification.js"
import { parseStoredTaskGraphVerificationReport, type TaskGraphVerificationDependencyBinding } from "./task-graph-verification-report.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
export type TaskGraphCompletedDependencyProof = Readonly<{
  projections: ReadonlyMap<string, TaskGraphVerificationEvidenceProjection>
  bindings: readonly TaskGraphVerificationDependencyBinding[]
}>

/** Rebuild full current Scout evidence and its binding from one owner-scoped graph snapshot. */
export async function verifyCompletedScoutDependencies(
  client: Queryable, scope: GraphIdentityScope, currentSnapshot: TaskGraphSnapshot, analyst: StoredTaskGraphNode,
): Promise<TaskGraphCompletedDependencyProof | null> {
  const contract = analyst.verification
  const keys = contract ? taskGraphVerificationDependencyNodeKeys(contract) : []
  if (!keys.length) return { projections: new Map(), bindings: [] }
  let snapshot: TaskGraphSnapshot
  try { snapshot = parseTaskGraphSnapshot(currentSnapshot) } catch { return null }
  if (!snapshot.nodes.some(node => node.taskId === analyst.taskId && node.key === analyst.key)
    || !validateTaskGraphVerificationDependencySelectors(snapshot.nodes)) return null
  const projections = new Map<string, TaskGraphVerificationEvidenceProjection>(), bindings: TaskGraphVerificationDependencyBinding[] = []
  for (const key of keys) {
    const source = snapshot.nodes.find(node => node.key === key)
    if (!source || !analyst.dependsOn.includes(key) || source.templateId !== "scout" || source.verificationDisposition !== "typed"
      || source.verification?.role !== "scout") return null
    const result = await client.query(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId",
        turn."rootTaskId" AS "turnRootTaskId", task."attemptCount", task."status", task."role", task."taskType", task."failureReason",
        task."expectedOutputSchema", task."allowedActions", task."result", session."userId" AS "userId"
      FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
      WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
        AND task."parentTaskId" = $5 AND turn."rootTaskId" = $4 AND session."userId" = $6 AND turn."userId" = $6`,
    [source.taskId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId])
    const task = result.rows[0] as Row | undefined
    if (!task || task.id !== source.taskId || task.sessionId !== scope.sessionId || task.turnId !== scope.turnId
      || task.rootTaskId !== scope.rootTaskId || task.parentTaskId !== scope.parentTaskId || task.turnRootTaskId !== scope.rootTaskId
      || task.userId !== scope.userId || task.status !== "completed" || task.failureReason !== null || task.role !== "scout"
      || task.taskType !== TASK_GRAPH_TEMPLATES.scout.taskType || !validAttempt(task.attemptCount)
      || !validScoutEnvelope(task.expectedOutputSchema, task.allowedActions)) return null
    const envelope = parseObject(task.result)
    if (!envelope || envelope.status !== "completed" || !Object.hasOwn(envelope, "structuredResult")) return null
    const criterionIds = source.verification.criteria.map(criterion => criterion.id)
    const stored = parseStoredTaskGraphVerificationReport(envelope.taskGraphVerificationReport, criterionIds, [])
    if (!stored || stored.status !== "passed" || !stored.resultDigest || !stored.evidenceDigest) return null
    const verified = await verifyCompletedTaskGraphNodeEvidence(client, {
      scope: { ...scope, taskId: source.taskId, attemptCount: Number(task.attemptCount) },
      snapshot, node: source, structuredResult: envelope.structuredResult,
    })
    if (!verified.verified || verified.report.status !== "passed" || !verified.projection || verified.projection.role !== "scout"
      || canonicalTaskGraphJson(verified.report) !== canonicalTaskGraphJson({
        verifierVersion: stored.verifierVersion, status: stored.status, reasonCode: stored.reasonCode, criteria: stored.criteria,
        evidenceDigest: stored.evidenceDigest, resultDigest: stored.resultDigest,
      })) return null
    projections.set(key, verified.projection)
    bindings.push({ nodeKey: key, taskId: source.taskId, attemptCount: Number(task.attemptCount),
      nodeDigest: digest(source), resultDigest: verified.report.resultDigest!, evidenceDigest: verified.report.evidenceDigest!, reportDigest: digest(verified.report) })
  }
  return { projections, bindings }
}

export async function verifyRepairedTaskGraphFindings(
  client: Queryable, scope: GraphIdentityScope, snapshot: TaskGraphSnapshot, node: StoredTaskGraphNode,
  projection: TaskGraphVerificationEvidenceProjection,
): Promise<boolean> {
  const keys = node.verification ? taskGraphVerificationDependencyNodeKeys(node.verification) : []
  const proof = keys.length ? await verifyCompletedScoutDependencies(client, scope, snapshot, node) : { projections: new Map<string, TaskGraphVerificationEvidenceProjection>(), bindings: [] }
  return Boolean(proof && node.verification && evaluateTaskGraphVerification(node.verification, projection, proof.projections).status === "passed")
}

function validScoutEnvelope(schema: unknown, actions: unknown): boolean {
  const marker = parseObject(schema)
  if (!marker || Reflect.ownKeys(marker).sort().join(",") !== "role,schemaVersion"
    || marker.schemaVersion !== ROLE_RESULT_SCHEMA || marker.role !== "scout") return false
  if (!Array.isArray(actions) || Reflect.ownKeys(actions).length !== actions.length + 1
    || actions.some(action => typeof action !== "string")) return false
  const exact = (expected: readonly string[]) => actions.length === expected.length && actions.every((action, index) => action === expected[index])
  return exact(TASK_GRAPH_TEMPLATES.scout.allowedActions) || exact(["jobs.get"])
}
function validAttempt(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 1 }
function digest(value: unknown): string { return createHash("sha256").update(canonicalTaskGraphJson(value)).digest("hex") }
function parseObject(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : null } catch { return null }
}
