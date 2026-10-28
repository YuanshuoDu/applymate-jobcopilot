import { createHash } from "node:crypto"
import type { TaskGraphReadScope } from "./task-graph-command-port.js"
import { currentTaskGraph, type LoadedGraph } from "./task-graph-pg-state.js"
import type { Queryable } from "./pg-store-persistence.js"
import { canonicalTaskGraphJson, taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import { scheduledGateCheckpointEvidence, scheduledGatePreparedJobIds, SCHEDULED_GATE_NODE_CRITERIA, SCHEDULED_GATE_NODE_GOAL,
  SCHEDULED_GATE_OUTPUT_SCHEMA, SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE, SCHEDULED_GATE_TEMPLATE_ID } from "./scheduled-gate-contract.js"
import type { ScheduledAuditResumeContext } from "./scheduled-audit-contract.js"
import { readScheduledGateRegistrationReceipt } from "./scheduled-gate-registration-receipt.js"
import type { ScheduledPrepareTaskGraphProof } from "./scheduled-prepare-task-graph-verification.js"
import { scheduledGatePreparePrefixMatches } from "./scheduled-gate-prepare-prefix-proof.js"
import { verifyPersistedScheduledPreparePrefix } from "./pg-scheduled-task-graph-gate-verification.js"
import { scheduledSnapshotMatches, scheduledTaskGraphClaimMatches, scheduledTaskGraphContinuationKeyVersion,
  type ScheduledTaskGraphContinuationBinding } from "./scheduled-taskgraph-continuation-receipt.js"
import { projectScheduledPipelineGraph, projectScheduledPipelineGraphAtCurrentStage,
  type ScheduledPipelineGraphNode } from "./scheduled-pipeline-graph-shape.js"
import { scheduledQuestionWaitId } from "./scheduled-gate-child-runtime.js"

type Row = Record<string, unknown>
type PrepareScope = Pick<TaskGraphReadScope, "userId" | "sessionId" | "turnId" | "rootTaskId">
type ProofLoader = (client: Queryable, scope: PrepareScope, taskId: string, result: unknown, continuationKey: string,
  waitId: string) => Promise<ScheduledPrepareTaskGraphProof | null>

/** Reuses only a fully valid current graph shape; root/receipt ownership is checked separately. */
export function projectScheduledAuditResumeGraph<Node extends ScheduledPipelineGraphNode>(nodes: readonly Node[]) {
  return projectScheduledPipelineGraphAtCurrentStage(nodes)
}

/** Reads owner-bound Gate continuation proof from the caller's already locked transaction. */
export async function readScheduledAuditGateContinuationContext(client: Queryable, scope: TaskGraphReadScope,
  loaded: LoadedGraph, loadProof: ProofLoader): Promise<ScheduledAuditResumeContext> {
  const nodes = loaded.snapshot?.nodes, gateNode = nodes?.find(value => value.key === SCHEDULED_GATE_TEMPLATE_ID)
  const gate = gateNode && loaded.tasks.get(gateNode.taskId), currentGate = currentTaskGraph(loaded).nodes.find(node => node.key === SCHEDULED_GATE_TEMPLATE_ID)
  if (!nodes || !gateNode || gateNode.templateId !== SCHEDULED_GATE_TEMPLATE_ID || gateNode.depth !== 4
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
    || evidence.owner.rootAttemptCount !== scope.parentAttemptCount || registration.owner.rootAttemptCount !== scope.parentAttemptCount
    || registration.continuationKey !== evidence.continuationKey || registration.snapshotDigest !== evidence.snapshotDigest
    || registration.evidenceDigest !== evidence.evidenceDigest || registration.checkpointDigest !== evidence.checkpointDigest
    || registration.analyzeGraphRevision !== evidence.analyzeGraphRevision || registration.gateTaskId !== gate.id
    || registration.gateAppendRevision <= 0 || !gateAppendRevisionMatches(loaded, gate.id, registration.gateAppendRevision, scope.rootTaskId)) {
    return { status: "invalid" }
  }
  const version = scheduledTaskGraphContinuationKeyVersion(registration.continuationKey)
  const shape = version && projectScheduledPipelineGraph(nodes, version, "gate")
  if (!shape || shape.gate.taskId !== gate.id) return { status: "invalid" }
  const state = record(execution.state), claim = record(state?.scheduledTaskGraphClaim), checkpoint = record(record(state?.scheduledTaskGraphContinuation)?.owner)
  const leaseOwner = checkpoint?.turnLeaseOwnerId, leaseVersion = checkpoint?.turnLeaseVersion, token = claim?.claimToken
  if (!checkpoint || typeof token !== "string" || typeof leaseOwner !== "string" || !Number.isSafeInteger(leaseVersion)
    || checkpoint.userId !== evidence.owner.userId || checkpoint.sessionId !== evidence.owner.sessionId
    || checkpoint.turnId !== evidence.owner.turnId || checkpoint.rootTaskId !== evidence.owner.rootTaskId
    || checkpoint.rootAttemptCount !== evidence.owner.rootAttemptCount || checkpoint.executionId !== evidence.owner.executionId
    || checkpoint.executionAttemptCount !== evidence.owner.executionAttemptCount) return { status: "invalid" }
  const binding: ScheduledTaskGraphContinuationBinding = { owner: { ...evidence.owner, turnLeaseOwnerId: leaseOwner,
    turnLeaseVersion: Number(leaseVersion) }, continuationKey: evidence.prepareWaitContinuationKey, snapshotDigest: evidence.snapshotDigest,
    evidenceDigest: evidence.evidenceDigest, checkpointDigest: evidence.checkpointDigest,
    analyzeGraphRevision: evidence.analyzeGraphRevision, prepareScheduleRevision: evidence.analyzeGraphRevision + 1 }
  const now = execution.now instanceof Date || typeof execution.now === "string" ? execution.now : undefined
  const claimDigest = `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`
  if (!scheduledTaskGraphClaimMatches(execution.state, binding, claimDigest, now)) return { status: "invalid" }
  const turnRows = await client.query(`SELECT "source", "executionMode", "input" FROM "agent_turns"
    WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "rootTaskId" = $4`,
  [scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId])
  const turn = record(turnRows.rows[0]), waitId = scheduledQuestionWaitId(turn?.input, execution.state, scope.turnId)
  const prepareNode = shape.prepare, prepare = loaded.tasks.get(prepareNode.taskId)
  const proof = prepare?.status === "completed" ? await loadProof(client, scope,
    prepareNode.taskId, prepare.result, evidence.prepareWaitContinuationKey, registration.prepareWaitId) : null
  if (turnRows.rows.length !== 1 || !scheduledSnapshotMatches(turn, evidence.snapshotDigest) || waitId === null
    || !prepare || !proof || !scheduledGatePreparedJobIds(proof) || !scheduledGatePreparePrefixMatches(loaded, proof)
    || proof.receipt.continuationKey !== evidence.continuationKey || proof.receipt.owner.userId !== registration.owner.userId
    || proof.receipt.owner.sessionId !== registration.owner.sessionId || proof.receipt.owner.turnId !== registration.owner.turnId
    || proof.receipt.owner.rootTaskId !== registration.owner.rootTaskId || proof.receipt.owner.rootAttemptCount !== registration.owner.rootAttemptCount
    || proof.receipt.owner.executionId !== registration.owner.executionId
    || proof.receipt.owner.executionAttemptCount !== registration.owner.executionAttemptCount
    || proof.receipt.snapshotDigest !== evidence.snapshotDigest || proof.receipt.evidenceDigest !== evidence.evidenceDigest
    || proof.receipt.checkpointDigest !== evidence.checkpointDigest || proof.receipt.analyzeGraphRevision !== evidence.analyzeGraphRevision
    || proof.receipt.prepareScheduleRevision !== registration.prepareScheduleRevision || proof.completion.wait.waitId !== registration.prepareWaitId
    || registration.gateAppendRevision <= proof.completion.graphRevision || registration.gateAppendRevision > loaded.state!.revision
    || !await verifyPersistedScheduledPreparePrefix(client, scope, loaded, proof)) return { status: "invalid" }
  const handoff = { status: "analyze_checkpointed" as const, continuationKey: evidence.prepareWaitContinuationKey,
    checkpointDigest: evidence.checkpointDigest, claimTokenDigest: claimDigest,
    executionId: registration.owner.executionId, executionAttemptCount: registration.owner.executionAttemptCount }
  return { status: "gate_continuation", handoff, prepareProof: proof, ...(waitId ? { scheduledWaitId: waitId } : {}) }
}

function gateAppendRevisionMatches(loaded: LoadedGraph, gateTaskId: string, revision: number, rootTaskId: string): boolean {
  const events = loaded.state?.appliedEvents.filter(event => event.nodeKey === SCHEDULED_GATE_TEMPLATE_ID && event.type === "task.started"
    && event.idempotencyKey === taskGraphLifecycleKey(rootTaskId, SCHEDULED_GATE_TEMPLATE_ID, 1, "task.started")) ?? []
  const gate = loaded.tasks.get(gateTaskId)
  return events.length === 1 ? events[0]?.expectedRevision === revision
    : events.length === 0 && gate?.status === "queued" && gate.attemptCount === 0 && loaded.state?.revision === revision
}
function record(value: unknown): Row | null {
  const row = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!row || typeof row !== "object" || Array.isArray(row)) return null
  try { const prototype = Object.getPrototypeOf(row); return prototype === Object.prototype || prototype === null ? row as Row : null } catch { return null }
}
function same(left: unknown, right: unknown): boolean {
  try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false }
}
