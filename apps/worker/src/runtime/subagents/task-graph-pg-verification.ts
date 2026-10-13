import type pg from "pg"
import { createHash } from "node:crypto"
import { evaluateTaskGraphVerification, taskGraphVerificationRole, TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, type TaskGraphVerificationContract, type TaskGraphVerificationEvaluation, type TaskGraphVerificationEvidenceProjection, type TaskGraphVerificationReasonCode } from "../planning/task-graph-verification.js"
import { parseTaskGraphSnapshot, canonicalTaskGraphJson, type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { createObservedEvidenceIndex, hydrateObservedEvidence, parseAndBindStructuredResult } from "./child-evidence.js"
import { loadTaskGraphVerificationReceipts } from "./task-graph-pg-verification-receipts.js"
import { taskGraphEvidenceDigest, type TaskGraphVerificationScope } from "./task-graph-pg-verification-receipt-validation.js"
import { TASK_GRAPH_VERIFIER_VERSION, type TaskGraphVerificationReport } from "./task-graph-verification-report.js"
export { TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-verification-report.js"
export type { TaskGraphVerificationScope } from "./task-graph-pg-verification-receipt-validation.js"
type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
const MAX_ROLE_RESULT_BYTES = 8 * 1024
export type TaskGraphPgVerificationResult = Readonly<{ verified: boolean; report: TaskGraphVerificationReport; evaluation: TaskGraphVerificationEvaluation; projection?: TaskGraphVerificationEvidenceProjection; structuredResult?: unknown }>
/** Load canonical call/result receipts in one caller-owned transaction and evaluate the immutable node contract. */
export async function verifyTaskGraphNodeEvidence(client: Queryable, input: Readonly<{
  scope: TaskGraphVerificationScope
  snapshot: TaskGraphSnapshot
  node: StoredTaskGraphNode
  structuredResult: unknown
  dependencies?: ReadonlyMap<string, TaskGraphVerificationEvidenceProjection>
}>): Promise<TaskGraphPgVerificationResult> {
  return verifyTaskGraphEvidenceForStatus(client, input, "running")
}

/** Server-only completed-source path; ordinary child verification remains running-only. */
export async function verifyCompletedTaskGraphNodeEvidence(client: Queryable, input: Readonly<{
  scope: TaskGraphVerificationScope
  snapshot: TaskGraphSnapshot
  node: StoredTaskGraphNode
  structuredResult: unknown
}>): Promise<TaskGraphPgVerificationResult> {
  return verifyTaskGraphEvidenceForStatus(client, input, "completed")
}

async function verifyTaskGraphEvidenceForStatus(client: Queryable, input: Readonly<{
  scope: TaskGraphVerificationScope
  snapshot: TaskGraphSnapshot
  node: StoredTaskGraphNode
  structuredResult: unknown
  dependencies?: ReadonlyMap<string, TaskGraphVerificationEvidenceProjection>
}>, expectedStatus: "running" | "completed"): Promise<TaskGraphPgVerificationResult> {
  let parsedSnapshot: TaskGraphSnapshot
  try { parsedSnapshot = parseTaskGraphSnapshot(input.snapshot) } catch { return unavailable(undefined, "contract_invalid") }
  const storedNode = parsedSnapshot.nodes.find(node => node.taskId === input.scope.taskId)
  if (!storedNode || canonicalTaskGraphJson(storedNode) !== canonicalTaskGraphJson(input.node)) return unavailable(undefined, "contract_invalid")
  const contract = storedNode.verification
  const role = taskGraphVerificationRole(storedNode.templateId)
  if (storedNode.verificationDisposition !== "typed" || !contract || !role || contract.role !== role) return unavailable(contract, "contract_invalid")
  if (!validScope(input.scope)) return unavailable(contract, "canonical_evidence_invalid")
  const taskRows = await client.query(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", turn."rootTaskId" AS "turnRootTaskId",
      task."attemptCount", task."status", task."role", session."userId" AS "userId"
    FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 AND turn."rootTaskId" = $4
      AND task."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6`,
  [input.scope.taskId, input.scope.sessionId, input.scope.turnId, input.scope.rootTaskId, input.scope.parentTaskId, input.scope.userId])
  const task = taskRows.rows[0] as Row | undefined
  if (!task || task.status !== expectedStatus || task.role !== role || task.turnRootTaskId !== input.scope.rootTaskId || Number(task.attemptCount) !== input.scope.attemptCount) {
    return unavailable(contract, "canonical_evidence_invalid")
  }
  try {
    const receipts = await loadTaskGraphVerificationReceipts(client, input.scope)
    const index = createObservedEvidenceIndex()
    hydrateObservedEvidence(index, receipts.evidenceObservations)
    if (index.conflicts.size > 0) return unavailable(contract, "canonical_evidence_ambiguous")
    if (index.entries.size === 0) return unavailable(contract, "canonical_evidence_missing")
    let raw: string | undefined
    try { raw = JSON.stringify(input.structuredResult) } catch { return unavailable(contract, "result_invalid") }
    if (!raw || Buffer.byteLength(raw, "utf8") > MAX_ROLE_RESULT_BYTES) return unavailable(contract, "result_invalid")
    const bound = parseAndBindStructuredResult(raw, role, index)
    if (!bound || bound.status !== "completed") return unavailable(contract, "result_invalid")
    const projection: TaskGraphVerificationEvidenceProjection = role === "scout"
      ? { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role, candidates: bound.role === "scout" ? bound.candidates.map(({ jobId, evidenceIds }) => ({ jobId, evidenceIds })) : [], evidenceIds: [...index.entries.values()].map(item => item.id) }
      : { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role, findings: bound.role === "analyst" ? bound.findings.map(({ jobId, score, evidenceIds }) => ({ jobId, score, evidenceIds })) : [], evidenceIds: [...index.entries.values()].map(item => item.id) }
    const evaluation = evaluateTaskGraphVerification(contract, projection, input.dependencies)
    const resultDigest = taskGraphResultDigest(bound)
    const digest = taskGraphEvidenceDigest(receipts.items, receipts.outcomes, projection.evidenceIds, resultDigest, receipts.replayReceipts)
    return { verified: evaluation.status === "passed", report: report(evaluation, digest, resultDigest), evaluation, projection, structuredResult: bound }
  } catch (error) {
    const reason = error instanceof Error && /ambiguous|duplicate|conflict|replay_uncertain/.test(error.message)
      ? "canonical_evidence_ambiguous" : "canonical_evidence_invalid"
    return unavailable(contract, reason)
  }
}
function validScope(scope: TaskGraphVerificationScope): boolean {
  return [scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.taskId].every(value => typeof value === "string" && value.trim() === value && value.length > 0)
    && scope.rootTaskId === scope.parentTaskId && Number.isSafeInteger(scope.attemptCount) && scope.attemptCount >= 1
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const row = record(value); if (row) return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`
  const encoded = JSON.stringify(value); if (encoded === undefined) throw new Error("task_graph_verification_result_invalid")
  return encoded
}
export function taskGraphResultDigest(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex") }
function record(value: unknown): Row | undefined {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return undefined } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : undefined } catch { return undefined }
}
function unavailable(contract: TaskGraphVerificationContract | undefined, reasonCode: TaskGraphVerificationReasonCode): TaskGraphPgVerificationResult {
  const evaluation: TaskGraphVerificationEvaluation = { status: "unverified", reasonCode, criteria: contract?.criteria.map(item => ({ criterionId: item.id, status: "unverified" as const, reasonCode })) ?? [] }
  return { verified: false, report: report(evaluation, null, null), evaluation }
}
function report(evaluation: TaskGraphVerificationEvaluation, evidenceDigest: string | null, resultDigest: string | null): TaskGraphVerificationReport {
  return { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: evaluation.status, reasonCode: evaluation.reasonCode, criteria: evaluation.criteria, evidenceDigest, resultDigest }
}
