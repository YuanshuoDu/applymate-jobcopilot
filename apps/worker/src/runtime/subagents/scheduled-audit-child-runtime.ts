import type pg from "pg"
import type { SubagentExecutor } from "../../queue/subagent-queue.js"
import { postScheduledPipelineExecute } from "./scheduled-pipeline-handoff.js"
import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.js"
import { currentTaskGraph, loadTaskGraph, type GraphIdentityScope, type GraphTaskRow } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson, taskGraphFingerprint } from "./task-graph-snapshot.js"
import { scheduledGateCheckpointEvidence, scheduledGatePreparedJobIds, SCHEDULED_GATE_OUTPUT_SCHEMA, SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE } from "./scheduled-gate-contract.js"
import { readScheduledGateRegistrationReceipt } from "./scheduled-gate-registration-receipt.js"
import { loadPersistedScheduledPrepareProof } from "./scheduled-gate-wait-match.js"
import { scheduledSnapshotMatches } from "./scheduled-taskgraph-continuation-receipt.js"
import { parseDiscoveryAttemptSidecar } from "./child-discovery-attempt.js"
import { validateRoleResult, type AnalystResult, type ScoutResult } from "./role-results.js"
import { parseStoredTaskGraphVerificationReport } from "./task-graph-verification-report.js"
import { parseScheduledAutomationSnapshot } from "./scheduled-automation-snapshot.js"
import { parseScheduledAuditReport, parseScheduledAuditTaskEnvelope, SCHEDULED_AUDIT_TEMPLATE_ID,
  SCHEDULED_AUDIT_INVOCATION_PROOF_SCHEMA, SCHEDULED_AUDIT_OUTPUT_SCHEMA, SCHEDULED_AUDIT_ROLE, SCHEDULED_AUDIT_TASK_TYPE,
  type ScheduledAuditInvocationProof } from "./scheduled-audit-contract.js"
import type { ScheduledAutomationPipelineAttestation, ScheduledAutomationPipelineBridgeScope } from "./scheduled-automation-pipeline-bridge.js"
import type { ScheduledPrepareTaskGraphProof } from "./scheduled-prepare-task-graph-verification.js"
import type { SubagentExecutionResult, SubagentLease } from "./types.js"

type Queryable = Pick<pg.PoolClient, "query">; type Row = Record<string, unknown>
type Invocation = Parameters<typeof postScheduledPipelineExecute>[0]; type RuntimeOptions = Readonly<{ pool: Pick<pg.Pool, "connect">; fetcher?: typeof fetch; now?: () => Date }>
type StableOwner = Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string; rootAttemptCount: number; executionId: string; executionAttemptCount: number }>
const invocationValidationFailures = new Set([
  "scheduled_audit_checkpoint_invalid", "scheduled_audit_owner_stale", "scheduled_audit_graph_invalid",
  "scheduled_audit_gate_registration_invalid", "scheduled_audit_prepare_proof_invalid",
  "scheduled_audit_analyze_proof_invalid", "scheduled_audit_invocation_proof_invalid",
])
export function isScheduledAuditCandidate(task: Pick<SubagentLease, "role" | "taskType">): boolean {
  return task.taskType === SCHEDULED_AUDIT_TASK_TYPE
}
export function isScheduledAuditTask(task: Pick<SubagentLease, "role" | "taskType">): boolean {
  return task.role === SCHEDULED_AUDIT_ROLE && task.taskType === SCHEDULED_AUDIT_TASK_TYPE
}
export function isScheduledAuditLease(lease: SubagentLease, now = new Date()): boolean {
  return lease.role === SCHEDULED_AUDIT_ROLE && lease.taskType === SCHEDULED_AUDIT_TASK_TYPE
    && Boolean(lease.turnId) && lease.parentTaskId === lease.rootTaskId
    && lease.status === "running" && lease.leaseOwner === lease.ownerId && lease.interruptRequestedAt === null
    && Number.isSafeInteger(lease.attemptCount) && lease.attemptCount > 0
    && lease.leaseExpiresAt instanceof Date && lease.leaseExpiresAt.getTime() > now.getTime()
    && same(lease.expectedOutputSchema, SCHEDULED_AUDIT_OUTPUT_SCHEMA)
    && Array.isArray(lease.allowedActions) && Reflect.ownKeys(lease.allowedActions).length === 1 && lease.allowedActions.length === 0
}
export function createScheduledAuditChildExecutor(options: RuntimeOptions): SubagentExecutor {
  return async ({ lease, continuation }) => {
    const now = options.now?.() ?? new Date()
    if (continuation) return terminal("scheduled_audit_continuation_unsupported")
    if (!isScheduledAuditLease(lease, now)) return terminal("scheduled_audit_task_invalid")
    if (lease.signal.aborted) throw lease.signal.reason ?? new Error("scheduled_audit_cancelled")
    try {
      const invocation = await loadScheduledAuditInvocation(options.pool, lease, now)
      if (lease.signal.aborted) throw lease.signal.reason ?? new Error("scheduled_audit_cancelled")
      const outcome = await postScheduledPipelineExecute(invocation, lease.signal, options.fetcher)
      if (outcome.status === "blocked") return terminal(outcome.errorCode)
      if (outcome.status === "waiting_for_user") return terminal("scheduled_audit_wait_unsupported")
      if (lease.signal.aborted) throw lease.signal.reason ?? new Error("scheduled_audit_cancelled")
      const report = parseScheduledAuditReport(outcome.report)
      const result = report && parseScheduledAuditTaskEnvelope({ finalItemId: null, finalText: "", status: "completed",
        stepCount: 0, toolCallCount: 0, taskGraphVerificationReport: null, structuredResult: report }, "completed")
      return result ? { status: "completed", result } : terminal("scheduled_audit_report_invalid")
    } catch (error: unknown) {
      if (lease.signal.aborted) throw lease.signal.reason ?? error
      const code = error instanceof Error ? error.message : ""
      return retryable(code) ? { status: "failed", failureReason: "scheduled_audit_handoff_retryable", retryDisposition: "retryable" }
        : { status: "failed", failureReason: invocationValidationFailures.has(code) ? code : "scheduled_audit_runtime_failed", retryDisposition: "terminal" }
    }
  }
}
async function loadScheduledAuditInvocation(pool: Pick<pg.Pool, "connect">, lease: SubagentLease, now: Date): Promise<Invocation> {
  const client = await pool.connect()
  let attestation: ScheduledAutomationPipelineAttestation, prepareProof: ScheduledPrepareTaskGraphProof, gateTaskId = ""
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    await client.query("SELECT set_config('app.user_id', $1, true)", [lease.userId])
    const live = await readLiveScope(client, lease, now), evidence = scheduledGateCheckpointEvidence(live.state)
    if (!evidence || evidence.owner.userId !== lease.userId || evidence.owner.sessionId !== lease.sessionId
      || evidence.owner.turnId !== lease.turnId || evidence.owner.rootTaskId !== lease.rootTaskId
      || evidence.owner.rootAttemptCount !== Number(live.rootAttemptCount) || evidence.owner.executionId !== live.executionId
      || evidence.owner.executionAttemptCount !== Number(live.executionAttemptCount)
      || !scheduledSnapshotMatches({ source: live.source, executionMode: live.executionMode, input: live.turnInput }, evidence.snapshotDigest)) {
      throw new Error("scheduled_audit_checkpoint_invalid")
    }
    const scope: GraphIdentityScope = { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId!,
      rootTaskId: lease.rootTaskId, parentTaskId: lease.rootTaskId }
    const graph = await loadTaskGraph(client, scope, false), snapshot = graph.snapshot, state = graph.state, current = currentTaskGraph(graph)
    const audit = snapshot?.nodes.find(node => node.key === SCHEDULED_AUDIT_TEMPLATE_ID), auditState = state?.nodes.find(node => node.key === SCHEDULED_AUDIT_TEMPLATE_ID)
    const gate = snapshot?.nodes.find(node => node.key === "gate"), prepare = snapshot?.nodes.find(node => node.key === "prepare")
    const auditTask = audit && graph.tasks.get(audit.taskId), gateTask = gate && graph.tasks.get(gate.taskId), prepareTask = prepare && graph.tasks.get(prepare.taskId)
    if (!snapshot || !state || snapshot.nodes.length !== 5 || !audit || audit.taskId !== lease.id || audit.templateId !== "scheduled_audit"
      || audit.depth !== 5 || audit.verificationDisposition !== "legacy_unverified" || !same(audit.dependsOn, ["gate"])
      || !auditState || auditState.status !== "running" || !auditTask || auditTask.status !== "running"
      || auditTask.attemptCount !== lease.attemptCount || auditTask.role !== SCHEDULED_AUDIT_ROLE || auditTask.taskType !== SCHEDULED_AUDIT_TASK_TYPE
      || !same(auditTask.expectedOutputSchema, SCHEDULED_AUDIT_OUTPUT_SCHEMA) || !same(auditTask.allowedActions, [])
      || !gate || gate.templateId !== "gate" || gate.verificationDisposition !== "specialized"
      || !same(gate.dependsOn, ["prepare"]) || !gateTask || gateTask.status !== "completed"
      || gateTask.role !== SCHEDULED_GATE_ROLE || gateTask.taskType !== SCHEDULED_GATE_TASK_TYPE
      || !same(gateTask.expectedOutputSchema, SCHEDULED_GATE_OUTPUT_SCHEMA) || !same(gateTask.allowedActions, [])
      || !prepare || !prepareTask || prepareTask.status !== "completed"
      || current.nodes.length !== 5) throw new Error("scheduled_audit_graph_invalid")
    const owner = stableOwner(evidence.owner), gateRegistration = await readScheduledGateRegistrationReceipt(client, {
      userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId!, owner, gateTaskId: gate.taskId,
    })
    gateTaskId = gate.taskId
    if (!gateRegistration || gateRegistration.continuationKey !== evidence.continuationKey
      || gateRegistration.snapshotDigest !== evidence.snapshotDigest || gateRegistration.evidenceDigest !== evidence.evidenceDigest
      || gateRegistration.checkpointDigest !== evidence.checkpointDigest || gateRegistration.analyzeGraphRevision !== evidence.analyzeGraphRevision) {
      throw new Error("scheduled_audit_gate_registration_invalid")
    }
    const loadedPrepare = await loadPersistedScheduledPrepareProof(client,
      { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId!, rootTaskId: lease.rootTaskId }, prepare.taskId,
      prepareTask.result, evidence.prepareWaitContinuationKey, gateRegistration.prepareWaitId)
    if (!loadedPrepare || !scheduledGatePreparedJobIds(loadedPrepare) || !samePreparedLineage(loadedPrepare, gateRegistration)
      || !same(stableOwner(loadedPrepare.receipt.owner), evidence.owner)) throw new Error("scheduled_audit_prepare_proof_invalid")
    prepareProof = loadedPrepare
    const built = buildAttestation(pipelineOwner(prepareProof.receipt.owner), evidence.snapshotDigest, evidence.evidenceDigest,
      evidence.analyzeGraphRevision, snapshot.nodes, graph.tasks)
    if (!built) throw new Error("scheduled_audit_analyze_proof_invalid")
    attestation = built
    await client.query("COMMIT")
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
  const command = createPgTaskGraphCommandPort(pool as never)
  const proof = await command.readScheduledAuditInvocationProof?.({ scope: { userId: lease.userId, sessionId: lease.sessionId,
    turnId: lease.turnId!, rootTaskId: lease.rootTaskId }, auditTaskId: lease.id, attemptCount: lease.attemptCount, attestation })
  if (!validInvocationProof(proof, lease, gateTaskId, attestation, prepareProof)) throw new Error("scheduled_audit_invocation_proof_invalid")
  return { owner: proof.attestation.owner, attestation: proof.attestation, prepareProof: proof.prepareProof,
    gateCompletionProof: proof.gateProof, ...(proof.scheduledWaitId ? { scheduledWaitId: proof.scheduledWaitId } : {}) }
}
async function readLiveScope(client: Queryable, lease: SubagentLease, now: Date): Promise<Row> {
  const result = await client.query<Row>(`SELECT audit."id", audit."role", audit."taskType", audit."status", audit."attemptCount", audit."leaseOwner",
      audit."leaseExpiresAt", audit."interruptRequestedAt", audit."expectedOutputSchema", audit."allowedActions",
      root."attemptCount" AS "rootAttemptCount", root."status" AS "rootStatus", root."interruptRequestedAt" AS "rootInterruptRequestedAt",
      turn."source", turn."executionMode", turn."input" AS "turnInput", turn."status" AS "turnStatus", turn."rootTaskId" AS "turnRootTaskId",
      session."userId", session."status" AS "sessionStatus", execution."id" AS "executionId", execution."attemptCount" AS "executionAttemptCount",
      execution."status" AS "executionStatus", execution."state"
    FROM "sub_agent_tasks" AS audit JOIN "sub_agent_tasks" AS root ON root."id" = audit."rootTaskId" AND root."sessionId" = audit."sessionId"
    JOIN "agent_sessions" AS session ON session."id" = audit."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = audit."turnId" AND turn."sessionId" = audit."sessionId"
    JOIN "agent_executions" AS execution ON execution."sessionId" = turn."sessionId" AND execution."userId" = session."userId"
    WHERE audit."id" = $1 AND audit."sessionId" = $3 AND audit."turnId" = $4 AND audit."rootTaskId" = $5
      AND audit."parentTaskId" = $5 AND audit."role" = $6 AND audit."taskType" = $7 AND audit."status" = 'running'
      AND audit."leaseOwner" = $8 AND audit."attemptCount" = $9 AND audit."leaseExpiresAt" > $10 AND audit."interruptRequestedAt" IS NULL
      AND root."taskType" = 'root' AND root."interruptRequestedAt" IS NULL AND turn."rootTaskId" = $5
      AND turn."userId" = $2
      AND turn."source" = 'automation' AND turn."executionMode" = 'canonical_task_graph'
      AND session."status" NOT IN ('aborted','archived') AND execution."status" IN ('running','paused','completed')
      AND turn."status" NOT IN ('completed','failed','interrupted','cancelled','closed')`,
  [lease.id, lease.userId, lease.sessionId, lease.turnId, lease.rootTaskId, SCHEDULED_AUDIT_ROLE, SCHEDULED_AUDIT_TASK_TYPE,
    lease.ownerId, lease.attemptCount, now])
  const row = result.rows[0]
  if (result.rows.length !== 1 || !row || !sameLiveLease(row, lease, now) || !same(row.expectedOutputSchema, SCHEDULED_AUDIT_OUTPUT_SCHEMA)
    || !same(row.allowedActions, []) || row.userId !== lease.userId || row.turnRootTaskId !== lease.rootTaskId
    || !active(row.rootStatus) || !active(row.turnStatus) || !record(row.turnInput)
    || parseScheduledAutomationSnapshot(record(row.turnInput)?.scheduledAutomationSnapshot) === undefined) {
    throw new Error("scheduled_audit_owner_stale")
  }
  return row
}
function buildAttestation(owner: ScheduledAutomationPipelineAttestation["owner"], snapshotDigest: string, evidenceDigest: string,
  graphRevision: number, nodes: readonly { key: string; taskId: string; templateId: string; verification?: { role: string; criteria: readonly { id: string }[] } }[],
  tasks: ReadonlyMap<string, GraphTaskRow>): ScheduledAutomationPipelineAttestation | null {
  const scoutNode = nodes.find(node => node.templateId === "scout"), analystNode = nodes.find(node => node.templateId === "analyst")
  const scoutTask = scoutNode && tasks.get(scoutNode.taskId), analystTask = analystNode && tasks.get(analystNode.taskId)
  const scoutEnvelope = scoutTask && outputEnvelope(scoutTask.result, true), analystEnvelope = analystTask && outputEnvelope(analystTask.result, false)
  if (!scoutNode?.verification || !analystNode?.verification || !scoutTask || !analystTask || !scoutEnvelope || !analystEnvelope) return null
  let scout: ScoutResult, analyst: AnalystResult
  try { scout = validateRoleResult(scoutEnvelope.structuredResult, "scout") as ScoutResult
    analyst = validateRoleResult(analystEnvelope.structuredResult, "analyst") as AnalystResult } catch { return null }
  const scoutReport = parseStoredTaskGraphVerificationReport(scoutEnvelope.taskGraphVerificationReport, scoutNode.verification.criteria.map(item => item.id), [])
  const analystReport = parseStoredTaskGraphVerificationReport(analystEnvelope.taskGraphVerificationReport, analystNode.verification.criteria.map(item => item.id), [scoutNode.key])
  const health = parseDiscoveryAttemptSidecar(scoutEnvelope.discoveryAttempt, scoutTask.attemptCount ?? 0)
  if (scout.status !== "completed" || analyst.status !== "completed" || scoutTask.status !== "completed" || analystTask.status !== "completed"
    || !scoutReport || scoutReport.status !== "passed" || !scoutReport.resultDigest || !analystReport || analystReport.status !== "passed"
    || !analystReport.resultDigest || !health || health.attemptedCalls < 1 || health.completedCalls !== health.attemptedCalls
    || health.failedCalls !== 0 || health.unresolvedCalls !== 0 || health.providerFailures !== 0 || health.materializationFailures !== 0
    || health.hasMore !== false || health.candidateCount !== scout.candidates.length) return null
  const base = { status: "complete" as const, taskId: scoutTask.id, attemptCount: scoutTask.attemptCount!, completedCalls: health.completedCalls,
    candidateCount: health.candidateCount!, providerFailures: 0 as const, materializationFailures: 0 as const, hasMore: false as const }
  return { schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v1", owner, snapshotDigest, graphRevision,
    scout: { taskId: scoutTask.id, attemptCount: scoutTask.attemptCount!, status: "completed", verification: "passed",
      resultDigest: scoutReport.resultDigest, candidateJobIds: scout.candidates.map(item => item.jobId), discoveryReceipt: { ...base, receiptDigest: taskGraphFingerprint(base) } },
    analyst: { taskId: analystTask.id, attemptCount: analystTask.attemptCount!, status: "completed", verification: "passed",
      resultDigest: analystReport.resultDigest, dependsOnTaskIds: [scoutTask.id], jobIds: analyst.findings.map(item => item.jobId) }, evidenceDigest }
}
function outputEnvelope(value: unknown, discovery: boolean): Row | null {
  const row = record(value), keys = ["finalItemId", "finalText", "status", "stepCount", "toolCallCount", "taskGraphVerificationReport", "structuredResult",
    ...(discovery ? ["discoveryAttempt"] : [])]
  return row && Reflect.ownKeys(row).length === keys.length && Reflect.ownKeys(row).every(key => typeof key === "string" && keys.includes(key))
    && row.status === "completed" && (row.finalItemId === null || typeof row.finalItemId === "string") && typeof row.finalText === "string"
    && nonNegative(row.stepCount) && nonNegative(row.toolCallCount) && Object.hasOwn(row, "structuredResult") ? row : null
}
function validInvocationProof(value: ScheduledAuditInvocationProof | null | undefined, lease: SubagentLease,
  gateTaskId: string, attestation: ScheduledAutomationPipelineAttestation,
  prepareProof: ScheduledPrepareTaskGraphProof): value is ScheduledAuditInvocationProof {
  const gateProof = record(value?.gateProof), gate = record(gateProof?.gate), owner = record(value?.owner)
  if (!value || value.schemaVersion !== SCHEDULED_AUDIT_INVOCATION_PROOF_SCHEMA || value.auditTaskId !== lease.id
    || value.attemptCount !== lease.attemptCount || value.snapshotDigest !== attestation.snapshotDigest || !positive(value.graphRevision)
    || !exact(value, ["schemaVersion", "owner", "snapshotDigest", "attestation", "prepareProof", "gateProof", "scheduledWaitId", "auditTaskId", "attemptCount", "graphRevision"])
    || !exact(owner ?? {}, ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "executionId", "executionAttemptCount"])
    || !gateProof || !exact(gateProof, ["schemaVersion", "graphRevision", "prepareProof", "gate"])
    || !gate || !exact(gate, ["taskId", "attemptCount", "resultDigest", "completedEventRevision"])
    || gateProof.schemaVersion !== "agent-harness.v2.scheduled-taskgraph-gate-completion.v1"
    || !positive(gateProof.graphRevision) || value.graphRevision <= Number(gateProof.graphRevision)
    || gate.taskId !== gateTaskId || !positive(gate.attemptCount)
    || !validId(gate.resultDigest) || !positive(gate.completedEventRevision)
    || !same(value.attestation, attestation) || !same(value.prepareProof, prepareProof)
    || !same(gateProof.prepareProof, prepareProof) || !same(owner, stableOwner(prepareProof.receipt.owner))) return false
  return value.owner.executionId === prepareProof.receipt.owner.executionId
    && value.owner.executionAttemptCount === prepareProof.receipt.owner.executionAttemptCount
    && value.owner.userId === lease.userId && value.owner.sessionId === lease.sessionId && value.owner.turnId === lease.turnId
    && value.owner.rootTaskId === lease.rootTaskId && positive(value.owner.rootAttemptCount)
    && (value.scheduledWaitId === null || validId(value.scheduledWaitId))
}
function samePreparedLineage(proof: ScheduledPrepareTaskGraphProof, registration: Awaited<ReturnType<typeof readScheduledGateRegistrationReceipt>>): boolean {
  return !!registration && proof.receipt.continuationKey === registration.continuationKey
    && proof.receipt.snapshotDigest === registration.snapshotDigest && proof.receipt.evidenceDigest === registration.evidenceDigest
    && proof.receipt.checkpointDigest === registration.checkpointDigest && proof.receipt.analyzeGraphRevision === registration.analyzeGraphRevision
    && proof.receipt.prepareScheduleRevision === registration.prepareScheduleRevision
}
function stableOwner(owner: StableOwner): ScheduledAuditInvocationProof["owner"] {
  return { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    rootAttemptCount: owner.rootAttemptCount, executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount }
}
function pipelineOwner(owner: ScheduledPrepareTaskGraphProof["receipt"]["owner"]): ScheduledAutomationPipelineBridgeScope {
  return { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    rootAttemptCount: owner.rootAttemptCount, turnLeaseOwnerId: owner.turnLeaseOwnerId, turnLeaseVersion: owner.turnLeaseVersion }
}
function sameLiveLease(row: Row, lease: SubagentLease, now: Date): boolean {
  const expires = row.leaseExpiresAt instanceof Date ? row.leaseExpiresAt : new Date(String(row.leaseExpiresAt))
  return row.id === lease.id && row.role === SCHEDULED_AUDIT_ROLE && row.taskType === SCHEDULED_AUDIT_TASK_TYPE
    && row.status === "running" && row.leaseOwner === lease.ownerId && Number(row.attemptCount) === lease.attemptCount
    && row.interruptRequestedAt == null && expires.getTime() > now.getTime() && lease.leaseExpiresAt.getTime() > now.getTime()
}
function active(value: unknown): boolean { return ["queued", "running", "retrying", "waiting", "waiting_for_user", "waiting_for_tool",
  "waiting_for_dependency", "waiting_for_approval", "in_progress"].includes(String(value)) }
function retryable(code: string): boolean { return ["scheduled_pipeline_handoff_unavailable", "scheduled_pipeline_handoff_in_progress",
  "scheduled_pipeline_handoff_retryable"].includes(code) }
function terminal(code: string): SubagentExecutionResult { return { status: "failed", failureReason: code, retryDisposition: "terminal" } }
function record(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const proto = Object.getPrototypeOf(parsed)
  return proto === Object.prototype || proto === null ? parsed as Row : null
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonNegative(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 }
function validId(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 }
function exact(row: object, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(row)
  return actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key))
}
function same(left: unknown, right: unknown): boolean { try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false } }
