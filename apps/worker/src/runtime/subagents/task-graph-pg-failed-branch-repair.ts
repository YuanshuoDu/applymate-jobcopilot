import { parseTaskGraphBranchReplacement, validateTaskGraphBranchReplacement, type TaskGraphBranchReplacement } from "../planning/task-graph-branch-replacement.js"
import type { TaskGraphState } from "../planning/task-graph.js"
import { TaskGraphCommandError, type TaskGraphScheduleInput, type TaskGraphScheduleReceipt } from "./task-graph-command-port.js"
import { createGraphTasks } from "./task-graph-pg-create.js"
import { writePlanReceiptWithIdentity } from "./task-graph-pg-events.js"
import { loadTaskGraph, type GraphParent, type LoadedGraph } from "./task-graph-pg-state.js"
import { stampCreatedScoutEnvelopes, taskGraphSupersessionTemplateMatches } from "./task-graph-pg-supersession.js"
import { assertReplacementSnapshot, scheduleTaskGraphBranchRepair } from "./task-graph-pg-branch-repair.js"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, taskGraphProposalKey,
  type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { actionList, type Queryable } from "./pg-store-persistence.js"
import { requireNormalizedRootPlanCriteria, requireOwnedRootPlanCriteria } from "./root-plan-criteria.js"
import { assertTaskGraphBranchRepairToolCall } from "./steering-reconciliation-branch-repair-history.js"
import { steeringReconciliationIdempotencyKey, type SteeringReconciliationOperation } from "./steering-reconciliation-contract.js"
import { findSteeringReconciliationReplay, prepareSteeringReconciliation, writeSteeringReconciliationReceipt } from "./steering-reconciliation-ledger.js"
import { taskGraphBranchRepairFingerprint } from "./task-graph-pg-branch-repair-relation.js"
import { proveTaskGraphFailedBranchEvidence } from "./task-graph-pg-failed-branch-evidence.js"
import { parseTaskGraphFailedBranchRepairRelation, TASK_GRAPH_FAILED_BRANCH_REPAIR_RELATION_SCHEMA_VERSION } from "./task-graph-pg-failed-branch-relation.js"

type Client = Queryable
const MAX_REVISION = 2_147_483_646

/** Replays either strict history format before inspecting the live graph, then selects its current-source path. */
export async function scheduleTaskGraphBranchOperation(client: Client, input: TaskGraphScheduleInput, parent: GraphParent,
  operation: SteeringReconciliationOperation, checkBudget: () => Promise<void>): Promise<TaskGraphScheduleReceipt> {
  const requestBranch = input.replaceBranch ?? operation.replaceBranch
  if (!requestBranch) return invalid()
  const fingerprint = taskGraphBranchRepairFingerprint({ expectedRevision: input.proposal.expectedRevision, replaceBranch: requestBranch,
    nodes: input.proposal.nodes, ...(input.rootSuccessCriteria === undefined ? {} : { rootSuccessCriteria: input.rootSuccessCriteria }) })
  let replay: TaskGraphScheduleReceipt | null
  try { replay = await findSteeringReconciliationReplay(client, { ...operation, replaceBranch: requestBranch }, fingerprint) }
  catch (error) {
    if (error instanceof Error && error.message === "steering_reconciliation_idempotency_conflict") throw conflict()
    throw error
  }
  if (replay) {
    if (!sameBranch(input.replaceBranch, operation.replaceBranch)) throw conflict()
    return replay
  }
  const branch = sameBranch(input.replaceBranch, operation.replaceBranch)
  if (operation.expectedRevision !== input.proposal.expectedRevision) throw conflict()
  if (!branch || operation.decision !== "revise"
    || input.replaceUnstarted || operation.replaceUnstartedNodeKey) return invalid()
  const loaded = await loadTaskGraph(client, input.scope, true)
  if (loaded.tasks.get(branch.root.taskId)?.status === "failed") {
    return scheduleFailedBranchRepair(client, input, parent, operation, branch, fingerprint, loaded, checkBudget)
  }
  return scheduleTaskGraphBranchRepair(client, input, parent, operation, checkBudget)
}

async function scheduleFailedBranchRepair(client: Client, input: TaskGraphScheduleInput, parent: GraphParent,
  operation: SteeringReconciliationOperation, branch: TaskGraphBranchReplacement, fingerprint: string, loaded: LoadedGraph,
  checkBudget: () => Promise<void>): Promise<TaskGraphScheduleReceipt> {
  const key = steeringReconciliationIdempotencyKey(operation.scope, operation.callId)
  if (!key || input.scope.parentTaskId !== input.scope.rootTaskId || !input.scope.stepId || parent.taskType !== "root"
    || parent.role !== "orchestrator" || !actionList(parent.allowedActions).includes("agent.plan")) return invalid()
  const persisted = await assertTaskGraphBranchRepairToolCall(client, operation.scope, operation.callId, operation.expectedRevision, branch)
    .catch(error => { if (error instanceof Error && error.message === "steering_reconciliation_branch_repair_event_invalid") throw conflict(); throw error })
  if (persisted.fingerprint !== fingerprint) throw conflict()
  const { state, snapshot: before, item } = loaded, expectedRevision = input.proposal.expectedRevision
  if (!state || !before || !item) return invalid()
  if (state.revision !== expectedRevision || item.revision !== expectedRevision) {
    throw new TaskGraphCommandError("revision_mismatch", "TaskGraph revision is stale", state.revision)
  }
  if (expectedRevision >= MAX_REVISION) throw new TaskGraphCommandError("revision_limit", "TaskGraph revision limit reached", expectedRevision)
  const normalizedCriteria = requireNormalizedRootPlanCriteria(input.rootSuccessCriteria)
  const pinnedCriteria = before.rootSuccessCriteria
  const rootCriteria = normalizedCriteria !== undefined || pinnedCriteria !== undefined
    ? await requireOwnedRootPlanCriteria(client, input.scope, parent, pinnedCriteria, normalizedCriteria) : undefined
  const validation = validateTaskGraphBranchReplacement({ snapshot: before, replaceBranch: branch, proposal: input.proposal,
    ...(normalizedCriteria === undefined ? {} : { proposedRootSuccessCriteria: normalizedCriteria }) })
  if (!validation.ok) {
    if (validation.code === "task_graph_dependency_unverified") throw new TaskGraphCommandError(validation.code, "Replacement depends on legacy-unverified work")
    return invalid()
  }
  const evidence = await proveTaskGraphFailedBranchEvidence(client, { scope: input.scope, snapshot: before, sourceNodes: validation.value.sourceNodes })
  if (!evidence) return invalid()
  if (!await sourceTemplatesMatch(client, input, validation.value.sourceNodes)) return invalid()
  const prepared = await prepareSteeringReconciliation(client, operation)
  if (!prepared || prepared.idempotencyKey !== key || prepared.decision !== "revise"
    || prepared.expectedRevision !== expectedRevision || prepared.resultingRevision !== expectedRevision + 1
    || prepared.inputThroughSequence < 0n) return invalid()
  await checkBudget()
  const retained = before.nodes.filter(node => !validation.value.sourceToReplacementKey.has(node.key))
  const sourceKeys = new Set(validation.value.sourceNodes.map(node => node.key))
  const working: TaskGraphState = { ...state, nodes: state.nodes.filter(node => !sourceKeys.has(node.key)),
    repairSatisfiedNodeKeys: state.repairSatisfiedNodeKeys?.filter(key => !sourceKeys.has(key)),
    repairPendingNodeKeys: state.repairPendingNodeKeys?.filter(key => !sourceKeys.has(key)) }
  const created = await createGraphTasks(client, input, parent, working, new Map(retained.map(node => [node.key, node.taskId])), loaded)
  const stamped = stampCreatedScoutEnvelopes(created.snapshot, created.created, input.templates)
  const nextSnapshot = rootCriteria ? parseTaskGraphSnapshot({ ...stamped, rootSuccessCriteria: rootCriteria }) : stamped
  assertReplacementSnapshot(before, nextSnapshot, validation.value.sourceNodes, validation.value.sourceToReplacementKey)
  const revision = expectedRevision + 1
  if (created.state.revision !== revision) throw new Error("task_graph_revision_transition_mismatch")
  const receipt: TaskGraphScheduleReceipt = { status: "accepted", revision, nodes: created.created, readyTaskIds: created.readyTaskIds }
  const proposalKey = taskGraphProposalKey(input.scope.rootTaskId, expectedRevision)
  const planEvent = await writePlanReceiptWithIdentity(client, { scope: input.scope, state: created.state, snapshot: nextSnapshot,
    expectedRevision, now: new Date(), idempotencyKey: proposalKey, fingerprint, receipt })
  const relation = parseTaskGraphFailedBranchRepairRelation({ schemaVersion: TASK_GRAPH_FAILED_BRANCH_REPAIR_RELATION_SCHEMA_VERSION,
    operationKey: key, graphRootTaskId: input.scope.rootTaskId, observedRevision: expectedRevision, resultingRevision: revision,
    branchRoot: branch.root, failedSource: evidence.failedSource,
    sources: validation.value.sourceNodes.map(source => ({ source: { nodeKey: source.key, taskId: source.taskId },
      replacementKey: validation.value.sourceToReplacementKey.get(source.key) })), cancellations: evidence.cancellations,
    verifiedExternalDependencies: evidence.verifiedExternalDependencies,
    planEvent: { ...planEvent, idempotencyKey: proposalKey }, requestFingerprint: fingerprint,
    agentPlanCall: { callId: operation.callId, stepId: input.scope.stepId, expectedRevision, replaceBranch: branch } })
  if (!relation) throw new Error("task_graph_failed_branch_repair_relation_invalid")
  await writeSteeringReconciliationReceipt(client, prepared, revision, undefined, undefined, relation)
  return receipt
}

function sameBranch(left: TaskGraphBranchReplacement | undefined, right: TaskGraphBranchReplacement | undefined): TaskGraphBranchReplacement | null {
  if (!left || !right) return null
  const parsedLeft = parseTaskGraphBranchReplacement(left), parsedRight = parseTaskGraphBranchReplacement(right)
  return parsedLeft.ok && parsedRight.ok && canonicalTaskGraphJson(parsedLeft.value) === canonicalTaskGraphJson(parsedRight.value) ? parsedLeft.value : null
}
async function sourceTemplatesMatch(client: Client, input: TaskGraphScheduleInput,
  sources: readonly Readonly<{ taskId: string; templateId: string }>[]): Promise<boolean> {
  const result = await client.query<Record<string, unknown>>(`SELECT task."id", task."role", task."taskType", task."constraints",
      task."allowedActions", task."expectedOutputSchema"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $4 AND session."userId" = $5 AND turn."userId" = $5
    ORDER BY task."id" FOR UPDATE OF task`, [sources.map(source => source.taskId), input.scope.sessionId,
    input.scope.turnId, input.scope.rootTaskId, input.scope.userId])
  const rows = new Map(result.rows.map(row => [String(row.id), row]))
  return rows.size === sources.length && sources.every(source => {
    const row = rows.get(source.taskId)
    return row && taskGraphSupersessionTemplateMatches(row, input.templates[source.templateId])
  })
}
function invalid(): never { throw new TaskGraphCommandError("task_graph_branch_repair_not_eligible", "The requested TaskGraph branch cannot be replaced") }
function conflict(): TaskGraphCommandError { return new TaskGraphCommandError("idempotency_conflict", "TaskGraph branch repair key was already used") }
