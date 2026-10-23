import { createHash } from "node:crypto"
import type pg from "pg"
import type { SubagentExecutor } from "../../queue/subagent-queue.js"
import { scheduledGatePreparedJobIds, SCHEDULED_GATE_OUTPUT_SCHEMA,
  SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE } from "./scheduled-gate-contract.js"
import { loadScheduledGateChoiceHistory, type ScheduledGateChoiceHistory } from "./pg-scheduled-task-graph-gate-choices.js"
import { readScheduledGateRegistrationReceipt, type ScheduledGateRegistrationReceipt } from "./scheduled-gate-registration-receipt.js"
import { loadPersistedScheduledPrepareProof } from "./scheduled-gate-wait-match.js"
import { scheduledSnapshotMatches } from "./scheduled-taskgraph-continuation-receipt.js"
import { scheduledAnalyzeGraphMatches } from "./scheduled-taskgraph-continuation-receipt.js"
import { scheduledGateCheckpointEvidence } from "./scheduled-gate-contract.js"
import { currentTaskGraph, loadTaskGraph, type GraphIdentityScope, type GraphTaskRow } from "./task-graph-pg-state.js"
import { taskGraphFingerprint, canonicalTaskGraphJson, type StoredTaskGraphNode } from "./task-graph-snapshot.js"
import { parseDiscoveryAttemptSidecar } from "./child-discovery-attempt.js"
import { validateRoleResult, type AnalystResult, type ScoutResult } from "./role-results.js"
import { parseStoredTaskGraphVerificationReport } from "./task-graph-verification-report.js"
import { postScheduledPipelineGate, type ScheduledPipelineGateInput } from "./scheduled-pipeline-handoff.js"
import type { ScheduledAutomationPipelineAttestation, ScheduledAutomationPipelineBridgeScope } from "./scheduled-automation-pipeline-bridge.js"
import type { ScheduledPrepareTaskGraphProof } from "./scheduled-prepare-task-graph-verification.js"
import type { ScheduledGateResult, ScheduledGateTaskEnvelope } from "./scheduled-gate-contract.js"
import { parseScheduledAutomationSnapshot } from "./scheduled-automation-snapshot.js"
import type { SubagentLease, SubagentExecutionResult } from "./types.js"

type Row = Record<string, unknown>
type Queryable = Pick<pg.PoolClient, "query">
type GateInvocation = Readonly<{
  owner: ScheduledAutomationPipelineBridgeScope
  attestation: ScheduledAutomationPipelineAttestation
  prepareProof: ScheduledPrepareTaskGraphProof
  scheduledWaitId?: string
}>
type GateRuntimeOptions = Readonly<{
  pool: Pick<pg.Pool, "connect">
  fetcher?: typeof fetch
  now?: () => Date
  loadInvocation?: (lease: SubagentLease) => Promise<GateInvocation>
  loadChoices?: (lease: SubagentLease) => Promise<ScheduledGateChoiceHistory>
}>

/** Runs the fixed, model-free child against persisted lineage and the authenticated Web Gate action. */
export function createScheduledGateChildExecutor(options: GateRuntimeOptions): SubagentExecutor {
  return async ({ lease }) => {
    if (!isGateLease(lease)) return terminal("scheduled_gate_task_invalid")
    if (lease.signal.aborted) throw lease.signal.reason ?? new Error("scheduled_gate_cancelled")
    try {
      const load = options.loadInvocation ?? (value => loadInvocation(options.pool, value, options.now?.() ?? new Date()))
      const choiceLoader = options.loadChoices ?? (value => loadScheduledGateChoiceHistory(options.pool, value, options.now?.() ?? new Date()))
      const [invocation, choices] = await Promise.all([load(lease), choiceLoader(lease)])
      if (lease.signal.aborted) throw lease.signal.reason ?? new Error("scheduled_gate_cancelled")
      const request: ScheduledPipelineGateInput = {
        owner: invocation.owner,
        attestation: invocation.attestation,
        prepareProof: invocation.prepareProof,
        ...(invocation.scheduledWaitId ? { scheduledWaitId: invocation.scheduledWaitId } : {}),
        gateTaskId: lease.id,
        gateLeaseOwnerId: lease.ownerId,
        gateAttemptCount: lease.attemptCount,
        ...(choices.validatedChoice ? { validatedChoice: choices.validatedChoice } : {}),
        priorChoices: choices.priorChoices,
      }
      const result = await postScheduledPipelineGate(request, lease.signal, options.fetcher)
      if (result.status === "blocked") return terminal(result.errorCode)
      if (lease.signal.aborted) throw lease.signal.reason ?? new Error("scheduled_gate_cancelled")
      const envelope = scheduledGateEnvelope(result)
      return result.status === "completed"
        ? { status: "completed", result: envelope }
        : { status: "waiting_for_user", result: envelope }
    } catch (error: unknown) {
      if (lease.signal.aborted) throw lease.signal.reason ?? error
      if (error instanceof ScheduledGateRuntimeError) return terminal(error.code)
      const reason = error instanceof Error && retryableGateError(error.message)
        ? "scheduled_gate_handoff_retryable" : "scheduled_gate_runtime_failed"
      return { status: "failed", failureReason: reason, retryDisposition: "retryable" }
    }
  }
}

export function isScheduledGateTask(task: Pick<SubagentLease, "role" | "taskType">): boolean {
  return task.role === SCHEDULED_GATE_ROLE && task.taskType === SCHEDULED_GATE_TASK_TYPE
}

function isGateLease(lease: SubagentLease): boolean {
  return isScheduledGateTask(lease) && !!lease.turnId && lease.parentTaskId === lease.rootTaskId
    && lease.status === "running" && lease.leaseOwner === lease.ownerId && lease.interruptRequestedAt === null
    && Number.isSafeInteger(lease.attemptCount) && lease.attemptCount > 0
    && sameJson(lease.expectedOutputSchema, SCHEDULED_GATE_OUTPUT_SCHEMA)
    && Array.isArray(lease.allowedActions) && lease.allowedActions.length === 0
}

function scheduledGateEnvelope(result: ScheduledGateResult): ScheduledGateTaskEnvelope {
  const status = result.status === "completed" ? "completed" : "waiting_for_user"
  return { finalItemId: null, finalText: "", status, stepCount: 0, toolCallCount: 0,
    taskGraphVerificationReport: null, structuredResult: result }
}

function terminal(code: string): SubagentExecutionResult {
  return { status: "failed", failureReason: code, retryDisposition: "terminal" }
}

function retryableGateError(code: string): boolean {
  return code === "scheduled_pipeline_handoff_unavailable" || code === "scheduled_pipeline_handoff_in_progress"
    || code === "scheduled_pipeline_handoff_retryable"
}

class ScheduledGateRuntimeError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ScheduledGateRuntimeError" }
}

async function loadInvocation(pool: Pick<pg.Pool, "connect">, lease: SubagentLease, now: Date): Promise<GateInvocation> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    await client.query("SELECT set_config('app.user_id', $1, true)", [lease.userId])
    const row = await readLiveScope(client, lease, now)
    const evidence = scheduledGateCheckpointEvidence(row.state)
    const scheduledWaitId = scheduledQuestionWaitId(row.turnInput, row.state, lease.turnId!)
    if (!evidence || evidence.owner.userId !== lease.userId || evidence.owner.sessionId !== lease.sessionId
      || evidence.owner.turnId !== lease.turnId || evidence.owner.rootTaskId !== lease.rootTaskId
      || evidence.owner.rootAttemptCount !== Number(row.rootAttemptCount) || evidence.owner.executionId !== row.executionId
      || evidence.owner.executionAttemptCount !== Number(row.executionAttemptCount) || scheduledWaitId === null
      || !scheduledSnapshotMatches({ source: row.source, executionMode: row.executionMode, input: row.turnInput }, evidence.snapshotDigest)) {
      throw new ScheduledGateRuntimeError("scheduled_gate_checkpoint_invalid")
    }
    const scope: GraphIdentityScope = { userId: lease.userId, sessionId: lease.sessionId,
      turnId: lease.turnId!, rootTaskId: lease.rootTaskId, parentTaskId: lease.rootTaskId }
    const graph = await loadTaskGraph(client, scope, false), gateNode = graph.snapshot?.nodes.find(node => node.key === "gate")
    const prepareNode = graph.snapshot?.nodes.find(node => node.key === "prepare"), gateState = graph.state?.nodes.find(node => node.key === "gate")
    const gateTask = gateNode && graph.tasks.get(gateNode.taskId), prepareTask = prepareNode && graph.tasks.get(prepareNode.taskId)
    if (!graph.snapshot || !graph.state || graph.snapshot.nodes.length !== 4 || !gateNode || gateNode.taskId !== lease.id
      || gateNode.templateId !== "gate" || gateNode.depth !== 4 || gateNode.verificationDisposition !== "specialized"
      || !sameJson(gateNode.dependsOn, ["prepare"]) || !gateState || gateState.status !== "running"
      || !gateTask || gateTask.status !== "running" || gateTask.attemptCount !== lease.attemptCount
      || !prepareNode || !prepareTask || prepareTask.status !== "completed") throw new ScheduledGateRuntimeError("scheduled_gate_graph_invalid")
    const owner = { ...evidence.owner }
    const registration = await readScheduledGateRegistrationReceipt(client, {
      userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId!, owner, gateTaskId: lease.id,
    })
    if (!registration || registration.continuationKey !== evidence.continuationKey
      || registration.snapshotDigest !== evidence.snapshotDigest || registration.evidenceDigest !== evidence.evidenceDigest
      || registration.checkpointDigest !== evidence.checkpointDigest || registration.analyzeGraphRevision !== evidence.analyzeGraphRevision) {
      throw new ScheduledGateRuntimeError("scheduled_gate_registration_invalid")
    }
    const prepareProof = await loadPersistedScheduledPrepareProof(client,
      { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId!, rootTaskId: lease.rootTaskId },
      prepareNode.taskId, prepareTask.result, evidence.continuationKey, registration.prepareWaitId)
    if (!prepareProof || !scheduledGatePreparedJobIds(prepareProof) || prepareProof.completion.wait.waitId !== registration.prepareWaitId
      || registration.prepareScheduleRevision !== prepareProof.receipt.prepareScheduleRevision
      || !samePreparedLineage(prepareProof, registration)
      || !sameJson(prepareProof.receipt.owner, record(record(row.state)?.scheduledTaskGraphContinuation)?.owner)) {
      throw new ScheduledGateRuntimeError("scheduled_gate_prepare_proof_invalid")
    }
    const attestation = buildAttestation(pipelineOwner(prepareProof.receipt.owner), evidence.snapshotDigest, evidence.evidenceDigest,
      evidence.analyzeGraphRevision, graph.snapshot.nodes, graph.tasks)
    const verified = attestation && await validateAnalyzePrefix(client, lease, row, graph, attestation, prepareProof, evidence)
    if (!attestation || !verified) throw new ScheduledGateRuntimeError("scheduled_gate_analyze_proof_invalid")
    await client.query("COMMIT")
    return { owner: attestation.owner, attestation, prepareProof, ...(scheduledWaitId ? { scheduledWaitId } : {}) }
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    if (error instanceof ScheduledGateRuntimeError) throw error
    throw error
  } finally { client.release() }
}

async function readLiveScope(client: Queryable, lease: SubagentLease, now: Date): Promise<Row> {
  const rows = await client.query<Row>(`SELECT gate."id", gate."role", gate."taskType", gate."status", gate."attemptCount", gate."leaseOwner",
      gate."leaseExpiresAt", gate."interruptRequestedAt", gate."expectedOutputSchema", gate."allowedActions",
      root."attemptCount" AS "rootAttemptCount", root."status" AS "rootStatus", root."interruptRequestedAt" AS "rootInterruptRequestedAt",
      turn."source", turn."executionMode", turn."input" AS "turnInput", turn."status" AS "turnStatus", turn."rootTaskId" AS "turnRootTaskId",
      session."userId", session."status" AS "sessionStatus", execution."id" AS "executionId", execution."attemptCount" AS "executionAttemptCount",
      execution."status" AS "executionStatus", execution."state"
    FROM "sub_agent_tasks" AS gate JOIN "sub_agent_tasks" AS root ON root."id" = gate."rootTaskId" AND root."sessionId" = gate."sessionId"
    JOIN "agent_sessions" AS session ON session."id" = gate."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = gate."turnId" AND turn."sessionId" = gate."sessionId"
    JOIN "agent_executions" AS execution ON execution."sessionId" = turn."sessionId" AND execution."userId" = session."userId"
    WHERE gate."id" = $1 AND gate."sessionId" = $3 AND gate."turnId" = $4 AND gate."rootTaskId" = $5
      AND gate."parentTaskId" = $5 AND gate."depth" = 1 AND gate."role" = $6 AND gate."taskType" = $7
      AND gate."status" = 'running' AND gate."leaseOwner" = $8 AND gate."attemptCount" = $9 AND gate."leaseExpiresAt" > $10
      AND gate."interruptRequestedAt" IS NULL AND root."taskType" = 'root' AND root."status" NOT IN ('completed','failed','interrupted','cancelled','closed')
      AND root."interruptRequestedAt" IS NULL AND turn."userId" = $2 AND turn."rootTaskId" = $5
      AND turn."status" NOT IN ('completed','failed','interrupted','cancelled','closed') AND session."status" NOT IN ('aborted','archived')
      AND execution."status" IN ('running','waiting_for_user')`,
  [lease.id, lease.userId, lease.sessionId, lease.turnId, lease.rootTaskId, SCHEDULED_GATE_ROLE,
    SCHEDULED_GATE_TASK_TYPE, lease.ownerId, lease.attemptCount, now])
  const row = rows.rows[0]
  if (rows.rows.length !== 1 || !row || !sameLiveLease(row, lease, now)
    || !sameJson(row.expectedOutputSchema, SCHEDULED_GATE_OUTPUT_SCHEMA) || !sameJson(row.allowedActions, [])
    || row.turnRootTaskId !== lease.rootTaskId || !active(row.rootStatus) || !active(row.turnStatus)) {
    throw new ScheduledGateRuntimeError("scheduled_gate_owner_stale")
  }
  return row
}

function buildAttestation(owner: ScheduledAutomationPipelineAttestation["owner"], snapshotDigest: string, evidenceDigest: string,
  analyzeGraphRevision: number, nodes: readonly StoredTaskGraphNode[], tasks: ReadonlyMap<string, GraphTaskRow>): ScheduledAutomationPipelineAttestation | null {
  const scoutNode = nodes.find(node => node.templateId === "scout"), analystNode = nodes.find(node => node.templateId === "analyst")
  const scoutTask = scoutNode && tasks.get(scoutNode.taskId), analystTask = analystNode && tasks.get(analystNode.taskId)
  const scoutEnvelope = scoutTask && outputEnvelope(scoutTask.result, true), analystEnvelope = analystTask && outputEnvelope(analystTask.result, false)
  if (!scoutNode?.verification || !analystNode?.verification || !scoutTask || !analystTask || !scoutEnvelope || !analystEnvelope) return null
  let scout: ScoutResult, analyst: AnalystResult
  try {
    scout = validateRoleResult(scoutEnvelope.structuredResult, "scout") as ScoutResult
    analyst = validateRoleResult(analystEnvelope.structuredResult, "analyst") as AnalystResult
  } catch { return null }
  const scoutReport = parseStoredTaskGraphVerificationReport(scoutEnvelope.taskGraphVerificationReport,
    scoutNode.verification.criteria.map(item => item.id), [])
  const analystReport = parseStoredTaskGraphVerificationReport(analystEnvelope.taskGraphVerificationReport,
    analystNode.verification.criteria.map(item => item.id), [scoutNode.key])
  const health = parseDiscoveryAttemptSidecar(scoutEnvelope.discoveryAttempt, scoutTask.attemptCount ?? 0)
  if (scout.status !== "completed" || analyst.status !== "completed" || scoutTask.status !== "completed" || analystTask.status !== "completed"
    || !scoutReport || scoutReport.status !== "passed" || !scoutReport.resultDigest
    || !analystReport || analystReport.status !== "passed" || !analystReport.resultDigest
    || !health || health.attemptedCalls < 1 || health.completedCalls !== health.attemptedCalls || health.failedCalls !== 0
    || health.unresolvedCalls !== 0 || health.candidateCount !== scout.candidates.length || health.providerFailures !== 0
    || health.materializationFailures !== 0 || health.hasMore !== false) return null
  const receiptBase = { status: "complete" as const, taskId: scoutTask.id, attemptCount: scoutTask.attemptCount!,
    completedCalls: health.completedCalls, candidateCount: health.candidateCount!, providerFailures: 0 as const,
    materializationFailures: 0 as const, hasMore: false as const }
  return { schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v1", owner, snapshotDigest, graphRevision: analyzeGraphRevision,
    scout: { taskId: scoutTask.id, attemptCount: scoutTask.attemptCount!, status: "completed", verification: "passed",
      resultDigest: scoutReport.resultDigest, candidateJobIds: scout.candidates.map(item => item.jobId),
      discoveryReceipt: { ...receiptBase, receiptDigest: taskGraphFingerprint(receiptBase) } },
    analyst: { taskId: analystTask.id, attemptCount: analystTask.attemptCount!, status: "completed", verification: "passed",
      resultDigest: analystReport.resultDigest, dependsOnTaskIds: [scoutTask.id], jobIds: analyst.findings.map(item => item.jobId) }, evidenceDigest }
}

async function validateAnalyzePrefix(client: Queryable, lease: SubagentLease, row: Row,
  graph: Awaited<ReturnType<typeof loadTaskGraph>>, attestation: ScheduledAutomationPipelineAttestation,
  prepareProof: ScheduledPrepareTaskGraphProof, evidence: NonNullable<ReturnType<typeof scheduledGateCheckpointEvidence>>): Promise<boolean> {
  const nodes = graph.snapshot?.nodes.slice(0, 3), current = currentTaskGraph(graph)
  const prepare = nodes?.[2]
  if (!graph.snapshot || !graph.state || !nodes || !prepare || current.nodes.length !== 4) return false
  const proposal = { expectedRevision: evidence.analyzeGraphRevision, nodes: [{ key: prepare.key, templateId: prepare.templateId,
    goal: prepare.goal, successCriteria: prepare.successCriteria, dependsOn: prepare.dependsOn }] }
  const waitRows = await client.query<Row>(`SELECT "stepId" FROM "agent_wait_conditions"
    WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3 AND "turnId" = $4 AND "parentTaskId" = $5`,
  [prepareProof.completion.wait.waitId, lease.userId, lease.sessionId, lease.turnId, lease.rootTaskId])
  if (waitRows.rows.length !== 1 || !validId(waitRows.rows[0]?.stepId)) return false
  const executionState = record(row.state), claim = record(executionState?.scheduledTaskGraphClaim)
  const token = claim?.claimToken
  if (!validId(token)) return false
  const input = {
    scope: { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId!, rootTaskId: lease.rootTaskId,
      parentTaskId: lease.rootTaskId, stepId: String(waitRows.rows[0].stepId), turnLeaseOwner: attestation.owner.turnLeaseOwnerId,
      turnLeaseVersion: attestation.owner.turnLeaseVersion, parentLeaseOwner: attestation.owner.turnLeaseOwnerId,
      parentAttemptCount: attestation.owner.rootAttemptCount },
    executionOwner: { executionId: String(row.executionId), executionAttemptCount: Number(row.executionAttemptCount) },
    handoff: { status: "analyze_checkpointed" as const, continuationKey: evidence.continuationKey,
      checkpointDigest: evidence.checkpointDigest, claimTokenDigest: `sha256:${createHash("sha256").update(token).digest("hex")}`,
      executionId: String(row.executionId), executionAttemptCount: Number(row.executionAttemptCount) },
    attestation, proposal,
  }
  const analyzeSnapshot = { ...graph.snapshot, nodes }
  const analyzeCurrent = { ...current, nodes: current.nodes.slice(0, 3) }
  const analystKey = scheduledAnalyzeGraphMatches(input, analyzeSnapshot, analyzeCurrent, graph.tasks, true)
  return analystKey !== null && analystKey === nodes[1]?.key && prepare.taskId === prepareProof.completion.nodes[2].taskId
}

function samePreparedLineage(proof: ScheduledPrepareTaskGraphProof, registration: ScheduledGateRegistrationReceipt): boolean {
  return proof.receipt.continuationKey === registration.continuationKey && proof.receipt.snapshotDigest === registration.snapshotDigest
    && proof.receipt.evidenceDigest === registration.evidenceDigest && proof.receipt.checkpointDigest === registration.checkpointDigest
    && proof.receipt.analyzeGraphRevision === registration.analyzeGraphRevision
    && proof.receipt.prepareScheduleRevision === registration.prepareScheduleRevision
}

function pipelineOwner(owner: ScheduledPrepareTaskGraphProof["receipt"]["owner"]): ScheduledAutomationPipelineAttestation["owner"] {
  return { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    rootAttemptCount: owner.rootAttemptCount, turnLeaseOwnerId: owner.turnLeaseOwnerId, turnLeaseVersion: owner.turnLeaseVersion }
}

function outputEnvelope(value: unknown, discovery: boolean): Row | null {
  const row = record(value), keys = ["finalItemId", "finalText", "status", "stepCount", "toolCallCount", "taskGraphVerificationReport", "structuredResult",
    ...(discovery ? ["discoveryAttempt"] : [])]
  return row && Reflect.ownKeys(row).length === keys.length && Reflect.ownKeys(row).every(key => typeof key === "string" && keys.includes(key))
    && row.status === "completed" && row.finalItemId === null && typeof row.finalText === "string"
    && nonNegative(row.stepCount) && nonNegative(row.toolCallCount) && Object.hasOwn(row, "structuredResult") ? row : null
}
function sameLiveLease(row: Row, lease: SubagentLease, now: Date): boolean {
  const expiry = row.leaseExpiresAt instanceof Date ? row.leaseExpiresAt : new Date(String(row.leaseExpiresAt))
  return row.id === lease.id && row.role === SCHEDULED_GATE_ROLE && row.taskType === SCHEDULED_GATE_TASK_TYPE
    && row.status === "running" && row.leaseOwner === lease.ownerId && Number(row.attemptCount) === lease.attemptCount
    && row.interruptRequestedAt == null && expiry.getTime() > now.getTime() && lease.leaseExpiresAt.getTime() > now.getTime()
}
function active(value: unknown): boolean { return ["queued", "running", "retrying", "waiting", "waiting_for_user", "waiting_for_tool", "waiting_for_dependency", "waiting_for_approval", "in_progress"].includes(String(value)) }
function scheduledQuestionWaitId(turnInput: unknown, checkpoint: unknown, turnId: string): string | undefined | null {
  const snapshot = parseScheduledAutomationSnapshot(record(turnInput)?.scheduledAutomationSnapshot), state = record(checkpoint)
  const waitId = state?.scheduledTaskGraphScheduledWaitId
  if (!snapshot || waitId !== undefined && !validId(waitId)) return null
  if (!snapshot.requireApproval) return waitId === undefined ? undefined : null
  return typeof waitId === "string" && waitId.startsWith(`agent-question:${turnId}:canonical:`) ? waitId : null
}
function validId(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) }
function nonNegative(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 }
function record(value: unknown): Row | null { const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value; if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null; const proto = Object.getPrototypeOf(parsed); return proto === Object.prototype || proto === null ? parsed as Row : null }
function sameJson(left: unknown, right: unknown): boolean { try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false } }
