import { BudgetExceededError } from "../budget.js"
import { enforceRootStepBudget } from "../turns/turn-engine-root-budget.js"
import { TaskGraphCommandError, type TaskGraphReadScope, type TaskGraphScheduleInput, type TaskGraphScheduleReceipt } from "./task-graph-command-port.js"
import { createGraphTasks } from "./task-graph-pg-create.js"
import { scheduleTaskGraphBranchOperation } from "./task-graph-pg-failed-branch-repair.js"
import { scheduleTaskGraphOperationalFailureReplacement } from "./task-graph-pg-operational-failure-replacement.js"
import { writePlanReceipt } from "./task-graph-pg-events.js"
import { assertPlanningRootHasNoUnresolvedSteering } from "./pg-store-create.js"
import { lockTaskGraphScope, loadTaskGraph } from "./task-graph-pg-state.js"
import { prepareSteeringReconciliation, writeSteeringReconciliationReceipt } from "./steering-reconciliation-ledger.js"
import type { SteeringReconciliationOperation } from "./steering-reconciliation-contract.js"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, taskGraphFingerprint, taskGraphItemId, taskGraphProposalKey } from "./task-graph-snapshot.js"
import { stampCreatedScoutEnvelopes, scheduleTaskGraphSupersession, taskGraphSupersessionProposalKey } from "./task-graph-pg-supersession.js"
import { requireNormalizedRootPlanCriteria, requireOwnedRootPlanCriteria } from "./root-plan-criteria.js"
import { SCHEDULED_AUDIT_TEMPLATE_ID } from "./scheduled-audit-contract.js"
import { type Queryable } from "./pg-store-persistence.js"

const MAX_REVISION = 2_147_483_646
type Row = Record<string, unknown>

function sameExecutionScope(left: TaskGraphScheduleInput["scope"], right: SteeringReconciliationOperation["scope"]): boolean {
  return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right)
}

export async function scheduleTaskGraph(
  client: Queryable, input: TaskGraphScheduleInput, operation?: SteeringReconciliationOperation,
): Promise<TaskGraphScheduleReceipt> {
  rejectPrivateScheduledGate(input.proposal)
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [input.scope.userId])
  const parent = await lockTaskGraphScope(client, input.scope, true)
  if (operation && (operation.decision !== "revise" || !sameExecutionScope(input.scope, operation.scope))) {
    throw new TaskGraphCommandError("steering_reconciliation_operation_invalid", "Plan reconciliation scope is invalid")
  }
  if (input.replaceOperationalFailure || operation?.replaceOperationalFailure) {
    if (!operation) throw new TaskGraphCommandError("task_graph_operational_failure_replacement_not_eligible", "The replacement operation is incomplete")
    return scheduleTaskGraphOperationalFailureReplacement(client, input, parent, operation,
      () => requireTaskGraphContinuationBudget(client, input.scope))
  }
  if (input.replaceBranch || operation?.replaceBranch) {
    if (!operation) throw new TaskGraphCommandError("task_graph_branch_repair_not_eligible", "The branch replacement request is incomplete")
    return scheduleTaskGraphBranchOperation(client, input, parent, operation, () => requireTaskGraphContinuationBudget(client, input.scope))
  }
  if (operation && operation.expectedRevision !== input.proposal.expectedRevision) {
    throw new TaskGraphCommandError("steering_reconciliation_operation_invalid", "Plan reconciliation scope is invalid")
  }
  const rootSuccessCriteria = requireNormalizedRootPlanCriteria(input.rootSuccessCriteria)
  const loaded = await loadTaskGraph(client, input.scope, true, {
    includeSourceProvenance: !input.replaceUnstarted, currentStepId: input.scope.stepId,
    // TaskGraph is root-only, and TurnEngine records root Step attempts as 1.
    // parentAttemptCount belongs to the leased root task, not this Step.
    currentStepAttempt: 1,
  })
  const current = loaded.state, revision = current?.revision ?? 0
  const key = input.replaceUnstarted ? taskGraphSupersessionProposalKey(input.scope.parentTaskId, input.proposal.expectedRevision)
    : taskGraphProposalKey(input.scope.parentTaskId, input.proposal.expectedRevision)
  if (!input.replaceUnstarted) {
    const fingerprint = taskGraphFingerprint(rootSuccessCriteria === undefined ? input.proposal : { proposal: input.proposal, rootSuccessCriteria })
    const replay = await findPlanReplay(client, input, key, fingerprint, taskGraphItemId(input.scope.parentTaskId))
    if (replay) return replay
  }
  let pinnedCriteria = loaded.snapshot?.rootSuccessCriteria
  if (rootSuccessCriteria !== undefined || pinnedCriteria !== undefined) pinnedCriteria = await requireOwnedRootPlanCriteria(client, input.scope, parent, pinnedCriteria, rootSuccessCriteria)
  if (input.replaceUnstarted) return scheduleTaskGraphSupersession(client, input, parent, loaded, operation, key,
    (request, requestKey, digest, itemId, binding) => findPlanReplay(client, request, requestKey, digest, itemId, binding),
    () => requireTaskGraphContinuationBudget(client, input.scope), pinnedCriteria)
  const fingerprint = taskGraphFingerprint(rootSuccessCriteria === undefined ? input.proposal : { proposal: input.proposal, rootSuccessCriteria })
  const prepared = operation ? await prepareSteeringReconciliation(client, operation) : null
  if (!loaded.item && await hasPersistedPlanReceipt(client, input.scope)) throw new TaskGraphCommandError("task_graph_state_missing", "Persisted TaskGraph state is unavailable")
  if (!operation && input.scope.parentTaskId === input.scope.rootTaskId) {
    await assertPlanningRootHasNoUnresolvedSteering(client, parent.allowedActions, input.scope)
  }
  if (input.proposal.expectedRevision !== revision) throw new TaskGraphCommandError("revision_mismatch", "TaskGraph revision is stale", revision)
  if (revision >= MAX_REVISION) throw new TaskGraphCommandError("revision_limit", "TaskGraph revision limit reached", revision)
  await requireTaskGraphContinuationBudget(client, input.scope)
  const created = await createGraphTasks(client, input, parent, current ?? { revision: 0, nodes: [], appliedEvents: [] },
    new Map(loaded.snapshot?.nodes.map(node => [node.key, node.taskId]) ?? []), loaded)
  const stamped = stampCreatedScoutEnvelopes(created.snapshot, created.created, input.templates), snapshot = pinnedCriteria ? parseTaskGraphSnapshot({ ...stamped, rootSuccessCriteria: pinnedCriteria }) : stamped
  const receipt: TaskGraphScheduleReceipt = { status: "accepted", revision: created.state.revision, nodes: created.created, readyTaskIds: created.readyTaskIds }
  await writePlanReceipt(client, { scope: input.scope, state: created.state, snapshot, expectedRevision: revision,
    now: new Date(), idempotencyKey: key, fingerprint, receipt })
  if (prepared) await writeSteeringReconciliationReceipt(client, prepared, created.state.revision)
  return receipt
}

function rejectPrivateScheduledGate(proposal: TaskGraphScheduleInput["proposal"]): void {
  if (proposal.nodes.some(node => node.key === SCHEDULED_AUDIT_TEMPLATE_ID || node.templateId === SCHEDULED_AUDIT_TEMPLATE_ID)) {
    throw new TaskGraphCommandError("scheduled_audit_private", "The scheduled Audit is available only through its fixed server command")
  }
  if (proposal.nodes.some(node => node.key === "gate" || node.templateId === "gate")) {
    throw new TaskGraphCommandError("scheduled_gate_private", "The scheduled Gate is available only through its fixed server command")
  }
}

async function requireTaskGraphContinuationBudget(client: Queryable, scope: TaskGraphScheduleInput["scope"]): Promise<void> {
  try {
    await enforceRootStepBudget(client, { kind: "turn", taskId: scope.rootTaskId, rootTaskId: scope.rootTaskId,
      userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId }, 2)
  } catch (error) {
    if (error instanceof BudgetExceededError && error.metric === "steps") throw new TaskGraphCommandError("task_graph_continuation_budget_required", "The Turn needs two remaining steps to supervise a TaskGraph plan")
    throw error
  }
}

export async function hasPersistedPlanReceipt(client: Queryable, scope: TaskGraphReadScope): Promise<boolean> {
  const result = await client.query(`SELECT EXISTS (
    SELECT 1 FROM "agent_events" AS event
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3
      AND event."type" IN ('item.started', 'item.delta') AND event."payload"->>'kind' IN ('proposal', 'native_command')
      AND session."userId" = $4 AND turn."userId" = $4
  ) AS "exists"`, [scope.sessionId, scope.turnId, taskGraphItemId(scope.parentTaskId), scope.userId])
  return (result.rows[0] as Row | undefined)?.exists === true
}

async function findPlanReplay(client: Queryable, input: TaskGraphScheduleInput, key: string, fingerprint: string, itemId: string | null,
  supersession?: Readonly<{ operationKey: string; observedRevision: number }>): Promise<TaskGraphScheduleReceipt | null> {
  if (!itemId) return null
  const result = await client.query(`SELECT event."payload" FROM "agent_events" AS event
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3
      AND event."idempotencyKey" = $4 AND session."userId" = $5 AND turn."userId" = $5`,
  [input.scope.sessionId, input.scope.turnId, itemId, key, input.scope.userId])
  if (!result.rows[0]) return null
  const payload = object((result.rows[0] as Row).payload)
  if (payload?.kind !== "proposal" || payload.fingerprint !== fingerprint || supersession
    && (payload.operationKey !== supersession.operationKey || payload.observedRevision !== supersession.observedRevision
      || object(payload.receipt)?.revision !== supersession.observedRevision + 2 || payload.revision !== supersession.observedRevision + 2)) {
    throw new TaskGraphCommandError("idempotency_conflict", "TaskGraph proposal key was already used", undefined)
  }
  const receipt = parseReceipt(payload.receipt)
  if (!receipt) throw new Error("task_graph_receipt_invalid")
  return { ...receipt, status: "duplicate" }
}

function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : null
}

function parseReceipt(value: unknown): Omit<TaskGraphScheduleReceipt, "status"> | null {
  const row = object(value)
  if (!row || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || !Array.isArray(row.nodes) || !Array.isArray(row.readyTaskIds)) return null
  const nodes: Array<{ key: string; taskId: string; status: "queued" | "waiting" }> = []
  for (const value of row.nodes) {
    const node = object(value)
    if (!node || typeof node.key !== "string" || typeof node.taskId !== "string" || (node.status !== "queued" && node.status !== "waiting")) return null
    nodes.push({ key: node.key, taskId: node.taskId, status: node.status })
  }
  if (row.readyTaskIds.some(id => typeof id !== "string") || nodes.length === 0) return null
  return { revision: Number(row.revision), nodes, readyTaskIds: [...row.readyTaskIds] as string[] }
}
