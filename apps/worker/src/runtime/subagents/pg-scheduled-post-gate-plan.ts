import { appendScheduledPostGateTaskGraphProposal, TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { BudgetExceededError } from "../budget.js"
import { enforceRootStepBudget } from "../turns/turn-engine-root-budget.js"
import { TaskGraphCommandError,
  type TaskGraphScheduledPostGatePlanInput, type ScheduledPostGatePlanningContext } from "./task-graph-command-port.js"
import { appendTaskGraphReceipt, writePlanReceipt } from "./task-graph-pg-events.js"
import { createSubagentTask } from "./pg-store-create.js"
import { enqueueGraphTask } from "./task-graph-pg-create.js"
import { prepareSteeringReconciliation, writeSteeringReconciliationReceipt } from "./steering-reconciliation-ledger.js"
import { policyFromTask } from "./manager-task-scope.js"
import { inheritSubagentPolicy, type SubagentTaskRecord } from "./types.js"
import { currentTaskGraph, loadTaskGraph, lockTaskGraphScope } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson, taskGraphFingerprint, taskGraphProposalKey, taskGraphSnapshot } from "./task-graph-snapshot.js"
import type { Queryable } from "./pg-store-persistence.js"
import { readScheduledAuditGateContinuationContext } from "./scheduled-audit-resume-context.js"
import { loadPersistedScheduledPrepareProof } from "./scheduled-gate-wait-match.js"
import { verifyScheduledGateCompletion as verifyPersistedScheduledGateCompletion } from "./pg-scheduled-task-graph-gate-verification.js"
import { scheduledGatePreparedJobIds, parseScheduledGateTaskEnvelope } from "./scheduled-gate-contract.js"
import { parseScheduledAuditTaskEnvelope } from "./scheduled-audit-contract.js"
import { parseScheduledPostGatePlan } from "./scheduled-post-gate-plan.js"
import { readScheduledPostGateReceipt, validateScheduledPostGateHandoff } from "./scheduled-post-gate-handoff.js"
import { taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import {
  SCHEDULED_POST_GATE_AUDIT_CRITERIA, SCHEDULED_POST_GATE_AUDIT_GOAL, SCHEDULED_POST_GATE_AUDIT_OUTPUT_SCHEMA,
  SCHEDULED_POST_GATE_AUDIT_ROLE, SCHEDULED_POST_GATE_AUDIT_TASK_TYPE, SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID,
  SCHEDULED_POST_GATE_EXECUTE_OUTPUT_SCHEMA, SCHEDULED_POST_GATE_EXECUTE_ROLE, SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE,
  SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID, SCHEDULED_POST_GATE_HANDOFF_EVENT, scheduledPostGateDigest,
  scheduledPostGateHandoffKey, scheduledPostGateOwner, type ScheduledPostGateHandoff, type ScheduledPostGateScheduleReceipt,
  parseScheduledPostGateExecuteTaskEnvelope, type ScheduledPostGateCompletionProof,
  type TaskGraphScheduledPostGatePlanReadInput,
} from "./scheduled-post-gate-contract.js"

type Row = Record<string, unknown>
const EXECUTE_CONSTRAINTS = ["Run the existing non-submitting Execute behavior for only the server-bound package partition.",
  "Never submit an application, send Gmail, contact an employer, or create child tasks."]
const AUDIT_CONSTRAINTS = ["Run only the existing scheduled Audit behavior after all Execute dependencies are terminal.",
  "Preserve the existing report semantics; never submit applications or send Gmail."]

/** Reads pre-plan proof or the immutable accepted handoff after restart. */
export async function readScheduledPostGatePlanningContext(client: Queryable,
  input: TaskGraphScheduledPostGatePlanReadInput): Promise<ScheduledPostGatePlanningContext> {
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [input.scope.userId])
  await lockTaskGraphScope(client, input.scope)
  const loaded = await loadTaskGraph(client, input.scope, true)
  if (!loaded.snapshot || !loaded.state || !loaded.item) return { status: "not_applicable" }
  const receipt = await readScheduledPostGateReceipt(client, input.scope)
  if (receipt) return await validateScheduledPostGateHandoff(client, input.scope, loaded, receipt)
    ? { status: "planned", receipt, graphRevision: loaded.state.revision } : { status: "invalid" }
  return awaitingPostGatePlan(client, input.scope, loaded)
}

/** Independently verifies terminal Execute/Audit lifecycle commits against the immutable handoff. */
export async function verifyScheduledPostGateCompletion(client: Queryable,
  input: TaskGraphScheduledPostGatePlanReadInput): Promise<ScheduledPostGateCompletionProof | null> {
  const scope = input.scope
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [scope.userId])
  await lockTaskGraphScope(client, scope)
  const loaded = await loadTaskGraph(client, scope, true), receipt = await readScheduledPostGateReceipt(client, scope)
  if (!receipt || !loaded.snapshot || !loaded.state || !await validateScheduledPostGateHandoff(client, scope, loaded, receipt)) return null
  const current = currentTaskGraph(loaded), execute = [] as Array<{ taskId: string; attemptCount: number; resultDigest: string; completedEventRevision: number }>
  for (const reference of receipt.executeNodes) {
    const node = loaded.snapshot.nodes.find(value => value.key === reference.key), task = loaded.tasks.get(reference.taskId)
    const currentNode = current.nodes.find(value => value.key === reference.key)
    const completion = task && Number.isSafeInteger(task.attemptCount) && task.attemptCount! > 0
      ? completionEvent(loaded.state.appliedEvents, scope.rootTaskId, reference.key, task.attemptCount!) : null
    if (!node || !task || !currentNode || currentNode.status !== "completed" || task.status !== "completed"
      || task.failureReason !== null || !completion
      || !parseScheduledPostGateExecuteTaskEnvelope(task.result, task.status, reference.packageRefs)) return null
    execute.push({ taskId: reference.taskId, attemptCount: task.attemptCount!, resultDigest: scheduledPostGateDigest(task.result),
      completedEventRevision: completion })
  }
  const auditNode = loaded.snapshot.nodes.find(value => value.key === SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID)
  const auditTask = loaded.tasks.get(receipt.auditTaskId), auditCurrent = current.nodes.find(value => value.key === SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID)
  const auditCompletion = auditTask && Number.isSafeInteger(auditTask.attemptCount) && auditTask.attemptCount! > 0
    ? completionEvent(loaded.state.appliedEvents, scope.rootTaskId, SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID, auditTask.attemptCount!) : null
  const report = auditTask && parseScheduledAuditTaskEnvelope(auditTask.result, auditTask.status)?.structuredResult
  if (!auditNode || auditNode.taskId !== receipt.auditTaskId || !auditTask || !auditCurrent || auditCurrent.status !== "completed"
    || auditTask.status !== "completed" || auditTask.failureReason !== null || !auditCompletion || !report
    || execute.some(item => item.completedEventRevision > auditCompletion)) return null
  return { schemaVersion: "agent-harness.v2.scheduled-post-gate-completion.v1", handoff: receipt,
    graphRevision: loaded.state.revision, execute, audit: { taskId: receipt.auditTaskId, attemptCount: auditTask.attemptCount!,
      resultDigest: scheduledPostGateDigest(auditTask.result), completedEventRevision: auditCompletion, report } }
}

/** Verifies Gate at R, then atomically appends and registers the exact agent.plan suffix at R+1. */
export async function appendScheduledPostGatePlan(client: Queryable,
  input: TaskGraphScheduledPostGatePlanInput): Promise<ScheduledPostGateScheduleReceipt> {
  const encodedProposal = JSON.stringify(input.proposal)
  if (!encodedProposal || Buffer.byteLength(encodedProposal, "utf8") > TASK_GRAPH_LIMITS.maxProposalBytes) throw invalid("proposal_too_large")
  const scope = input.scope
  const operation = input.operation
  if (operation.decision !== "revise" || operation.expectedRevision !== input.proposal.expectedRevision
    || canonicalTaskGraphJson(operation.scope) !== canonicalTaskGraphJson(scope)
    || operation.replaceUnstartedNodeKey !== undefined || operation.replaceBranch !== undefined || operation.replaceOperationalFailure !== undefined) {
    throw invalid("reconciliation_scope")
  }
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [scope.userId])
  const parent = await lockTaskGraphScope(client, scope, true)
  const loaded = await loadTaskGraph(client, scope, true)
  if (!loaded.snapshot || !loaded.state || !loaded.item) throw invalid("graph_missing")
  const existing = await readScheduledPostGateReceipt(client, scope)
  if (existing) {
    if (!await validateScheduledPostGateHandoff(client, scope, loaded, existing)) throw invalid("receipt_invalid")
    if (existing.proposalDigest !== scheduledPostGateDigest(input.proposal)) throw invalid("idempotency_conflict")
    return duplicateReceipt(loaded, existing)
  }
  const context = await awaitingPostGatePlan(client, scope, loaded)
  if (context.status !== "awaiting_plan") throw invalid("gate_proof")
  const plan = parseScheduledPostGatePlan(input.proposal, context.graphRevision, context.packageRefs)
  if (!plan || loaded.state.revision !== context.graphRevision) throw invalid("proposal")
  const preparedReconciliation = await prepareSteeringReconciliation(client, operation)
  const policy = policyFromTask({ budgetSnapshot: parent.budgetSnapshot } as Pick<SubagentTaskRecord, "budgetSnapshot">)
  if (input.proposal.nodes.length > policy.maxFanOut) throw invalid("fan_out")
  await requireContinuationBudget(client, scope)
  const append = appendScheduledPostGateTaskGraphProposal(loaded.state, input.proposal, {
    registeredTemplateIds: new Set([SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID, SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID]),
    maxNodes: TASK_GRAPH_LIMITS.maxPersistedNodes, maxDepth: TASK_GRAPH_LIMITS.maxDepth,
  })
  if (!append.ok || append.state.revision !== loaded.state.revision + 1 || append.addedNodes.length !== input.proposal.nodes.length) throw invalid("append")

  const taskIds = new Map(loaded.snapshot.nodes.map(node => [node.key, node.taskId] as const))
  const created: Array<{ key: string; taskId: string; status: "queued" | "waiting" }> = []
  const readyTaskIds: string[] = []
  for (const node of plan.executeNodes) {
    const child = await createSubagentTask(client, { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
      parentTaskId: scope.rootTaskId, role: SCHEDULED_POST_GATE_EXECUTE_ROLE, taskType: SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE,
      goal: node.goal, constraints: EXECUTE_CONSTRAINTS, successCriteria: node.successCriteria, allowedActions: [], context: {},
      expectedOutputSchema: SCHEDULED_POST_GATE_EXECUTE_OUTPUT_SCHEMA, policy: inheritSubagentPolicy(policy) }, true,
    { preserveEmptyAllowedActions: true, taskGraphChildDeadline: true })
    taskIds.set(node.key, child.id); created.push({ key: node.key, taskId: child.id, status: "queued" }); readyTaskIds.push(child.id)
    await enqueueGraphTask(client, scope.sessionId, child)
  }
  const auditNode = plan.auditNode
  const auditTask = await createSubagentTask(client, { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    parentTaskId: scope.rootTaskId, role: SCHEDULED_POST_GATE_AUDIT_ROLE, taskType: SCHEDULED_POST_GATE_AUDIT_TASK_TYPE,
    goal: auditNode.goal, constraints: AUDIT_CONSTRAINTS, successCriteria: SCHEDULED_POST_GATE_AUDIT_CRITERIA, allowedActions: [], context: {},
    expectedOutputSchema: SCHEDULED_POST_GATE_AUDIT_OUTPUT_SCHEMA, policy: inheritSubagentPolicy(policy) }, true,
  { preserveEmptyAllowedActions: true, taskGraphChildDeadline: true })
  const auditWaiting = await client.query(`UPDATE "sub_agent_tasks" SET "status" = 'waiting', "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "parentTaskId" = $4 AND "status" = 'queued'`,
  [auditTask.id, scope.sessionId, scope.turnId, scope.rootTaskId])
  if (auditWaiting.rowCount !== 1) throw invalid("audit_wait_state")
  taskIds.set(auditNode.key, auditTask.id); created.push({ key: auditNode.key, taskId: auditTask.id, status: "waiting" })
  const statuses = new Map(created.map(node => [node.key, node.status] as const))
  const state = { ...append.state, nodes: append.state.nodes.map(node => ({ ...node, status: statuses.get(node.key) ?? node.status })) }
  const snapshot = taskGraphSnapshot(state, taskIds, loaded.snapshot.rootSuccessCriteria)
  const receipt: ScheduledPostGateScheduleReceipt = { status: "accepted", revision: state.revision, nodes: created, readyTaskIds }
  const gateProof = context.gateProof, gateOwner = gateProof.prepareProof.receipt.owner
  const owner = scheduledPostGateOwner(scope, context.executionOwner, {
    rootAttemptCount: scope.parentAttemptCount, turnLeaseOwnerId: gateOwner.turnLeaseOwnerId, turnLeaseVersion: gateOwner.turnLeaseVersion,
  })
  const handoff: ScheduledPostGateHandoff = {
    schemaVersion: "agent-harness.v2.scheduled-post-gate-handoff.v1", owner,
    snapshotDigest: context.snapshotDigest, continuationKey: context.continuationKey,
    gateTaskId: gateProof.gate.taskId, gateAttemptCount: gateProof.gate.attemptCount,
    gateCompletedEventRevision: gateProof.gate.completedEventRevision, gateProofDigest: scheduledPostGateDigest(gateProof),
    gateProof, gateResultDigest: gateProof.gate.resultDigest, packageRefs: [...context.packageRefs],
    packageDigest: scheduledPostGateDigest(context.packageRefs), proposalDigest: scheduledPostGateDigest(input.proposal),
    gateGraphRevision: gateProof.graphRevision, graphRevision: state.revision,
    executeNodes: plan.executeNodes.map(node => ({ key: node.key, taskId: taskIds.get(node.key)!, packageRefs: [...node.packageRefs!] })),
    auditTaskId: auditTask.id,
  }
  await writePlanReceipt(client, { scope, state, snapshot, expectedRevision: loaded.state.revision,
    now: new Date(), idempotencyKey: taskGraphProposalKey(scope.rootTaskId, loaded.state.revision),
    fingerprint: taskGraphFingerprint(input.proposal), receipt })
  await appendTaskGraphReceipt(client, { scope, itemId: null, taskId: null, type: SCHEDULED_POST_GATE_HANDOFF_EVENT,
    idempotencyKey: scheduledPostGateHandoffKey({ ...owner, gateTaskId: handoff.gateTaskId, gateAttemptCount: handoff.gateAttemptCount }),
    payload: handoff, actor: "system", outbox: false })
  if (preparedReconciliation) await writeSteeringReconciliationReceipt(client, preparedReconciliation, state.revision)
  return receipt
}

async function awaitingPostGatePlan(client: Queryable, scope: TaskGraphReadScope,
  loaded: Awaited<ReturnType<typeof loadTaskGraph>>): Promise<ScheduledPostGatePlanningContext> {
  const legacyAudit = loaded.snapshot?.nodes.some(node => node.key === "scheduled_audit" || node.templateId === "scheduled_audit")
  if (legacyAudit || !loaded.snapshot || !loaded.state) return { status: "not_applicable" }
  const recovery = await readScheduledAuditGateContinuationContext(client, scope, loaded, loadPersistedScheduledPrepareProof)
  if (recovery.status !== "gate_continuation") return recovery.status === "invalid" ? { status: "invalid" } : { status: "not_applicable" }
  const gateNode = loaded.snapshot.nodes.find(node => node.key === "gate"), gateTask = gateNode && loaded.tasks.get(gateNode.taskId)
  if (!gateNode || !gateTask || gateTask.status !== "completed") return { status: "not_applicable" }
  const executionOwner = { executionId: recovery.handoff.executionId, executionAttemptCount: recovery.handoff.executionAttemptCount }
  const gateProof = await verifyPersistedScheduledGateCompletion(client, { scope, executionOwner, prepareProof: recovery.prepareProof })
  const preparedIds = scheduledGatePreparedJobIds(recovery.prepareProof)
  const envelope = preparedIds && parseScheduledGateTaskEnvelope(gateTask.result, gateTask.status, preparedIds)
  if (!gateProof || gateProof.graphRevision !== loaded.state.revision || !envelope || envelope.structuredResult.status !== "completed") return { status: "invalid" }
  return { status: "awaiting_plan", scope, executionOwner, gateProof, packageRefs: [...envelope.structuredResult.approvedJobIds],
    graphRevision: loaded.state.revision, continuationKey: recovery.handoff.continuationKey,
    snapshotDigest: recovery.prepareProof.receipt.snapshotDigest }
}

function duplicateReceipt(loaded: Awaited<ReturnType<typeof loadTaskGraph>>, handoff: ScheduledPostGateHandoff): ScheduledPostGateScheduleReceipt {
  if (!loaded.state) throw invalid("graph_missing")
  const current = currentTaskGraph(loaded), keys = [...handoff.executeNodes.map(node => node.key), SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID]
  const nodes = keys.map(key => {
    const node = current.nodes.find(value => value.key === key)
    if (!node?.taskId) throw invalid("replay")
    return { key, taskId: node.taskId, status: node.status }
  })
  const readyTaskIds = current.nodes.filter(node => keys.includes(node.key) && node.status === "queued" && node.readiness === "ready")
    .map(node => node.taskId!).filter(Boolean)
  return { status: "duplicate", revision: handoff.graphRevision, nodes, readyTaskIds }
}

async function requireContinuationBudget(client: Queryable, scope: TaskGraphScheduledPostGatePlanInput["scope"]): Promise<void> {
  try {
    await enforceRootStepBudget(client, { kind: "turn", taskId: scope.rootTaskId, rootTaskId: scope.rootTaskId,
      userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId }, 2)
  } catch (error: unknown) {
    if (error instanceof BudgetExceededError && error.metric === "steps") throw new TaskGraphCommandError(
      "task_graph_continuation_budget_required", "The Turn needs two remaining steps to supervise a TaskGraph plan")
    throw error
  }
}
function invalid(reason: string): TaskGraphCommandError { return new TaskGraphCommandError(`scheduled_post_gate_${reason}`, "Scheduled post-Gate proof or plan is invalid") }

function completionEvent(events: readonly { nodeKey: string; type: string; expectedRevision: number; idempotencyKey: string }[],
  rootTaskId: string, nodeKey: string, attemptCount: number): number | null {
  const matches = events.filter(event => event.nodeKey === nodeKey && event.type === "task.completed"
    && event.idempotencyKey === taskGraphLifecycleKey(rootTaskId, nodeKey, attemptCount, "task.completed"))
  if (matches.length !== 1) return null
  const revision = matches[0]!.expectedRevision + 1
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null
}
