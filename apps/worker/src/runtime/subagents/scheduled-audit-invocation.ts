import { createHash } from "node:crypto"
import type { ScheduledGateCompletionProof } from "./scheduled-gate-contract.js"
import { scheduledGateCheckpointEvidence, scheduledGatePreparedJobIds, parseScheduledGateTaskEnvelope,
  SCHEDULED_GATE_OUTPUT_SCHEMA, SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE } from "./scheduled-gate-contract.js"
import type { ScheduledAutomationPipelineAttestation } from "./scheduled-automation-pipeline-bridge.js"
import { scheduledAnalyzeGraphMatches, scheduledSnapshotMatches } from "./scheduled-taskgraph-continuation-receipt.js"
import { readScheduledGateRegistrationReceipt } from "./scheduled-gate-registration-receipt.js"
import { loadPersistedScheduledPrepareProof } from "./scheduled-gate-wait-match.js"
import { scheduledGateResultDigest, verifyPersistedScheduledPreparePrefix } from "./pg-scheduled-task-graph-gate-verification.js"
import { currentTaskGraph, loadTaskGraph, type GraphIdentityScope, type LoadedGraph } from "./task-graph-pg-state.js"
import type { Queryable } from "./pg-store-persistence.js"
import { type TaskGraphProposal } from "../planning/task-graph.js"
import { canonicalTaskGraphJson as snapshotJson, taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import { parseScheduledAuditRegistrationReceipt, scheduledAuditRegistrationReceiptKey,
  SCHEDULED_AUDIT_INVOCATION_PROOF_SCHEMA, SCHEDULED_AUDIT_NODE_CRITERIA, SCHEDULED_AUDIT_NODE_GOAL,
  SCHEDULED_AUDIT_OUTPUT_SCHEMA, SCHEDULED_AUDIT_REGISTRATION_RECEIPT_EVENT,
  SCHEDULED_AUDIT_ROLE, SCHEDULED_AUDIT_TASK_TYPE, SCHEDULED_AUDIT_TEMPLATE_ID, parseScheduledAuditReport,
  type ScheduledAuditInvocationProof, type ScheduledAuditOwner, type ScheduledAuditRegistrationReceipt,
  type ScheduledAuditInvocationScope, type TaskGraphScheduledAuditInvocationInput } from "./scheduled-audit-contract.js"
import type { ScheduledGateCheckpointEvidence } from "./scheduled-gate-contract.js"

type Row = Record<string, unknown>
type Registration = ScheduledAuditRegistrationReceipt

/** Adapts only an exact completed Audit report checkpoint to the unchanged Gate evidence parser. */
export function scheduledAuditGateCheckpointEvidence(value: unknown, executionStatus: unknown): ScheduledGateCheckpointEvidence | null {
  const state = record(value)
  if (executionStatus === "completed") {
    if (!state || state.nextStage !== "completed" || !parseScheduledAuditReport(state.report)) return null
    return scheduledGateCheckpointEvidence({ ...state, nextStage: "gate" })
  }
  if (executionStatus !== "running" && executionStatus !== "paused") return null
  return scheduledGateCheckpointEvidence(value)
}

/** Reloads the server-only binding and canonical Gate/Prepare proof for a running Audit lease. */
export async function readScheduledAuditInvocationProof(client: Queryable,
  input: TaskGraphScheduledAuditInvocationInput): Promise<ScheduledAuditInvocationProof | null> {
  if (!Number.isSafeInteger(input.attemptCount) || input.attemptCount < 1) return null
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [input.scope.userId])
  const scope = graphScope(input.scope), loaded = await loadTaskGraph(client, scope, false)
  const registration = await readScheduledAuditRegistration(client, scope, input.auditTaskId)
  if (!registration || !attestationOwns(input.attestation, registration.owner)
    || input.attestation.snapshotDigest !== registration.snapshotDigest || !loaded.snapshot || !loaded.state
    || loaded.snapshot.nodes.length !== 5 || !validAuditNode(loaded, input.auditTaskId)) return null
  const task = loaded.tasks.get(input.auditTaskId)
  const current = currentTaskGraph(loaded).nodes.find(node => node.key === SCHEDULED_AUDIT_TEMPLATE_ID)
  if (!task || task.status !== "running" || task.attemptCount !== input.attemptCount || !current
    || current.taskId !== input.auditTaskId || current.status !== "running"
    || task.role !== SCHEDULED_AUDIT_ROLE || task.taskType !== SCHEDULED_AUDIT_TASK_TYPE
    || !same(task.expectedOutputSchema, SCHEDULED_AUDIT_OUTPUT_SCHEMA) || !same(task.allowedActions, [])
    || task.contextIsEmpty !== true) return null
  const gateProof = await verifyRegisteredScheduledAuditGate(client, scope, loaded, registration, undefined, input.attestation)
  if (!gateProof || digest(gateProof) !== registration.gateProofDigest) return null
  return { schemaVersion: SCHEDULED_AUDIT_INVOCATION_PROOF_SCHEMA, owner: registration.owner,
    snapshotDigest: registration.snapshotDigest, attestation: input.attestation, prepareProof: gateProof.prepareProof,
    gateProof, scheduledWaitId: registration.scheduledWaitId, auditTaskId: input.auditTaskId,
    attemptCount: input.attemptCount, graphRevision: loaded.state.revision }
}

/** Loads a private Audit binding, optionally requiring its full owner tuple. */
export async function readScheduledAuditRegistration(client: Queryable, scope: GraphIdentityScope,
  taskId: string, owner?: ScheduledAuditOwner): Promise<Registration | null> {
  const result = await client.query(`SELECT event."itemId", event."taskId", event."actor", event."idempotencyKey", event."payload",
      EXISTS (SELECT 1 FROM "agent_outbox" AS outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id"
        OR outbox."payload"->>'eventId' = event."id") AS "hasOutbox"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = $3
      AND session."userId" = $4 AND turn."userId" = $4`, [scope.sessionId, scope.turnId,
    SCHEDULED_AUDIT_REGISTRATION_RECEIPT_EVENT, scope.userId])
  const row = result.rows.length === 1 ? record(result.rows[0]) : null
  const receipt = parseScheduledAuditRegistrationReceipt(row?.payload)
  return row && receipt && row.itemId === null && row.taskId === null && row.actor === "system" && row.hasOutbox === false
    && row.idempotencyKey === scheduledAuditRegistrationReceiptKey(receipt.continuationKey, taskId)
    && receipt.auditTaskId === taskId && receipt.owner.userId === scope.userId && receipt.owner.sessionId === scope.sessionId
    && receipt.owner.turnId === scope.turnId && receipt.owner.rootTaskId === scope.rootTaskId
    && (!owner || same(receipt.owner, owner)) ? receipt : null
}

/** Revalidates the historical Gate completion against current execution and Prepare evidence, including exact completed-report replay. */
export async function verifyRegisteredScheduledAuditGate(client: Queryable, scope: GraphIdentityScope,
  loaded: LoadedGraph, registration: Registration, expected?: ScheduledGateCompletionProof,
  attestation?: ScheduledAutomationPipelineAttestation): Promise<ScheduledGateCompletionProof | null> {
  const snapshot = loaded.snapshot, state = loaded.state, gateNode = snapshot?.nodes.find(node => node.key === "gate")
  const gate = gateNode && loaded.tasks.get(gateNode.taskId), prepareNode = snapshot?.nodes.find(node => node.key === "prepare")
  const prepare = prepareNode && loaded.tasks.get(prepareNode.taskId)
  const executionRows = await client.query(`SELECT "id", "status", "attemptCount", "state" FROM "agent_executions"
    WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3`, [registration.owner.executionId, scope.userId, scope.sessionId])
  const execution = record(executionRows.rows[0]), evidence = scheduledAuditGateCheckpointEvidence(execution?.state, execution?.status)
  const turn = await readTurn(client, scope)
  if (!snapshot || !state || snapshot.nodes.length !== 5 || state.revision < registration.auditAppendRevision
    || !gateNode || !gate || !prepareNode || !prepare
    || executionRows.rows.length !== 1 || !execution || !["running", "paused", "completed"].includes(String(execution.status))
    || Number(execution.attemptCount) !== registration.owner.executionAttemptCount || !evidence || !turn
    || !scheduledSnapshotMatches(turn, registration.snapshotDigest) || !evidenceOwns(evidence, registration)
    || gateNode.templateId !== "gate" || gateNode.depth !== 4 || gateNode.verificationDisposition !== "specialized"
    || gateNode.goal !== "Review the exact server-prepared applications and return the fixed pending or skip decisions required by the scheduled Gate policy."
    || !same(gateNode.successCriteria, ["Return only the strict scheduled Gate result for the exact server-prepared job set; never mark a job approved.",
      "Ask only the fixed-choice question produced by the scheduled Gate policy when required.", "Never submit applications, contact employers, or expose private job material."])
    || gateNode.dependsOn.length !== 1 || gateNode.dependsOn[0] !== "prepare" || gate.status !== "completed"
    || gate.role !== SCHEDULED_GATE_ROLE || gate.taskType !== SCHEDULED_GATE_TASK_TYPE
    || !same(gate.expectedOutputSchema, SCHEDULED_GATE_OUTPUT_SCHEMA) || !same(gate.allowedActions, []) || gate.contextIsEmpty !== true
    || gate.attemptCount !== registration.gateAttemptCount || gate.id !== registration.gateTaskId
    || !currentTaskGraph(loaded).nodes.some(node => node.key === "gate" && node.status === "completed")) return null
  const gateRegistration = await readScheduledGateRegistrationReceipt(client, { userId: scope.userId, sessionId: scope.sessionId,
    turnId: scope.turnId, owner: registration.owner, gateTaskId: gate.id })
  if (!gateRegistration || gateRegistration.continuationKey !== registration.continuationKey
    || gateRegistration.prepareWaitId !== registration.prepareWaitId || gateRegistration.gateAppendRevision >= registration.gateGraphRevision) return null
  const proof = await loadPersistedScheduledPrepareProof(client, scope, prepare.id, prepare.result,
    evidence.prepareWaitContinuationKey, registration.prepareWaitId)
  if (!proof || !same(proof, expected?.prepareProof ?? proof) || proof.completion.wait.waitId !== registration.prepareWaitId
    || !same(proof.receipt.owner, expected?.prepareProof.receipt.owner ?? proof.receipt.owner)) return null
  const prefix = { ...loaded, snapshot: { ...snapshot, nodes: snapshot.nodes.slice(0, 4) },
    state: { ...state, nodes: state.nodes.slice(0, 4) } }
  if (!await verifyPersistedScheduledPreparePrefix(client, scope, prefix, proof)
    || attestation && !verifyAttestation(loaded, attestation)) return null
  const gateRows = await client.query(`SELECT "status", "attemptCount", "role", "taskType", "expectedOutputSchema", "allowedActions", "context", "result", "failureReason", "leaseOwner", "leaseExpiresAt"
    FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4
      AND "parentTaskId" = $4 FOR UPDATE`, [gate.id, scope.sessionId, scope.turnId, scope.rootTaskId])
  const row = record(gateRows.rows[0]), expectedJobs = scheduledGatePreparedJobIds(proof)
  const envelope = expectedJobs && parseScheduledGateTaskEnvelope(gate.result, gate.status, expectedJobs)
  const events = state.appliedEvents.filter(event => event.nodeKey === "gate" && event.type === "task.completed"
    && event.idempotencyKey === taskGraphLifecycleKey(scope.rootTaskId, "gate", registration.gateAttemptCount, "task.completed"))
  if (gateRows.rows.length !== 1 || row?.status !== "completed" || Number(row.attemptCount) !== registration.gateAttemptCount
    || row.failureReason !== null || row.leaseOwner !== null || row.leaseExpiresAt !== null || row.role !== SCHEDULED_GATE_ROLE
    || row.taskType !== SCHEDULED_GATE_TASK_TYPE || !same(row.expectedOutputSchema, SCHEDULED_GATE_OUTPUT_SCHEMA)
    || !same(row.allowedActions, []) || !same(row.context, {}) || !envelope || envelope.structuredResult.status !== "completed"
    || events.length !== 1 || events[0]?.expectedRevision + 1 !== registration.gateGraphRevision
    || registration.gateCompletedEventRevision !== registration.gateGraphRevision) return null
  const resultDigest = scheduledGateResultDigest(gate.result)
  if (!resultDigest || resultDigest !== registration.gateResultDigest) return null
  const result: ScheduledGateCompletionProof = { schemaVersion: "agent-harness.v2.scheduled-taskgraph-gate-completion.v1",
    graphRevision: registration.gateGraphRevision, prepareProof: proof,
    gate: { taskId: gate.id, attemptCount: registration.gateAttemptCount, resultDigest,
      completedEventRevision: registration.gateCompletedEventRevision } }
  return expected && !same(result, expected) || !same(digest(result), registration.gateProofDigest) ? null : result
}

function verifyAttestation(loaded: LoadedGraph, attestation: ScheduledAutomationPipelineAttestation): boolean {
  const snapshot = loaded.snapshot, state = loaded.state
  if (!snapshot || !state) return false
  const nodes = snapshot.nodes.slice(0, 3), prepare = nodes[2]
  const current = currentTaskGraph(loaded).nodes.slice(0, 3)
  const proposal: TaskGraphProposal = { expectedRevision: attestation.graphRevision,
    nodes: prepare ? [{ key: prepare.key, templateId: prepare.templateId, goal: prepare.goal,
      successCriteria: prepare.successCriteria, dependsOn: prepare.dependsOn }] : [] }
  return !!prepare && !!scheduledAnalyzeGraphMatches({ proposal, attestation } as Parameters<typeof scheduledAnalyzeGraphMatches>[0],
    { ...snapshot, nodes }, { revision: state.revision, nodes: current }, loaded.tasks, true)
}

function validAuditNode(loaded: LoadedGraph, taskId: string): boolean {
  const node = loaded.snapshot?.nodes.find(value => value.key === SCHEDULED_AUDIT_TEMPLATE_ID)
  return !!node && node.taskId === taskId && node.templateId === SCHEDULED_AUDIT_TEMPLATE_ID && node.depth === 5
    && node.verificationDisposition === "specialized" && node.goal === SCHEDULED_AUDIT_NODE_GOAL
    && same(node.successCriteria, SCHEDULED_AUDIT_NODE_CRITERIA) && node.dependsOn.length === 1 && node.dependsOn[0] === "gate"
}

function evidenceOwns(evidence: NonNullable<ReturnType<typeof scheduledGateCheckpointEvidence>>, receipt: Registration): boolean {
  return evidence.owner.executionId === receipt.owner.executionId
    && evidence.owner.executionAttemptCount === receipt.owner.executionAttemptCount
    && evidence.owner.rootAttemptCount === receipt.owner.rootAttemptCount
    && evidence.continuationKey === receipt.continuationKey && evidence.snapshotDigest === receipt.snapshotDigest
    && evidence.evidenceDigest === receipt.evidenceDigest && evidence.checkpointDigest === receipt.checkpointDigest
    && evidence.analyzeGraphRevision === receipt.analyzeGraphRevision
}

function attestationOwns(attestation: ScheduledAutomationPipelineAttestation, owner: ScheduledAuditOwner): boolean {
  return attestation.owner.userId === owner.userId && attestation.owner.sessionId === owner.sessionId
    && attestation.owner.turnId === owner.turnId && attestation.owner.rootTaskId === owner.rootTaskId
    && attestation.owner.rootAttemptCount === owner.rootAttemptCount
}

async function readTurn(client: Queryable, scope: GraphIdentityScope): Promise<Row | null> {
  const result = await client.query(`SELECT "source", "executionMode", "input" FROM "agent_turns"
    WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`, [scope.turnId, scope.sessionId, scope.userId])
  return result.rows.length === 1 ? record(result.rows[0]) : null
}
function graphScope(scope: ScheduledAuditInvocationScope): GraphIdentityScope {
  return { ...scope, parentTaskId: scope.rootTaskId }
}
function record(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : null
}
function digest(value: unknown): string | null {
  try { return `sha256:${createHash("sha256").update(snapshotJson(value), "utf8").digest("hex")}` } catch { return null }
}
function same(left: unknown, right: unknown): boolean {
  try { return snapshotJson(left) === snapshotJson(right) } catch { return false }
}
