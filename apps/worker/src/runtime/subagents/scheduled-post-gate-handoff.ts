import type { DurableWaitPort, DurableWaitResult } from "../tools/coordination-types.js"
import type { Queryable } from "./pg-store-persistence.js"
import { currentTaskGraph, type LoadedGraph } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson, taskGraphFingerprint, taskGraphItemId, taskGraphLifecycleKey, taskGraphProposalKey } from "./task-graph-snapshot.js"
import { scheduledGatePreparedJobIds, parseScheduledGateTaskEnvelope, SCHEDULED_GATE_NODE_CRITERIA,
  SCHEDULED_GATE_NODE_GOAL, SCHEDULED_GATE_OUTPUT_SCHEMA, SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE,
  SCHEDULED_GATE_TEMPLATE_ID, type ScheduledGateCompletionProof } from "./scheduled-gate-contract.js"
import { scheduledGateResultDigest } from "./pg-scheduled-task-graph-gate-verification.js"
import { verifyPersistedScheduledPreparePrefix } from "./pg-scheduled-task-graph-gate-verification.js"
import { parseScheduledPostGatePlan } from "./scheduled-post-gate-plan.js"
import { parseScheduledPostGateHandoff, scheduledPostGateDigest, scheduledPostGateHandoffKey,
  SCHEDULED_POST_GATE_AUDIT_CRITERIA, SCHEDULED_POST_GATE_AUDIT_GOAL, SCHEDULED_POST_GATE_AUDIT_OUTPUT_SCHEMA,
  SCHEDULED_POST_GATE_AUDIT_ROLE, SCHEDULED_POST_GATE_AUDIT_TASK_TYPE, SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID,
  SCHEDULED_POST_GATE_EXECUTE_OUTPUT_SCHEMA, SCHEDULED_POST_GATE_EXECUTE_ROLE, SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE,
  SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID, type ScheduledPostGateHandoff, type ScheduledPostGateOwner } from "./scheduled-post-gate-contract.js"
import type { TaskGraphCommandPort, TaskGraphReadScope } from "./task-graph-command-port.js"
import { parseScheduledAuditReport } from "./scheduled-audit-contract.js"
import type { ScheduledPostGateCompletionProof } from "./scheduled-post-gate-contract.js"

type Row = Record<string, unknown>
const HANDOFF_EVENT = "agent.plan.scheduled_post_gate_handoff"
const WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1_000

export type ScheduledPostGateResumeResult = Readonly<{ status: "not_registered" | "awaiting_plan" | "completed" }>
  | Readonly<{ status: "waiting_for_dependency"; waitId: string }>
  | Readonly<{ status: "blocked"; errorCode: string }>

/** Rehydrates a persisted handoff, waits for its exact planned children, and verifies completion without replaying Gate. */
export async function resumeScheduledPostGate(input: Readonly<{ command: TaskGraphCommandPort; waitPort: Pick<DurableWaitPort, "wait">;
  scope: TaskGraphReadScope; recoveryStepId: string; signal: AbortSignal }>): Promise<ScheduledPostGateResumeResult> {
  if (input.signal.aborted) throw input.signal.reason ?? new Error("scheduled_post_gate_resume_cancelled")
  const command = input.command
  if (!command.readScheduledPostGatePlanningContext || !command.verifyScheduledPostGateCompletion) {
    return { status: "not_registered" }
  }
  const first = await command.readScheduledPostGatePlanningContext({ scope: input.scope })
  if (first.status === "not_applicable") return { status: "not_registered" }
  if (first.status === "invalid") return { status: "blocked", errorCode: "scheduled_post_gate_resume_invalid" }
  if (first.status === "awaiting_plan") return { status: "awaiting_plan" }
  if (!scopeMatchesHandoff(input.scope, first.receipt)) return { status: "blocked", errorCode: "scheduled_post_gate_owner_mismatch" }
  const handoff = first.receipt
  const targets = [...handoff.executeNodes.map(node => node.taskId), handoff.auditTaskId]
  const wait = await input.waitPort.wait({ userId: input.scope.userId, sessionId: input.scope.sessionId,
    turnId: input.scope.turnId, stepId: input.recoveryStepId, taskId: input.scope.rootTaskId, rootTaskId: input.scope.rootTaskId,
    targetTaskIds: targets, mode: "all", timeoutMs: WAIT_TIMEOUT_MS,
    idempotencyKey: `scheduled-post-gate-wait:${scheduledPostGateDigest([handoff, input.recoveryStepId, targets]).slice(7)}` })
  if (!validPostGateWait(wait, targets)) return { status: "blocked", errorCode: "scheduled_post_gate_wait_invalid" }
  if (wait.status === "waiting") return { status: "waiting_for_dependency", waitId: wait.waitId }
  if (wait.status !== "ready") return { status: "blocked", errorCode: `scheduled_post_gate_wait_${wait.status}` }
  if (input.signal.aborted) throw input.signal.reason ?? new Error("scheduled_post_gate_resume_cancelled")
  const current = await command.readScheduledPostGatePlanningContext({ scope: input.scope })
  if (current.status !== "planned" || current.graphRevision < first.graphRevision
    || !same(current.receipt, handoff)) return { status: "blocked", errorCode: "scheduled_post_gate_wait_binding_changed" }
  const proof = await command.verifyScheduledPostGateCompletion({ scope: input.scope })
  if (input.signal.aborted) throw input.signal.reason ?? new Error("scheduled_post_gate_resume_cancelled")
  return postGateProofMatches(proof, handoff) ? { status: "completed" }
    : { status: "blocked", errorCode: "scheduled_post_gate_completion_unverified" }
}

function scopeMatchesHandoff(scope: TaskGraphReadScope, handoff: ScheduledPostGateHandoff): boolean {
  return handoff.owner.userId === scope.userId && handoff.owner.sessionId === scope.sessionId && handoff.owner.turnId === scope.turnId
    && handoff.owner.rootTaskId === scope.rootTaskId && handoff.owner.rootAttemptCount === scope.parentAttemptCount
}

function postGateProofMatches(proof: ScheduledPostGateCompletionProof | null,
  handoff: ScheduledPostGateHandoff): boolean {
  try {
    const executions = proof && dense(proof.execute, 3)
    if (!proof || proof.schemaVersion !== "agent-harness.v2.scheduled-post-gate-completion.v1"
      || !same(proof.handoff, handoff) || !Number.isSafeInteger(proof.graphRevision) || proof.graphRevision < handoff.graphRevision
      || !executions || executions.length !== handoff.executeNodes.length || proof.audit.taskId !== handoff.auditTaskId
      || !positive(proof.audit.attemptCount) || !digest(proof.audit.resultDigest)
      || !positive(proof.audit.completedEventRevision) || proof.audit.completedEventRevision > proof.graphRevision
      || proof.audit.completedEventRevision <= handoff.graphRevision || !parseScheduledAuditReport(proof.audit.report)) return false
    return executions.every((raw, index) => {
      const item = record(raw)
      return !!item && item.taskId === handoff.executeNodes[index]?.taskId
      && positive(item.attemptCount) && digest(item.resultDigest) && positive(item.completedEventRevision)
      && item.completedEventRevision > handoff.graphRevision && item.completedEventRevision < proof.audit.completedEventRevision
    })
  } catch { return false }
}

function validPostGateWait(value: DurableWaitResult, targets: readonly string[]): boolean {
  const matched = value.matchedTaskIds
  if (!Array.isArray(matched) || Reflect.ownKeys(matched).length !== matched.length + 1
    || !Reflect.ownKeys(matched).every(key => key === "length" || typeof key === "string"
      && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < matched.length)) return false
  return validId(value.waitId) && ["waiting", "ready", "timed_out", "interrupted", "closed"].includes(value.status)
    && (value.status === "ready" ? sameSet(matched, targets) : value.status === "waiting" ? matched.length === 0 : true)
}

/** Reads the single immutable post-Gate receipt from the locked transaction. */
export async function readScheduledPostGateReceipt(client: Queryable,
  scope: Pick<TaskGraphReadScope, "userId" | "sessionId" | "turnId" | "rootTaskId">): Promise<ScheduledPostGateHandoff | null> {
  const result = await client.query<Row>(`SELECT event."itemId", event."taskId", event."actor", event."idempotencyKey", event."payload"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = $3
      AND session."userId" = $4 AND turn."userId" = $4`, [scope.sessionId, scope.turnId, HANDOFF_EVENT, scope.userId])
  if (result.rows.length === 0) return null
  if (result.rows.length !== 1) throw invalid("receipt_conflict")
  const row = record(result.rows[0]), receipt = row && parseScheduledPostGateHandoff(row.payload)
  if (!row || !receipt || row.itemId !== null || row.taskId !== null || row.actor !== "system"
    || row.idempotencyKey !== scheduledPostGateHandoffKey({ ...receipt.owner, gateTaskId: receipt.gateTaskId,
      gateAttemptCount: receipt.gateAttemptCount })) throw invalid("receipt_invalid")
  return receipt
}

/** Rebinds the immutable proof to the Gate lifecycle, result row, accepted plan, and current Execute/Audit rows. */
export async function validateScheduledPostGateHandoff(client: Queryable, scope: TaskGraphReadScope, loaded: LoadedGraph,
  receipt: ScheduledPostGateHandoff): Promise<boolean> {
  const snapshot = loaded.snapshot, state = loaded.state
  if (!snapshot || !state || receipt.owner.userId !== scope.userId || receipt.owner.sessionId !== scope.sessionId
    || receipt.owner.turnId !== scope.turnId || receipt.owner.rootTaskId !== scope.rootTaskId
    || receipt.owner.rootAttemptCount !== scope.parentAttemptCount || receipt.graphRevision > state.revision
    || receipt.gateProofDigest !== scheduledPostGateDigest(receipt.gateProof)
    || receipt.gateResultDigest !== receipt.gateProof.gate.resultDigest
    || receipt.gateGraphRevision !== receipt.gateProof.graphRevision
    || receipt.gateCompletedEventRevision !== receipt.gateProof.gate.completedEventRevision
    || receipt.snapshotDigest !== receipt.gateProof.prepareProof.receipt.snapshotDigest
    || receipt.continuationKey !== receipt.gateProof.prepareProof.receipt.continuationKey
    || !validOwnerMatchesProof(receipt.owner, receipt.gateProof)) return false
  const gateNode = snapshot.nodes.find(node => node.key === SCHEDULED_GATE_TEMPLATE_ID), gate = gateNode && loaded.tasks.get(gateNode.taskId)
  if (!gateNode || !gate || gateNode.taskId !== receipt.gateTaskId || gateNode.templateId !== SCHEDULED_GATE_TEMPLATE_ID
    || gateNode.depth !== 4 || gateNode.verificationDisposition !== "specialized" || gateNode.verification !== undefined
    || gateNode.goal !== SCHEDULED_GATE_NODE_GOAL || !same(gateNode.successCriteria, SCHEDULED_GATE_NODE_CRITERIA)
    || !same(gateNode.dependsOn, ["prepare"]) || gate.status !== "completed" || gate.attemptCount !== receipt.gateAttemptCount
    || gate.failureReason !== null || gate.role !== SCHEDULED_GATE_ROLE || gate.taskType !== SCHEDULED_GATE_TASK_TYPE
    || !same(gate.expectedOutputSchema, SCHEDULED_GATE_OUTPUT_SCHEMA) || !same(gate.allowedActions, []) || gate.contextIsEmpty !== true
    || scheduledGateResultDigest(gate.result) !== receipt.gateResultDigest) return false
  const gateEvents = state.appliedEvents.filter(event => event.nodeKey === SCHEDULED_GATE_TEMPLATE_ID && event.type === "task.completed"
    && event.idempotencyKey === taskGraphLifecycleKey(scope.rootTaskId, SCHEDULED_GATE_TEMPLATE_ID, receipt.gateAttemptCount, "task.completed"))
  if (gateEvents.length !== 1 || gateEvents[0]?.expectedRevision + 1 !== receipt.gateCompletedEventRevision
    || receipt.gateCompletedEventRevision !== receipt.gateGraphRevision) return false
  const preparedIds = scheduledGatePreparedJobIds(receipt.gateProof.prepareProof)
  const envelope = preparedIds && parseScheduledGateTaskEnvelope(gate.result, gate.status, preparedIds)
  if (!envelope || envelope.structuredResult.status !== "completed"
    || !same(envelope.structuredResult.approvedJobIds, receipt.packageRefs)
    || !await verifyPersistedScheduledPreparePrefix(client, scope, loaded, receipt.gateProof.prepareProof)) return false

  const gateIndex = snapshot.nodes.findIndex(node => node.key === SCHEDULED_GATE_TEMPLATE_ID)
  const suffix = snapshot.nodes.slice(gateIndex + 1)
  if (gateIndex < 0 || suffix.length !== receipt.executeNodes.length + 1) return false
  const executeNodes = receipt.executeNodes.map(reference => {
    const node = suffix.find(value => value.key === reference.key)
    return node && node.taskId === reference.taskId && node.templateId === SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID
      && node.depth === 5 && node.verificationDisposition === "specialized" && node.verification === undefined
      && node.packageRefs !== undefined && same(node.packageRefs, reference.packageRefs) && same(node.dependsOn, [SCHEDULED_GATE_TEMPLATE_ID])
      ? node : null
  })
  const auditNode = suffix.at(-1)
  if (executeNodes.some(node => node === null) || !auditNode || auditNode.key !== SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID
    || auditNode.templateId !== SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID || auditNode.taskId !== receipt.auditTaskId
    || auditNode.depth !== 6 || auditNode.verificationDisposition !== "specialized" || auditNode.verification !== undefined
    || auditNode.goal !== SCHEDULED_POST_GATE_AUDIT_GOAL || !same(auditNode.successCriteria, SCHEDULED_POST_GATE_AUDIT_CRITERIA)
    || !sameSet(auditNode.dependsOn, receipt.executeNodes.map(node => node.key))) return false
  const proposal = { expectedRevision: receipt.gateGraphRevision, nodes: suffix.map(node => ({ key: node.key,
    templateId: node.templateId, goal: node.goal, successCriteria: node.successCriteria, dependsOn: node.dependsOn,
    ...(node.packageRefs === undefined ? {} : { packageRefs: node.packageRefs }) })) }
  if (receipt.proposalDigest !== scheduledPostGateDigest(proposal)
    || !parseScheduledPostGatePlan(proposal, receipt.gateGraphRevision, receipt.packageRefs)
    || !await acceptedPlanMatches(client, scope, receipt, proposal)) return false
  for (const node of [...executeNodes, auditNode]) {
    if (!node) return false
    const task = loaded.tasks.get(node.taskId)
    if (!task || task.id !== node.taskId || task.status !== currentTaskGraph(loaded).nodes.find(value => value.key === node.key)?.status
      || task.failureReason !== currentTaskGraph(loaded).nodes.find(value => value.key === node.key)?.failureReason) return false
    if (node.templateId === SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID) {
      if (task.role !== SCHEDULED_POST_GATE_EXECUTE_ROLE || task.taskType !== SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE
        || !same(task.expectedOutputSchema, SCHEDULED_POST_GATE_EXECUTE_OUTPUT_SCHEMA) || !same(task.allowedActions, []) || task.contextIsEmpty !== true) return false
    } else if (task.role !== SCHEDULED_POST_GATE_AUDIT_ROLE || task.taskType !== SCHEDULED_POST_GATE_AUDIT_TASK_TYPE
      || !same(task.expectedOutputSchema, SCHEDULED_POST_GATE_AUDIT_OUTPUT_SCHEMA) || !same(task.allowedActions, []) || task.contextIsEmpty !== true) return false
  }
  return true
}

async function acceptedPlanMatches(client: Queryable, scope: TaskGraphReadScope, receipt: ScheduledPostGateHandoff,
  proposal: ReturnType<typeof planProposal>): Promise<boolean> {
  const key = taskGraphProposalKey(scope.rootTaskId, receipt.gateGraphRevision)
  const result = await client.query<Row>(`SELECT event."itemId", event."taskId", event."actor", event."idempotencyKey", event."payload"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" IN ('item.started', 'item.delta')
      AND event."idempotencyKey" = $3 AND session."userId" = $4 AND turn."userId" = $4`,
  [scope.sessionId, scope.turnId, key, scope.userId])
  if (result.rows.length !== 1) return false
  const event = record(result.rows[0]), payload = event && record(event.payload), planReceipt = payload && record(payload.receipt)
  const planNodes = planReceipt && dense(planReceipt.nodes, 4)
  const expectedNodes = [...receipt.executeNodes.map(node => ({ key: node.key, taskId: node.taskId, status: "queued" })),
    { key: SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID, taskId: receipt.auditTaskId, status: "waiting" }]
  return !!event && !!payload && !!planReceipt && !!planNodes && event.itemId === taskGraphItemId(scope.rootTaskId)
    && event.taskId === scope.rootTaskId && event.actor === "orchestrator" && event.idempotencyKey === key
    && payload.kind === "proposal" && payload.revision === receipt.graphRevision
    && payload.fingerprint === taskGraphFingerprint(proposal)
    && planReceipt.status === "accepted" && planReceipt.revision === receipt.graphRevision
    && canonicalTaskGraphJson(planNodes) === canonicalTaskGraphJson(expectedNodes)
    && canonicalTaskGraphJson(planReceipt.readyTaskIds) === canonicalTaskGraphJson(receipt.executeNodes.map(node => node.taskId))
}

function planProposal(value: unknown) { return value as { expectedRevision: number; nodes: readonly Record<string, unknown>[] } }
function dense(value: unknown, max: number): unknown[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) return null
  const keys = Reflect.ownKeys(value)
  return keys.length === value.length + 1 && keys.every(key => key === "length" || typeof key === "string"
    && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length) ? value : null
}

function validOwnerMatchesProof(owner: ScheduledPostGateOwner, proof: ScheduledGateCompletionProof): boolean {
  const proofOwner = proof.prepareProof.receipt.owner
  return owner.userId === proofOwner.userId && owner.sessionId === proofOwner.sessionId && owner.turnId === proofOwner.turnId
    && owner.rootTaskId === proofOwner.rootTaskId && owner.rootAttemptCount === proofOwner.rootAttemptCount
    && owner.turnLeaseOwnerId === proofOwner.turnLeaseOwnerId && owner.turnLeaseVersion === proofOwner.turnLeaseVersion
    && owner.executionId === proofOwner.executionId && owner.executionAttemptCount === proofOwner.executionAttemptCount
}
function record(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : null } catch { return null }
}
function same(left: unknown, right: unknown): boolean { try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false } }
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every(value => right.includes(value))
}
function validId(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function digest(value: unknown): value is string { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value) }
function invalid(reason: string): Error { return Object.assign(new Error("Scheduled post-Gate handoff is invalid"), { code: `scheduled_post_gate_${reason}` }) }
