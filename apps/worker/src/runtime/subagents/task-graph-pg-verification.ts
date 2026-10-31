import type pg from "pg"
import { createHash } from "node:crypto"
import { evaluateTaskGraphVerification, evaluateTaskGraphVerificationWithReverifiedEmptyAnalyst, evaluateTaskGraphVerificationWithVerifiedEmptyDiscovery, taskGraphVerificationDependencyNodeKeys, taskGraphVerificationRole, TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, type TaskGraphVerificationContract, type TaskGraphVerificationEvaluation, type TaskGraphVerificationEvidenceProjection, type TaskGraphVerificationReasonCode } from "../planning/task-graph-verification.js"
import { parseTaskGraphSnapshot, canonicalTaskGraphJson, type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { createObservedEvidenceIndex, hydrateObservedEvidence, parseAndBindStructuredResult } from "./child-evidence.js"
import { loadTaskGraphVerificationReceipts } from "./task-graph-pg-verification-receipts.js"
import { taskGraphEvidenceDigest, type TaskGraphVerificationScope } from "./task-graph-pg-verification-receipt-validation.js"
import { TASK_GRAPH_EMPTY_ANALYST_VERIFIER_VERSION, TASK_GRAPH_VERIFIER_VERSION, type TaskGraphVerificationDependencyBinding, type TaskGraphVerificationReport } from "./task-graph-verification-report.js"
import { validateRoleResult, type AnalystResult } from "./role-results.js"
import { completedZeroDiscoveryDigest, emptyAnalystCoverageDigest, hasNoCurrentAttemptTaskGraphToolReceipts } from "./task-graph-empty-analyst-proof.js"
export { TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-verification-report.js"
export type { TaskGraphVerificationScope } from "./task-graph-pg-verification-receipt-validation.js"
type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
const MAX_ROLE_RESULT_BYTES = 8 * 1024
export type TaskGraphPgVerificationResult = Readonly<{ verified: boolean; report: TaskGraphVerificationReport; evaluation: TaskGraphVerificationEvaluation; projection?: TaskGraphVerificationEvidenceProjection; structuredResult?: unknown; persistDependencyBindings?: boolean }>
/** Load canonical call/result receipts in one caller-owned transaction and evaluate the immutable node contract. */
export async function verifyTaskGraphNodeEvidence(client: Queryable, input: Readonly<{
  scope: TaskGraphVerificationScope
  snapshot: TaskGraphSnapshot
  node: StoredTaskGraphNode
  structuredResult: unknown
  dependencies?: ReadonlyMap<string, TaskGraphVerificationEvidenceProjection>
  dependencyBindings?: readonly TaskGraphVerificationDependencyBinding[]
  graphRevision?: number
}>): Promise<TaskGraphPgVerificationResult> {
  return verifyTaskGraphEvidenceForStatus(client, input, "running")
}
/** Server-only completed-source path; ordinary child verification remains running-only. */
export async function verifyCompletedTaskGraphNodeEvidence(client: Queryable, input: Readonly<{
  scope: TaskGraphVerificationScope
  snapshot: TaskGraphSnapshot
  node: StoredTaskGraphNode
  structuredResult: unknown
  dependencies?: ReadonlyMap<string, TaskGraphVerificationEvidenceProjection>
  dependencyBindings?: readonly TaskGraphVerificationDependencyBinding[]
  graphRevision?: number
}>): Promise<TaskGraphPgVerificationResult> {
  return verifyTaskGraphEvidenceForStatus(client, input, "completed")
}
async function verifyTaskGraphEvidenceForStatus(client: Queryable, input: Readonly<{
  scope: TaskGraphVerificationScope
  snapshot: TaskGraphSnapshot
  node: StoredTaskGraphNode
  structuredResult: unknown
  dependencies?: ReadonlyMap<string, TaskGraphVerificationEvidenceProjection>
  dependencyBindings?: readonly TaskGraphVerificationDependencyBinding[]
  graphRevision?: number
}>, expectedStatus: "running" | "completed"): Promise<TaskGraphPgVerificationResult> {
  let parsedSnapshot: TaskGraphSnapshot
  try { parsedSnapshot = parseTaskGraphSnapshot(input.snapshot) } catch { return unavailable(undefined, "contract_invalid") }
  const storedNode = parsedSnapshot.nodes.find(node => node.taskId === input.scope.taskId)
  if (!storedNode || canonicalTaskGraphJson(storedNode) !== canonicalTaskGraphJson(input.node)) return unavailable(undefined, "contract_invalid")
  const contract = storedNode.verification
  const role = taskGraphVerificationRole(storedNode.templateId)
  if (storedNode.verificationDisposition !== "typed" || !contract || !role || contract.role !== role) return unavailable(contract, "contract_invalid")
  if (!validScope(input.scope)) return unavailable(contract, "canonical_evidence_invalid")
  const taskRows = await client.query(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", turn."rootTaskId" AS "turnRootTaskId", task."attemptCount", task."status", task."role", task."result", session."userId" AS "userId", turn."source" AS "turnSource", turn."executionMode" AS "turnExecutionMode", turn."input" AS "turnInput" FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId" JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 AND turn."rootTaskId" = $4 AND task."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6`,
  [input.scope.taskId, input.scope.sessionId, input.scope.turnId, input.scope.rootTaskId, input.scope.parentTaskId, input.scope.userId])
  const task = taskRows.rows[0] as Row | undefined
  if (!task || task.status !== expectedStatus || task.role !== role || task.turnRootTaskId !== input.scope.rootTaskId || Number(task.attemptCount) !== input.scope.attemptCount) return unavailable(contract, "canonical_evidence_invalid")
  try {
    if (expectedStatus === "running" && role === "analyst" && contract.criteria.some(item => item.check.kind === "findings_cover_each_scout_candidates_gte")) {
      const emptyAnalyst = validateRoleResult(input.structuredResult, "analyst")
      if (emptyAnalyst.status === "completed" && emptyAnalyst.findings.length === 0 && emptyAnalyst.evidence.length === 0) {
        if (!await hasNoCurrentAttemptTaskGraphToolReceipts(client, input.scope)) return unavailable(contract, "canonical_evidence_invalid")
        const dependencyNodeKeys = taskGraphVerificationDependencyNodeKeys(contract), resultDigest = taskGraphResultDigest(emptyAnalyst)
        const digest = input.graphRevision === undefined || !input.dependencies || !input.dependencyBindings ? undefined
          : emptyAnalystCoverageDigest({ scope: input.scope, node: storedNode, resultDigest, dependencyNodeKeys, dependencyBindings: input.dependencyBindings })
        if (!digest) return unavailable(contract, "canonical_evidence_missing")
        const projection: TaskGraphVerificationEvidenceProjection = { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
          role: "analyst", findings: [], evidenceIds: [] }
        const evaluation = evaluateTaskGraphVerificationWithReverifiedEmptyAnalyst(contract, projection, input.dependencies)
        if (evaluation.status === "failed") return { verified: false,
          report: { ...report(evaluation, digest, resultDigest), verifierVersion: TASK_GRAPH_EMPTY_ANALYST_VERIFIER_VERSION },
          evaluation, projection, structuredResult: emptyAnalyst, persistDependencyBindings: true }
        return unavailable(contract, evaluation.status === "unverified" ? evaluation.reasonCode : "canonical_evidence_missing")
      }
    }
    const emptyAnalyst = expectedStatus === "completed" && role === "analyst" ? persistedEmptyAnalystResult(task.result, input.structuredResult) : undefined
    if (emptyAnalyst) {
      const digest = await verifiedEmptyScoutDependencyDigest(client, input.scope, parsedSnapshot, storedNode, input.dependencies)
      if (!digest) return unavailable(contract, "canonical_evidence_missing")
      if (!await hasNoCurrentAttemptTaskGraphToolReceipts(client, input.scope)) return unavailable(contract, "canonical_evidence_invalid")
      const projection: TaskGraphVerificationEvidenceProjection = { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role: "analyst", findings: [], evidenceIds: [], emptyDiscoveryReceipt: { digest } }
      const evaluation = evaluateTaskGraphVerificationWithVerifiedEmptyDiscovery(contract, projection, input.dependencies, digest), resultDigest = taskGraphResultDigest(emptyAnalyst)
      const evidenceDigest = sha256(canonicalJson({ schemaVersion: "agent-harness.v2.task-graph.empty-analyst-receipt.v1", scope: input.scope, scoutDigest: digest, resultDigest, items: [], events: [] }))
      return { verified: evaluation.status === "passed", report: report(evaluation, evidenceDigest, resultDigest), evaluation, projection, structuredResult: emptyAnalyst }
    }
    const receipts = await loadTaskGraphVerificationReceipts(client, input.scope)
    const index = createObservedEvidenceIndex()
    hydrateObservedEvidence(index, receipts.evidenceObservations)
    if (index.conflicts.size > 0) return unavailable(contract, "canonical_evidence_ambiguous")
    let raw: string | undefined
    try { raw = JSON.stringify(input.structuredResult) } catch { return unavailable(contract, "result_invalid") }
    if (!raw || Buffer.byteLength(raw, "utf8") > MAX_ROLE_RESULT_BYTES) return unavailable(contract, "result_invalid")
    const bound = parseAndBindStructuredResult(raw, role, index)
    if (!bound || bound.status !== "completed") return unavailable(contract, index.entries.size === 0 ? "canonical_evidence_missing" : "result_invalid")
    let verifiedEmptyDiscoveryDigest: string | undefined
    let projection: TaskGraphVerificationEvidenceProjection
    if (index.entries.size === 0 && role === "scout" && bound.role === "scout" && bound.candidates.length === 0) {
      const persistedScout = persistedEmptyScoutResult(task.result, input.structuredResult)
      if (!persistedScout) return unavailable(contract, "canonical_evidence_missing")
      verifiedEmptyDiscoveryDigest = await completedZeroDiscoveryDigest(client, input.scope, receipts, task)
      if (!verifiedEmptyDiscoveryDigest) return unavailable(contract, "canonical_evidence_missing")
      projection = {
        schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role,
        candidates: [], evidenceIds: [`read:source:jobs.discover:${verifiedEmptyDiscoveryDigest}`],
        emptyDiscoveryReceipt: { digest: verifiedEmptyDiscoveryDigest },
      }
    } else if (index.entries.size === 0 && role === "analyst" && bound.role === "analyst" && bound.findings.length === 0) {
      verifiedEmptyDiscoveryDigest = await verifiedEmptyScoutDependencyDigest(client, input.scope, parsedSnapshot, storedNode, input.dependencies)
      if (!verifiedEmptyDiscoveryDigest) return unavailable(contract, "canonical_evidence_missing")
      projection = {
        schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role,
        findings: [], evidenceIds: [], emptyDiscoveryReceipt: { digest: verifiedEmptyDiscoveryDigest },
      }
    } else {
      if (index.entries.size === 0) return unavailable(contract, "canonical_evidence_missing")
      projection = role === "scout"
        ? { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role, candidates: bound.role === "scout" ? bound.candidates.map(({ jobId, evidenceIds }) => ({ jobId, evidenceIds })) : [], evidenceIds: [...index.entries.values()].map(item => item.id) }
        : { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role, findings: bound.role === "analyst" ? bound.findings.map(({ jobId, score, evidenceIds }) => ({ jobId, score, evidenceIds })) : [], evidenceIds: [...index.entries.values()].map(item => item.id) }
    }
    const evaluation = verifiedEmptyDiscoveryDigest
      ? evaluateTaskGraphVerificationWithVerifiedEmptyDiscovery(contract, projection, input.dependencies, verifiedEmptyDiscoveryDigest)
      : evaluateTaskGraphVerification(contract, projection, input.dependencies)
    const resultDigest = taskGraphResultDigest(bound)
    const digestEvidenceIds = verifiedEmptyDiscoveryDigest ? [...projection.evidenceIds, `read:source:jobs.discover:${verifiedEmptyDiscoveryDigest}`] : projection.evidenceIds
    const digest = taskGraphEvidenceDigest(receipts.items, receipts.outcomes, digestEvidenceIds, resultDigest, receipts.replayReceipts)
    return { verified: evaluation.status === "passed", report: report(evaluation, digest, resultDigest), evaluation, projection, structuredResult: bound }
  } catch (error) {
    const reason = error instanceof Error && /ambiguous|duplicate|conflict|replay_uncertain/.test(error.message)
      ? "canonical_evidence_ambiguous" : "canonical_evidence_invalid"
    return unavailable(contract, reason)
  }
}

function persistedEmptyScoutResult(envelopeValue: unknown, resultValue: unknown): unknown | undefined {
  try { const envelope = record(envelopeValue), parsed = validateRoleResult(resultValue, "scout"); return envelope?.status === "completed" && canonicalJson(envelope.structuredResult) === canonicalJson(resultValue) && parsed.status === "completed" && parsed.candidates.length === 0 && parsed.evidence.length === 0 ? parsed : undefined } catch { return undefined }
}
function persistedEmptyAnalystResult(envelopeValue: unknown, resultValue: unknown): AnalystResult | undefined {
  try { const envelope = record(envelopeValue), parsed = validateRoleResult(resultValue, "analyst"); return envelope?.status === "completed" && canonicalJson(envelope.structuredResult) === canonicalJson(resultValue) && parsed.status === "completed" && parsed.findings.length === 0 && parsed.evidence.length === 0 ? parsed as AnalystResult : undefined } catch { return undefined }
}
async function verifiedEmptyScoutDependencyDigest(
  client: Queryable,
  scope: TaskGraphVerificationScope,
  snapshot: TaskGraphSnapshot,
  analyst: StoredTaskGraphNode,
  dependencies: ReadonlyMap<string, TaskGraphVerificationEvidenceProjection> | undefined,
): Promise<string | undefined> {
  const keys = analyst.verification ? taskGraphVerificationDependencyNodeKeys(analyst.verification) : []
  if (keys.length !== 1 || !dependencies || dependencies.size !== 1 || !dependencies.has(keys[0]!)) return undefined
  const source = snapshot.nodes.find(node => node.key === keys[0])
  if (!source || !analyst.dependsOn.includes(source.key) || source.templateId !== "scout" || source.verificationDisposition !== "typed"
    || source.verification?.role !== "scout" || !source.taskId) return undefined
  const sourceRows = await client.query(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", task."attemptCount", task."status", task."role", task."failureReason", task."result", session."userId" AS "userId" FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId" JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 AND task."parentTaskId" = $5 AND turn."rootTaskId" = $4 AND session."userId" = $6 AND turn."userId" = $6`,
  [source.taskId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId])
  const task = record(sourceRows.rows[0]), envelope = record(task?.result)
  if (!task || task.id !== source.taskId || task.sessionId !== scope.sessionId || task.turnId !== scope.turnId
    || task.rootTaskId !== scope.rootTaskId || task.parentTaskId !== scope.parentTaskId || task.userId !== scope.userId
    || task.status !== "completed" || task.failureReason !== null || task.role !== "scout" || !validAttempt(task.attemptCount)
    || !envelope || envelope.status !== "completed" || !Object.hasOwn(envelope, "structuredResult")) return undefined
  const proof = await verifyTaskGraphEvidenceForStatus(client, {
    scope: { ...scope, taskId: source.taskId, attemptCount: Number(task.attemptCount) },
    snapshot, node: source, structuredResult: envelope.structuredResult,
  }, "completed")
  const marker = proof.projection?.emptyDiscoveryReceipt
  if (!proof.verified || proof.report.status !== "passed" || proof.projection?.role !== "scout" || !marker
    || canonicalTaskGraphJson(dependencies.get(source.key)) !== canonicalTaskGraphJson(proof.projection)) return undefined
  return marker.digest
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
function strictText(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 }
function validAttempt(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 1 }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex") }
