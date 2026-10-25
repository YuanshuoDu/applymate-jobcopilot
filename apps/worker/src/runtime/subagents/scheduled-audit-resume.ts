import { createHash } from "node:crypto"
import type { DurableWaitPort, DurableWaitResult } from "../tools/coordination-types.js"
import type { TaskGraphCommandPort, TaskGraphReadScope } from "./task-graph-command-port.js"
import { currentTaskGraph, loadTaskGraph, lockTaskGraphScope, type GraphIdentityScope } from "./task-graph-pg-state.js"
import type { Queryable } from "./pg-store-persistence.js"
import { canonicalTaskGraphJson, taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import { readScheduledAuditRegistration, verifyRegisteredScheduledAuditGate } from "./scheduled-audit-invocation.js"
import { scheduledGateCheckpointEvidence, scheduledGatePreparedJobIds, SCHEDULED_GATE_NODE_CRITERIA, SCHEDULED_GATE_NODE_GOAL,
  SCHEDULED_GATE_OUTPUT_SCHEMA, SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE, SCHEDULED_GATE_TEMPLATE_ID } from "./scheduled-gate-contract.js"
import { readScheduledGateRegistrationReceipt } from "./scheduled-gate-registration-receipt.js"
import { loadPersistedScheduledPrepareProof } from "./scheduled-gate-wait-match.js"
import { verifyPersistedScheduledPreparePrefix } from "./pg-scheduled-task-graph-gate-verification.js"
import { scheduledSnapshotMatches, scheduledTaskGraphClaimMatches, type ScheduledTaskGraphContinuationBinding } from "./scheduled-taskgraph-continuation-receipt.js"
import { scheduledQuestionWaitId } from "./scheduled-gate-child-runtime.js"
import {
  SCHEDULED_AUDIT_NODE_CRITERIA, SCHEDULED_AUDIT_NODE_GOAL, SCHEDULED_AUDIT_OUTPUT_SCHEMA,
  SCHEDULED_AUDIT_REGISTRATION_RECEIPT_EVENT, SCHEDULED_AUDIT_ROLE, SCHEDULED_AUDIT_TASK_TYPE,
  SCHEDULED_AUDIT_TEMPLATE_ID, parseScheduledAuditRegistrationReceipt, scheduledAuditRegistrationReceiptKey,
  parseScheduledAuditReport, SCHEDULED_AUDIT_COMPLETION_PROOF_SCHEMA,
  type ScheduledAuditCompletionProof, type ScheduledAuditResumeContext, type TaskGraphScheduledAuditResumeInput,
} from "./scheduled-audit-contract.js"

const WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1_000
type ResumeCommand = Pick<TaskGraphCommandPort, "readScheduledAuditResumeContext" | "verifyScheduledAuditCompletion">

export async function readScheduledAuditResumeContext(client: Queryable,
  input: TaskGraphScheduledAuditResumeInput): Promise<ScheduledAuditResumeContext> {
  await client.query("SELECT set_config('app.user_id', $1, true)", [input.scope.userId])
  await lockTaskGraphScope(client, input.scope)
  const scope: GraphIdentityScope = { userId: input.scope.userId, sessionId: input.scope.sessionId,
    turnId: input.scope.turnId, rootTaskId: input.scope.rootTaskId, parentTaskId: input.scope.rootTaskId }
  const loaded = await loadTaskGraph(client, scope, true), nodes = loaded.snapshot?.nodes
  if (!loaded.item || !loaded.snapshot || !loaded.state || !nodes) return { status: "invalid" }
  const audits = nodes.filter(node => node.key === SCHEDULED_AUDIT_TEMPLATE_ID)
  if (audits.length === 0) {
    if (nodes.length === 4) {
      if (await hasOrphanAuditRegistration(client, scope, input.scope.parentAttemptCount)) return { status: "invalid" }
      return readRegisteredGateContinuation(client, input.scope, loaded)
    }
    if (nodes.length < 2 || nodes.length > 3) return { status: "invalid" }
    return await hasOrphanAuditRegistration(client, scope, input.scope.parentAttemptCount) ? { status: "invalid" } : { status: "not_registered" }
  }
  const node = audits.length === 1 ? audits[0] : undefined
  const task = node && loaded.tasks.get(node.taskId), current = currentTaskGraph(loaded)
    .nodes.find(candidate => candidate.key === SCHEDULED_AUDIT_TEMPLATE_ID)
  if (!node || nodes.length !== 5 || nodes[4] !== node || node.templateId !== SCHEDULED_AUDIT_TEMPLATE_ID
    || node.depth !== 5 || node.verificationDisposition !== "specialized" || node.goal !== SCHEDULED_AUDIT_NODE_GOAL
    || !same(node.successCriteria, SCHEDULED_AUDIT_NODE_CRITERIA) || !same(node.dependsOn, ["gate"])
    || !task || !current || current.taskId !== node.taskId || current.status !== task.status
    || task.role !== SCHEDULED_AUDIT_ROLE || task.taskType !== SCHEDULED_AUDIT_TASK_TYPE
    || !same(task.expectedOutputSchema, SCHEDULED_AUDIT_OUTPUT_SCHEMA) || !same(task.allowedActions, []) || task.contextIsEmpty !== true
    || !["queued", "retrying", "running", "completed"].includes(task.status)
    || !Number.isSafeInteger(task.attemptCount) || task.attemptCount! < 0
    || task.status === "completed" && (task.attemptCount! < 1 || task.failureReason !== null || current.failureReason !== null)) return { status: "invalid" }
  const registration = await readScheduledAuditRegistration(client, scope, node.taskId)
  if (!registration || registration.auditTaskId !== node.taskId || registration.owner.rootAttemptCount !== input.scope.parentAttemptCount
    || registration.owner.userId !== input.scope.userId || registration.owner.sessionId !== input.scope.sessionId
    || registration.owner.turnId !== input.scope.turnId || registration.owner.rootTaskId !== input.scope.rootTaskId) return { status: "invalid" }
  const gateProof = await verifyRegisteredScheduledAuditGate(client, scope, loaded, registration)
  const expectedAttemptCount = task.status === "queued" || task.status === "retrying" ? task.attemptCount! + 1 : task.attemptCount!
  if (!gateProof || !Number.isSafeInteger(expectedAttemptCount) || expectedAttemptCount < 1) return { status: "invalid" }
  return { status: "registered", auditTaskId: node.taskId, auditStatus: task.status as "queued" | "retrying" | "running" | "completed",
    expectedAttemptCount, owner: registration.owner, executionOwner: { executionId: registration.owner.executionId,
      executionAttemptCount: registration.owner.executionAttemptCount }, snapshotDigest: registration.snapshotDigest, gateProof }
}

async function readRegisteredGateContinuation(client: Queryable, scope: TaskGraphReadScope,
  loaded: Awaited<ReturnType<typeof loadTaskGraph>>): Promise<ScheduledAuditResumeContext> {
  const nodes = loaded.snapshot?.nodes, gateNode = nodes?.[3], gate = gateNode && loaded.tasks.get(gateNode.taskId)
  const current = currentTaskGraph(loaded), currentGate = current.nodes.find(node => node.key === SCHEDULED_GATE_TEMPLATE_ID)
  if (!nodes || nodes.length !== 4 || !gateNode || gateNode.key !== SCHEDULED_GATE_TEMPLATE_ID
    || gateNode.templateId !== SCHEDULED_GATE_TEMPLATE_ID || gateNode.depth !== 4
    || gateNode.verificationDisposition !== "specialized" || gateNode.verification !== undefined
    || gateNode.goal !== SCHEDULED_GATE_NODE_GOAL || !same(gateNode.successCriteria, SCHEDULED_GATE_NODE_CRITERIA)
    || !same(gateNode.dependsOn, ["prepare"]) || !gate || !currentGate || currentGate.taskId !== gate.id
    || currentGate.status !== gate.status || (currentGate.failureReason ?? null) !== gate.failureReason
    || !["queued", "running", "retrying", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"].includes(gate.status)
    || gate.role !== SCHEDULED_GATE_ROLE || gate.taskType !== SCHEDULED_GATE_TASK_TYPE
    || !same(gate.expectedOutputSchema, SCHEDULED_GATE_OUTPUT_SCHEMA) || !same(gate.allowedActions, []) || gate.contextIsEmpty !== true
    || !Number.isSafeInteger(gate.attemptCount) || gate.attemptCount! < 0
    || gate.status === "completed" && gate.failureReason !== null) return { status: "invalid" }
  const executionRows = await client.query(`SELECT "id", "status", "attemptCount", "state", clock_timestamp() AS "now"
    FROM "agent_executions" WHERE "userId" = $1 AND "sessionId" = $2 FOR UPDATE`, [scope.userId, scope.sessionId])
  if (executionRows.rows.length !== 1) return { status: "invalid" }
  const execution = record(executionRows.rows[0]), evidence = scheduledGateCheckpointEvidence(execution?.state)
  const owner = evidence && { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    rootAttemptCount: evidence.owner.rootAttemptCount, executionId: evidence.owner.executionId,
    executionAttemptCount: evidence.owner.executionAttemptCount }
  const registration = owner && evidence && await readScheduledGateRegistrationReceipt(client, {
    userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, owner, gateTaskId: gate.id })
  if (!execution || !evidence || !owner || !registration || execution.id !== registration.owner.executionId
    || execution.status !== "running" || Number(execution.attemptCount) !== registration.owner.executionAttemptCount
    || evidence.owner.userId !== scope.userId || evidence.owner.sessionId !== scope.sessionId
    || evidence.owner.turnId !== scope.turnId || evidence.owner.rootTaskId !== scope.rootTaskId
    || evidence.owner.rootAttemptCount !== scope.parentAttemptCount
    || registration.owner.rootAttemptCount !== scope.parentAttemptCount
    || registration.continuationKey !== evidence.continuationKey || registration.snapshotDigest !== evidence.snapshotDigest
    || registration.evidenceDigest !== evidence.evidenceDigest || registration.checkpointDigest !== evidence.checkpointDigest
    || registration.analyzeGraphRevision !== evidence.analyzeGraphRevision
    || registration.gateTaskId !== gate.id || registration.gateAppendRevision <= 0
    || !gateAppendRevisionMatches(loaded, gate.id, registration.gateAppendRevision, scope.rootTaskId)) return { status: "invalid" }
  const executionState = record(execution.state), claim = record(executionState?.scheduledTaskGraphClaim)
  const checkpointOwner = record(record(executionState?.scheduledTaskGraphContinuation)?.owner)
  const turnLeaseOwnerId = checkpointOwner?.turnLeaseOwnerId, turnLeaseVersion = checkpointOwner?.turnLeaseVersion
  const claimToken = claim?.claimToken
  if (!checkpointOwner || typeof claimToken !== "string" || typeof turnLeaseOwnerId !== "string" || !Number.isSafeInteger(turnLeaseVersion)
    || checkpointOwner.userId !== evidence.owner.userId || checkpointOwner.sessionId !== evidence.owner.sessionId
    || checkpointOwner.turnId !== evidence.owner.turnId || checkpointOwner.rootTaskId !== evidence.owner.rootTaskId
    || checkpointOwner.rootAttemptCount !== evidence.owner.rootAttemptCount
    || checkpointOwner.executionId !== evidence.owner.executionId
    || checkpointOwner.executionAttemptCount !== evidence.owner.executionAttemptCount) return { status: "invalid" }
  const binding: ScheduledTaskGraphContinuationBinding = { owner: { ...evidence.owner,
    turnLeaseOwnerId, turnLeaseVersion: Number(turnLeaseVersion) }, continuationKey: evidence.prepareWaitContinuationKey,
    snapshotDigest: evidence.snapshotDigest, evidenceDigest: evidence.evidenceDigest, checkpointDigest: evidence.checkpointDigest,
    analyzeGraphRevision: evidence.analyzeGraphRevision, prepareScheduleRevision: evidence.analyzeGraphRevision + 1 }
  const now = execution.now instanceof Date || typeof execution.now === "string" ? execution.now : undefined
  const claimDigest = `sha256:${createHash("sha256").update(claimToken, "utf8").digest("hex")}`
  if (!scheduledTaskGraphClaimMatches(execution.state, binding, claimDigest, now)) return { status: "invalid" }
  const turnRows = await client.query(`SELECT "source", "executionMode", "input" FROM "agent_turns"
    WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "rootTaskId" = $4`,
  [scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId])
  const turn = record(turnRows.rows[0]), scheduledWaitId = scheduledQuestionWaitId(turn?.input, execution.state, scope.turnId)
  const prepareNode = nodes[2], prepare = prepareNode && loaded.tasks.get(prepareNode.taskId)
  const proof = prepare && prepare.status === "completed" ? await loadPersistedScheduledPrepareProof(client, scope,
    prepare.id, prepare.result, evidence.prepareWaitContinuationKey, registration.prepareWaitId) : null
  if (turnRows.rows.length !== 1 || !scheduledSnapshotMatches(turn, evidence.snapshotDigest) || scheduledWaitId === null
    || !prepareNode || prepareNode.key !== "prepare" || !prepare || !proof || !scheduledGatePreparedJobIds(proof)
    || proof.receipt.continuationKey !== evidence.continuationKey
    || proof.receipt.owner.userId !== registration.owner.userId || proof.receipt.owner.sessionId !== registration.owner.sessionId
    || proof.receipt.owner.turnId !== registration.owner.turnId || proof.receipt.owner.rootTaskId !== registration.owner.rootTaskId
    || proof.receipt.owner.rootAttemptCount !== registration.owner.rootAttemptCount
    || proof.receipt.owner.executionId !== registration.owner.executionId
    || proof.receipt.owner.executionAttemptCount !== registration.owner.executionAttemptCount
    || proof.receipt.snapshotDigest !== evidence.snapshotDigest || proof.receipt.evidenceDigest !== evidence.evidenceDigest
    || proof.receipt.checkpointDigest !== evidence.checkpointDigest || proof.receipt.analyzeGraphRevision !== evidence.analyzeGraphRevision
    || proof.receipt.prepareScheduleRevision !== registration.prepareScheduleRevision
    || proof.completion.wait.waitId !== registration.prepareWaitId
    || registration.gateAppendRevision <= proof.completion.graphRevision || registration.gateAppendRevision > loaded.state!.revision
    || !await verifyPersistedScheduledPreparePrefix(client, scope, loaded, proof)) return { status: "invalid" }
  const handoff = { status: "analyze_checkpointed" as const, continuationKey: evidence.prepareWaitContinuationKey,
    checkpointDigest: evidence.checkpointDigest, claimTokenDigest: claimDigest,
    executionId: registration.owner.executionId, executionAttemptCount: registration.owner.executionAttemptCount }
  return { status: "gate_continuation", handoff, prepareProof: proof, ...(scheduledWaitId ? { scheduledWaitId } : {}) }
}

function gateAppendRevisionMatches(loaded: Awaited<ReturnType<typeof loadTaskGraph>>, gateTaskId: string, revision: number, rootTaskId: string): boolean {
  const events = loaded.state?.appliedEvents.filter(event => event.nodeKey === SCHEDULED_GATE_TEMPLATE_ID && event.type === "task.started"
    && event.idempotencyKey === taskGraphLifecycleKey(rootTaskId, SCHEDULED_GATE_TEMPLATE_ID, 1, "task.started")) ?? []
  const gate = loaded.tasks.get(gateTaskId)
  return events.length === 1 ? events[0]?.expectedRevision === revision
    : events.length === 0 && gate?.status === "queued" && gate.attemptCount === 0 && loaded.state?.revision === revision
}

async function hasOrphanAuditRegistration(client: Queryable, scope: GraphIdentityScope, rootAttemptCount: number): Promise<boolean> {
  const result = await client.query(`SELECT event."itemId", event."taskId", event."actor", event."idempotencyKey", event."payload",
      EXISTS (SELECT 1 FROM "agent_outbox" AS outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id"
        OR outbox."payload"->>'eventId' = event."id") AS "hasOutbox"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = $3
      AND session."userId" = $4 AND turn."userId" = $4`, [scope.sessionId, scope.turnId,
    SCHEDULED_AUDIT_REGISTRATION_RECEIPT_EVENT, scope.userId])
  return result.rows.some(raw => {
    const row = record(raw), receipt = parseScheduledAuditRegistrationReceipt(row?.payload)
    if (!row || !receipt || row.itemId !== null || row.taskId !== null || row.actor !== "system" || row.hasOutbox !== false
      || row.idempotencyKey !== scheduledAuditRegistrationReceiptKey(receipt.continuationKey, receipt.auditTaskId)
      || receipt.owner.userId !== scope.userId || receipt.owner.sessionId !== scope.sessionId
      || receipt.owner.turnId !== scope.turnId || receipt.owner.rootTaskId !== scope.rootTaskId) return true
    return receipt.owner.rootAttemptCount >= rootAttemptCount
  })
}

export async function resumeScheduledAudit(input: Readonly<{ command: ResumeCommand; waitPort: Pick<DurableWaitPort, "wait">;
  scope: TaskGraphReadScope; recoveryStepId: string; signal: AbortSignal }>): Promise<
  | Readonly<{ status: "not_registered" | "completed" }>
  | Extract<ScheduledAuditResumeContext, { status: "gate_continuation" }>
  | Readonly<{ status: "waiting_for_dependency"; waitId: string }>
  | Readonly<{ status: "blocked"; errorCode: string }>> {
  if (input.signal.aborted) throw input.signal.reason ?? new Error("scheduled_audit_resume_cancelled")
  const command = input.command
  if (!command.readScheduledAuditResumeContext || !command.verifyScheduledAuditCompletion) {
    return { status: "blocked", errorCode: "scheduled_audit_resume_unavailable" }
  }
  let context = await command.readScheduledAuditResumeContext({ scope: input.scope })
  if (context.status === "not_registered") return { status: "not_registered" }
  if (context.status === "gate_continuation") return context
  if (context.status !== "registered") return { status: "blocked", errorCode: "scheduled_audit_resume_invalid" }
  if (context.auditStatus !== "completed") {
    const initialContext = context
    const wait = await input.waitPort.wait({ userId: input.scope.userId, sessionId: input.scope.sessionId,
      turnId: input.scope.turnId, stepId: input.recoveryStepId, taskId: input.scope.rootTaskId, rootTaskId: input.scope.rootTaskId,
      targetTaskIds: [context.auditTaskId], mode: "all", timeoutMs: WAIT_TIMEOUT_MS,
      idempotencyKey: scheduledAuditWaitKey(context.auditTaskId, input.recoveryStepId, context.expectedAttemptCount) })
    if (!validScheduledAuditWait(wait, context.auditTaskId)) return { status: "blocked", errorCode: "scheduled_audit_wait_invalid" }
    if (wait.status === "waiting") return { status: "waiting_for_dependency", waitId: wait.waitId }
    if (wait.status !== "ready") return { status: "blocked", errorCode: `scheduled_audit_wait_${wait.status}` }
    if (input.signal.aborted) throw input.signal.reason ?? new Error("scheduled_audit_resume_cancelled")
    context = await command.readScheduledAuditResumeContext({ scope: input.scope })
    if (context.status !== "registered" || context.auditStatus !== "completed") {
      return { status: "blocked", errorCode: "scheduled_audit_wait_state_invalid" }
    }
    if (context.auditTaskId !== initialContext.auditTaskId || context.expectedAttemptCount !== initialContext.expectedAttemptCount
      || !same(context.owner, initialContext.owner) || context.snapshotDigest !== initialContext.snapshotDigest
      || !same(context.gateProof, initialContext.gateProof)) {
      return { status: "blocked", errorCode: "scheduled_audit_wait_binding_changed" }
    }
  }
  const proof = await command.verifyScheduledAuditCompletion({ scope: input.scope, executionOwner: context.executionOwner, gateProof: context.gateProof,
    auditTaskId: context.auditTaskId, attemptCount: context.expectedAttemptCount })
  if (input.signal.aborted) throw input.signal.reason ?? new Error("scheduled_audit_resume_cancelled")
  return scheduledAuditCompletionProofMatches(proof, { owner: context.owner, snapshotDigest: context.snapshotDigest,
    gateProof: context.gateProof, auditTaskId: context.auditTaskId, attemptCount: context.expectedAttemptCount })
    ? { status: "completed" } : { status: "blocked", errorCode: "scheduled_audit_completion_unverified" }
}

export function scheduledAuditCompletionProofMatches(value: ScheduledAuditCompletionProof | null, expected: Readonly<{
  owner: ScheduledAuditCompletionProof["owner"]
  snapshotDigest: string
  gateProof: ScheduledAuditCompletionProof["gateProof"]
  auditTaskId: string
  attemptCount: number
}>): boolean {
  try {
    const owner = value?.owner, audit = value?.audit
    return Boolean(value && value.schemaVersion === SCHEDULED_AUDIT_COMPLETION_PROOF_SCHEMA
      && Object.keys(value).sort().join(",") === "audit,gateProof,graphRevision,owner,report,schemaVersion,snapshotDigest"
      && owner && same(owner, expected.owner)
      && value.snapshotDigest === expected.snapshotDigest && same(value.gateProof, expected.gateProof)
      && Number.isSafeInteger(value.graphRevision) && value.graphRevision > expected.gateProof.graphRevision
      && audit && Object.keys(audit).sort().join(",") === "attemptCount,completedEventRevision,resultDigest,taskId"
      && audit.taskId === expected.auditTaskId && audit.attemptCount === expected.attemptCount
      && typeof audit.resultDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(audit.resultDigest)
      && Number.isSafeInteger(audit.completedEventRevision) && audit.completedEventRevision! > 0
      && audit.completedEventRevision! <= value.graphRevision && parseScheduledAuditReport(value.report))
  } catch { return false }
}

export function scheduledAuditWaitKey(taskId: string, stepId: string, attemptCount: number): string {
  const digest = createHash("sha256").update(JSON.stringify([taskId, stepId, attemptCount]), "utf8").digest("hex")
  return `scheduled-audit-wait:${digest}`
}
export function validScheduledAuditWait(value: DurableWaitResult, taskId: string): boolean {
  try {
    const row = record(value), matched = row?.matchedTaskIds
    return !!row && validId(row.waitId) && Array.isArray(matched)
      && ["waiting", "ready", "timed_out", "interrupted", "closed"].includes(String(row.status))
      && (row.status === "ready" ? matched.length === 1 && matched[0] === taskId
        : row.status === "waiting" ? matched.length === 0 : true)
  } catch { return false }
}
function record(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
}
function same(left: unknown, right: unknown): boolean {
  try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false }
}
function validId(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 }
