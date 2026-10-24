import { reduceTaskGraphEvent, type TaskGraphState } from "../planning/task-graph.js"
import { parseTaskGraphBranchReplacement, validateTaskGraphBranchReplacement, type TaskGraphBranchReplacement } from "../planning/task-graph-branch-replacement.js"
import { TaskGraphCommandError, type TaskGraphScheduleInput, type TaskGraphScheduleReceipt } from "./task-graph-command-port.js"
import { createGraphTasks } from "./task-graph-pg-create.js"
import { writePlanReceiptWithIdentity, writeTaskLifecycleReceiptWithIdentity } from "./task-graph-pg-events.js"
import { loadTaskGraph, type GraphParent, type LoadedGraph } from "./task-graph-pg-state.js"
import { stampCreatedScoutEnvelopes, taskGraphSupersessionTemplateMatches } from "./task-graph-pg-supersession.js"
import { assertReplacementSnapshot, lockTaskGraphBranchSources, scheduleTaskGraphBranchRepair,
  type TaskGraphBranchSourceRow } from "./task-graph-pg-branch-repair.js"
import { deleteGraphDispatch } from "./task-graph-pg-lifecycle.js"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, taskGraphLifecycleKey, taskGraphProposalKey } from "./task-graph-snapshot.js"
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
  const selected = selectFailedBranchDescendants(validation.value.sourceNodes, branch.root)
  if (!selected || selected.descendants.length === 0 || validation.value.sourceNodes.length !== branch.sources.length) return invalid()
  const { failedRoot, descendants } = selected
  const sourceRows = await lockTaskGraphBranchSources(client, input, validation.value.sourceNodes)
  if (!eligibleFailedBranchSources(input, state, validation.value.sourceNodes, failedRoot, sourceRows)) return invalid()
  if (await hasPriorDescendantCancellation(client, input, descendants)) return invalid()
  const evidence = await proveTaskGraphFailedBranchEvidence(client, { scope: input.scope, snapshot: before, sourceNodes: validation.value.sourceNodes })
  if (!evidence) return invalid()
  const prepared = await prepareSteeringReconciliation(client, operation)
  if (!prepared || prepared.idempotencyKey !== key || prepared.decision !== "revise"
    || prepared.expectedRevision !== expectedRevision || prepared.resultingRevision !== expectedRevision + 1
    || prepared.inputThroughSequence < 0n) return invalid()
  if (expectedRevision > MAX_REVISION - descendants.length - 1) {
    throw new TaskGraphCommandError("revision_limit", "TaskGraph revision limit reached", expectedRevision)
  }
  await checkBudget()
  const retained = before.nodes.filter(node => !validation.value.sourceToReplacementKey.has(node.key))
  const sourceKeys = new Set(validation.value.sourceNodes.map(node => node.key))
  let cancelled = state
  const cancellationReceipts: Array<{ source: { nodeKey: string; taskId: string }; event: { id: string; sequence: string; idempotencyKey: string } }> = []
  const now = new Date()
  for (const [index, source] of descendants.entries()) {
    const row = sourceRows.get(source.taskId)!, expected = expectedRevision + index
    const idempotencyKey = taskGraphLifecycleKey(input.scope.rootTaskId, source.key, 0, "task.cancelled")
    const event = { type: "task.cancelled" as const, idempotencyKey, expectedRevision: expected, nodeKey: source.key }
    const reduced = reduceTaskGraphEvent(cancelled, event)
    if (!reduced.ok) return invalid()
    const updated = await client.query(`UPDATE "sub_agent_tasks" SET "status" = 'cancelled', "nextAttemptAt" = NULL, "completedAt" = $6, "updatedAt" = $6
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "parentTaskId" = $4
        AND "status" = $5 AND "attemptCount" = 0 AND "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL AND "nextAttemptAt" IS NULL
        AND "startedAt" IS NULL AND "completedAt" IS NULL AND "closedAt" IS NULL AND "interruptRequestedAt" IS NULL
        AND "failureReason" IS NULL AND "result" IS NULL AND "confidence" IS NULL AND "qualityGateResult" IS NULL
        AND "contextSnapshotId" IS NULL AND "outputArtifactIds" = '[]'::jsonb`,
    [source.taskId, input.scope.sessionId, input.scope.turnId, input.scope.rootTaskId, row.status, now])
    if (updated.rowCount !== 1) return invalid()
    await deleteGraphDispatch(client, input.scope.sessionId, source.taskId)
    const written = await writeTaskLifecycleReceiptWithIdentity(client, input.scope, item.id, source.taskId, event, expected, before, now)
    if (written.revision !== expected + 1) throw new Error("task_graph_revision_transition_mismatch")
    cancellationReceipts.push({ source: { nodeKey: source.key, taskId: source.taskId },
      event: { id: written.id, sequence: written.sequence, idempotencyKey } })
    cancelled = reduced.state
  }
  const planExpectedRevision = expectedRevision + descendants.length
  const working: TaskGraphState = { ...cancelled, nodes: cancelled.nodes.filter(node => !sourceKeys.has(node.key)),
    repairSatisfiedNodeKeys: cancelled.repairSatisfiedNodeKeys?.filter(key => !sourceKeys.has(key)),
    repairPendingNodeKeys: cancelled.repairPendingNodeKeys?.filter(key => !sourceKeys.has(key)) }
  const creationInput = { ...input, proposal: { ...input.proposal, expectedRevision: planExpectedRevision } }
  const created = await createGraphTasks(client, creationInput, parent, working, new Map(retained.map(node => [node.key, node.taskId])), loaded)
  const stamped = stampCreatedScoutEnvelopes(created.snapshot, created.created, input.templates)
  const nextSnapshot = rootCriteria ? parseTaskGraphSnapshot({ ...stamped, rootSuccessCriteria: rootCriteria }) : stamped
  assertReplacementSnapshot(before, nextSnapshot, validation.value.sourceNodes, validation.value.sourceToReplacementKey)
  const revision = planExpectedRevision + 1
  if (created.state.revision !== revision) throw new Error("task_graph_revision_transition_mismatch")
  const receipt: TaskGraphScheduleReceipt = { status: "accepted", revision, nodes: created.created, readyTaskIds: created.readyTaskIds }
  const proposalKey = taskGraphProposalKey(input.scope.rootTaskId, planExpectedRevision)
  const planEvent = await writePlanReceiptWithIdentity(client, { scope: input.scope, state: created.state, snapshot: nextSnapshot,
    expectedRevision: planExpectedRevision, now, idempotencyKey: proposalKey, fingerprint, receipt })
  const relation = parseTaskGraphFailedBranchRepairRelation({ schemaVersion: TASK_GRAPH_FAILED_BRANCH_REPAIR_RELATION_SCHEMA_VERSION,
    operationKey: key, graphRootTaskId: input.scope.rootTaskId, observedRevision: expectedRevision, resultingRevision: revision,
    branchRoot: branch.root, failedSource: evidence.failedSource,
    sources: validation.value.sourceNodes.map(source => ({ source: { nodeKey: source.key, taskId: source.taskId },
      replacementKey: validation.value.sourceToReplacementKey.get(source.key) })), cancellations: cancellationReceipts,
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
export function selectFailedBranchDescendants<T extends Readonly<{ key: string; taskId: string }>>(
  sources: readonly T[], root: Readonly<{ nodeKey: string; taskId: string }>,
): Readonly<{ failedRoot: T; descendants: readonly T[] }> | null {
  const roots = sources.filter(source => source.key === root.nodeKey && source.taskId === root.taskId)
  if (roots.length !== 1) return null
  const failedRoot = roots[0]!
  return { failedRoot, descendants: sources.filter(source => source.key !== failedRoot.key || source.taskId !== failedRoot.taskId) }
}
function eligibleFailedBranchSources(input: TaskGraphScheduleInput, state: TaskGraphState,
  sources: readonly Readonly<{ key: string; taskId: string; templateId: string }>[], failedRoot: Readonly<{ key: string; taskId: string }>,
  rows: ReadonlyMap<string, TaskGraphBranchSourceRow>): boolean {
  if (rows.size !== sources.length) return false
  for (const source of sources) {
    const row = rows.get(source.taskId), graphNode = state.nodes.find(node => node.key === source.key)
    if (!row || !graphNode || graphNode.taskId !== source.taskId || graphNode.status !== row.status
      || !taskGraphSupersessionTemplateMatches(row, input.templates[source.templateId])) return false
    if (source.key === failedRoot.key && source.taskId === failedRoot.taskId) {
      if (source.templateId !== "scout" || row.role !== "scout" || row.status !== "failed") return false
      continue
    }
    if ((row.status !== "queued" && row.status !== "waiting") || row.attemptCount !== 0
      || row.leaseOwner !== null || row.leaseExpiresAt !== null || row.nextAttemptAt !== null || row.startedAt !== null
      || row.completedAt !== null || row.closedAt !== null || row.interruptRequestedAt !== null || row.failureReason !== null
      || row.result !== null || row.confidence !== null || row.qualityGateResult !== null || row.contextSnapshotId !== null
      || !Array.isArray(row.outputArtifactIds) || row.outputArtifactIds.length !== 0 || row.hasExecutionEvidence !== false
      || row.hasCanonicalDispatch !== (row.status === "queued")) return false
  }
  return true
}
async function hasPriorDescendantCancellation(client: Client, input: TaskGraphScheduleInput,
  descendants: readonly Readonly<{ key: string }>[]): Promise<boolean> {
  const keys = descendants.map(node => taskGraphLifecycleKey(input.scope.rootTaskId, node.key, 0, "task.cancelled"))
  const result = await client.query<{ exists: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = ANY($2::text[])
    UNION ALL SELECT 1 FROM "agent_outbox" WHERE "aggregateId" = $1 AND "payload"->>'idempotencyKey' = ANY($2::text[])
  ) AS "exists"`, [input.scope.sessionId, keys])
  return result.rows[0]?.exists === true
}
function invalid(): never { throw new TaskGraphCommandError("task_graph_branch_repair_not_eligible", "The requested TaskGraph branch cannot be replaced") }
function conflict(): TaskGraphCommandError { return new TaskGraphCommandError("idempotency_conflict", "TaskGraph branch repair key was already used") }
