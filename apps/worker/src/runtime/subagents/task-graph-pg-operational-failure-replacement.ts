import type { PoolClient } from "pg"
import { reduceTaskGraphEvent, type TaskGraphState } from "../planning/task-graph.js"
import { parseTaskGraphOperationalFailureReplacement, validateTaskGraphOperationalFailureReplacement,
  type TaskGraphOperationalFailureReplacement } from "../planning/task-graph-operational-failure-replacement.js"
import { TaskGraphCommandError, type TaskGraphScheduleInput, type TaskGraphScheduleReceipt } from "./task-graph-command-port.js"
import { createGraphTasks } from "./task-graph-pg-create.js"
import { writePlanReceiptWithIdentity, writeTaskLifecycleReceiptWithIdentity } from "./task-graph-pg-events.js"
import { loadTaskGraph, type GraphParent } from "./task-graph-pg-state.js"
import { stampCreatedScoutEnvelopes, taskGraphSupersessionTemplateMatches } from "./task-graph-pg-supersession.js"
import { assertReplacementSnapshot, lockTaskGraphBranchSources, type TaskGraphBranchSourceRow } from "./task-graph-pg-branch-repair.js"
import { deleteGraphDispatch } from "./task-graph-pg-lifecycle.js"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, taskGraphItemId, taskGraphLifecycleKey, taskGraphProposalKey } from "./task-graph-snapshot.js"
import { actionList, type Queryable } from "./pg-store-persistence.js"
import { requireNormalizedRootPlanCriteria, requireOwnedRootPlanCriteria } from "./root-plan-criteria.js"
import { assertSteeringReconciliationCall } from "./steering-reconciliation-history.js"
import { steeringReconciliationIdempotencyKey, type SteeringReconciliationOperation } from "./steering-reconciliation-contract.js"
import { findSteeringReconciliationReplay, prepareSteeringReconciliation, writeSteeringReconciliationReceipt } from "./steering-reconciliation-ledger.js"
import { parseTaskGraphOperationalFailedBranchRelation, taskGraphOperationalFailedBranchFingerprint,
  TASK_GRAPH_OPERATIONAL_FAILED_BRANCH_RELATION_SCHEMA_VERSION } from "./task-graph-pg-operational-failed-branch-relation.js"
import { proveTaskGraphOperationalFailureEvidence } from "./task-graph-pg-operational-failure-evidence.js"
import { proveTaskGraphOperationalFailureCancellations } from "./task-graph-pg-operational-failure-cancellations.js"
import { proveTaskGraphOperationalObservedGraph } from "./task-graph-pg-operational-failure-observation.js"
import type { OperationalFailureCapacityReuse } from "./task-graph-pg-create-capacity.js"

type Client = Queryable
type Row = Record<string, unknown>
const MAX_REVISION = 2_147_483_646

export async function scheduleTaskGraphOperationalFailureReplacement(client: Client, input: TaskGraphScheduleInput, parent: GraphParent,
  operation: SteeringReconciliationOperation, checkBudget: () => Promise<void>): Promise<TaskGraphScheduleReceipt> {
  const replacement = sameReplacement(input.replaceOperationalFailure, operation.replaceOperationalFailure)
  if (!replacement || input.replaceBranch || operation.replaceBranch || input.replaceUnstarted || operation.replaceUnstartedNodeKey
    || operation.decision !== "revise" || !sameScope(input.scope, operation.scope)
    || operation.expectedRevision !== input.proposal.expectedRevision || !input.scope.stepId || input.scope.parentTaskId !== input.scope.rootTaskId) return invalid()
  const fingerprint = taskGraphOperationalFailedBranchFingerprint({ rootTaskId: input.scope.rootTaskId,
    expectedRevision: input.proposal.expectedRevision, replaceOperationalFailure: replacement, nodes: input.proposal.nodes,
    ...(input.rootSuccessCriteria === undefined ? {} : { rootSuccessCriteria: input.rootSuccessCriteria }) })
  let replay: TaskGraphScheduleReceipt | null
  try { replay = await findSteeringReconciliationReplay(client, { ...operation, replaceOperationalFailure: replacement }, fingerprint) }
  catch (error) { if (error instanceof Error && error.message === "steering_reconciliation_idempotency_conflict") throw conflict(); throw error }
  if (replay) return replay
  const operationKey = steeringReconciliationIdempotencyKey(operation.scope, operation.callId)
  if (!operationKey) return invalid()
  const planCallSequence = await assertSteeringReconciliationCall(client, operation.scope, operation.callId, "revise",
    operation.expectedRevision, undefined, replacement)
  if (planCallSequence === null) return invalid()
  const persisted = await loadTaskGraph(client, input.scope, true), current = persisted.state, before = persisted.snapshot
  if (!current || !before || !persisted.item || current.revision !== input.proposal.expectedRevision
    || persisted.item.revision !== input.proposal.expectedRevision) throw new TaskGraphCommandError("revision_mismatch", "TaskGraph revision is stale", current?.revision)
  if (parent.taskType !== "root" || parent.role !== "orchestrator" || !actionList(parent.allowedActions).includes("agent.plan")) return invalid()
  const normalizedCriteria = requireNormalizedRootPlanCriteria(input.rootSuccessCriteria), pinnedCriteria = before.rootSuccessCriteria
  const rootCriteria = normalizedCriteria !== undefined || pinnedCriteria !== undefined
    ? await requireOwnedRootPlanCriteria(client, input.scope, parent, pinnedCriteria, normalizedCriteria) : undefined
  const validation = validateTaskGraphOperationalFailureReplacement({ snapshot: before, replaceOperationalFailure: replacement,
    proposal: input.proposal, ...(normalizedCriteria === undefined ? {} : { proposedRootSuccessCriteria: normalizedCriteria }) })
  if (!validation.ok) {
    if (validation.code === "task_graph_dependency_unverified") throw new TaskGraphCommandError(validation.code, "Replacement depends on legacy-unverified work")
    return invalid()
  }
  const root = validation.value.sourceNodes.find(node => node.key === replacement.root.nodeKey && node.taskId === replacement.root.taskId)
  if (!root || validation.value.sourceNodes.length !== replacement.sources.length) return invalid()
  const rows = await lockTaskGraphBranchSources(client, input, validation.value.sourceNodes)
  if (!sourceRowsMatch(input, current, validation.value.sourceNodes, root, rows)) return invalid()
  const evidence = await proveTaskGraphOperationalFailureEvidence(client, { scope: input.scope, snapshot: before,
    sourceNodes: validation.value.sourceNodes, failedNode: root, failedRow: rows.get(root.taskId)! })
  if (!evidence || BigInt(planCallSequence) <= BigInt(evidence.failedSource.event.sequence)) return invalid()
  const observed = await proveTaskGraphOperationalObservedGraph(client, { scope: input.scope,
    observedRevision: current.revision, expectedSnapshot: before })
  if (!observed || BigInt(planCallSequence) <= BigInt(observed.event.sequence)) return invalid()
  const priorCancellations = await proveTaskGraphOperationalFailureCancellations(client, { scope: input.scope,
    failureGraph: evidence.failureGraph, failureSequence: evidence.failedSource.event.sequence, observedSequence: observed.event.sequence,
    sourceNodes: validation.value.sourceNodes, failedNode: root })
  if (!priorCancellations) return invalid()
  const priorCancellationIds = new Set(priorCancellations.map(value => value.source.taskId))
  const freshDescendantIds = validation.value.sourceNodes.filter(node => node.taskId !== root.taskId && !priorCancellationIds.has(node.taskId))
    .map(node => node.taskId)
  const nonWaitEvidenceFree = await readNonWaitEvidenceFreeIds(client, input, freshDescendantIds)
  if (!nonWaitEvidenceFree || !eligibleSources(input, current, validation.value.sourceNodes, root, rows,
    priorCancellationIds, nonWaitEvidenceFree)) return invalid()
  const prepared = await prepareSteeringReconciliation(client, { ...operation, replaceOperationalFailure: replacement })
  if (!prepared || prepared.decision !== "revise" || prepared.expectedRevision !== input.proposal.expectedRevision
    || prepared.idempotencyKey !== operationKey || prepared.resultingRevision !== input.proposal.expectedRevision + 1) return invalid()
  const descendants = validation.value.sourceNodes.filter(node => node.taskId !== root.taskId)
    .filter(node => !priorCancellationIds.has(node.taskId))
  const expectedRevision = input.proposal.expectedRevision
  if (expectedRevision > MAX_REVISION - descendants.length - 1) throw new TaskGraphCommandError("revision_limit", "TaskGraph revision limit reached", expectedRevision)
  await checkBudget()
  const cancellations: Array<{ source: { nodeKey: string; taskId: string }; event: { id: string; sequence: string; idempotencyKey: string } }> = []
  let cancelled = current
  const now = new Date()
  for (const [index, source] of descendants.entries()) {
    const row = rows.get(source.taskId)!, idempotencyKey = taskGraphLifecycleKey(input.scope.rootTaskId, source.key, 0, "task.cancelled")
    const event = { type: "task.cancelled" as const, idempotencyKey, expectedRevision: expectedRevision + index, nodeKey: source.key }
    const reduced = reduceTaskGraphEvent(cancelled, event)
    if (!reduced.ok) return invalid()
    const updated = await cancelPristineDescendant(client, input, source.taskId, row, now)
    if (updated !== 1) return invalid()
    await deleteGraphDispatch(client, input.scope.sessionId, source.taskId)
    const written = await writeTaskLifecycleReceiptWithIdentity(client, input.scope, persisted.item.id, source.taskId, event,
      expectedRevision + index, before, now)
    if (written.revision !== expectedRevision + index + 1) throw new Error("task_graph_revision_transition_mismatch")
    cancellations.push({ source: { nodeKey: source.key, taskId: source.taskId }, event: { id: written.id, sequence: written.sequence, idempotencyKey } })
    cancelled = reduced.state
  }
  const sourceKeys = new Set(validation.value.sourceNodes.map(node => node.key))
  const retained = before.nodes.filter(node => !sourceKeys.has(node.key))
  const working: TaskGraphState = { ...cancelled, nodes: cancelled.nodes.filter(node => !sourceKeys.has(node.key)),
    repairSatisfiedNodeKeys: cancelled.repairSatisfiedNodeKeys?.filter(key => !sourceKeys.has(key)),
    repairPendingNodeKeys: cancelled.repairPendingNodeKeys?.filter(key => !sourceKeys.has(key)) }
  const planRevision = expectedRevision + descendants.length
  const reuse: OperationalFailureCapacityReuse = { originalNodeCount: before.nodes.length, removedNodeCount: validation.value.sourceNodes.length }
  const created = await createGraphTasks(client, { ...input, proposal: { ...input.proposal, expectedRevision: planRevision } },
    parent, working, new Map(retained.map(node => [node.key, node.taskId])), persisted, reuse)
  const stamped = stampCreatedScoutEnvelopes(created.snapshot, created.created, input.templates)
  const snapshot = rootCriteria ? parseTaskGraphSnapshot({ ...stamped, rootSuccessCriteria: rootCriteria }) : stamped
  assertReplacementSnapshot(before, snapshot, validation.value.sourceNodes, validation.value.sourceToReplacementKey)
  const revision = planRevision + 1
  if (created.state.revision !== revision) throw new Error("task_graph_revision_transition_mismatch")
  const receipt: TaskGraphScheduleReceipt = { status: "accepted", revision, nodes: created.created, readyTaskIds: created.readyTaskIds }
  const proposalKey = taskGraphProposalKey(input.scope.rootTaskId, planRevision)
  if (await hasPriorPlan(client, input, proposalKey)) throw conflict()
  const planEvent = await writePlanReceiptWithIdentity(client, { scope: input.scope, state: created.state, snapshot,
    expectedRevision: planRevision, now, idempotencyKey: proposalKey, fingerprint, receipt })
  const relation = parseTaskGraphOperationalFailedBranchRelation({ schemaVersion: TASK_GRAPH_OPERATIONAL_FAILED_BRANCH_RELATION_SCHEMA_VERSION,
    operationKey, graphRootTaskId: input.scope.rootTaskId, observedRevision: expectedRevision, resultingRevision: revision,
    failedSource: evidence.failedSource, observedGraphEvent: observed.event,
    sources: validation.value.sourceNodes.map(source => ({ source: { nodeKey: source.key, taskId: source.taskId },
      replacementKey: validation.value.sourceToReplacementKey.get(source.key) })),
    priorCancellations: priorCancellations.map(({ source, event }) => ({ source, event })),
    cancellations: cancellations.map(({ source, event }) => ({ source, event })),
    verifiedExternalDependencies: evidence.verifiedExternalDependencies,
    planEvent: { ...planEvent, idempotencyKey: proposalKey }, requestFingerprint: fingerprint,
    agentPlanCall: { callId: operation.callId, stepId: input.scope.stepId, expectedRevision, replaceOperationalFailure: replacement } })
  if (!relation) throw new Error("task_graph_operational_failure_relation_invalid")
  await writeSteeringReconciliationReceipt(client, prepared, revision, undefined, undefined, undefined, relation)
  return receipt
}

function sourceRowsMatch(input: TaskGraphScheduleInput, state: TaskGraphState, sources: readonly Readonly<{ key: string; taskId: string; templateId: string }>[],
  root: Readonly<{ key: string; taskId: string; templateId: string }>, rows: ReadonlyMap<string, TaskGraphBranchSourceRow>): boolean {
  if (rows.size !== sources.length) return false
  for (const source of sources) {
    const row = rows.get(source.taskId), graphNode = state.nodes.find(node => node.key === source.key)
    if (!row || !graphNode || graphNode.taskId !== source.taskId || graphNode.status !== row.status
      || !taskGraphSupersessionTemplateMatches(row, input.templates[source.templateId])) return false
    if (source.taskId !== root.taskId && !["queued", "waiting", "cancelled"].includes(String(row.status))) return false
  }
  const failed = rows.get(root.taskId)
  return !!failed && failed.status === "failed"
}
function eligibleSources(input: TaskGraphScheduleInput, state: TaskGraphState, sources: readonly Readonly<{ key: string; taskId: string; templateId: string }>[],
  root: Readonly<{ key: string; taskId: string; templateId: string }>, rows: ReadonlyMap<string, TaskGraphBranchSourceRow>,
  priorCancellationIds: ReadonlySet<string>, nonWaitEvidenceFree: ReadonlySet<string>): boolean {
  if (!sourceRowsMatch(input, state, sources, root, rows)) return false
  for (const source of sources) {
    if (source.taskId === root.taskId || priorCancellationIds.has(source.taskId)) continue
    const row = rows.get(source.taskId)!
    if ((row.status !== "queued" && row.status !== "waiting") || row.attemptCount !== 0 || row.leaseOwner !== null
      || row.leaseExpiresAt !== null || row.nextAttemptAt !== null || row.startedAt !== null || row.completedAt !== null
      || row.closedAt !== null || row.interruptRequestedAt !== null || row.failureReason !== null || row.result !== null
      || row.confidence !== null || row.qualityGateResult !== null || row.contextSnapshotId !== null
      || !Array.isArray(row.outputArtifactIds) || row.outputArtifactIds.length !== 0
      || typeof row.hasExecutionEvidence !== "boolean" || !nonWaitEvidenceFree.has(source.taskId)
      || row.hasCanonicalDispatch !== (row.status === "queued")) return false
  }
  const cancelled = sources.filter(source => source.taskId !== root.taskId && rows.get(source.taskId)?.status === "cancelled")
  return cancelled.length === priorCancellationIds.size && cancelled.every(source => priorCancellationIds.has(source.taskId))
}
async function readNonWaitEvidenceFreeIds(client: Client, input: TaskGraphScheduleInput, taskIds: readonly string[]): Promise<ReadonlySet<string> | null> {
  if (!taskIds.length) return new Set()
  const result = await client.query<Row>(`SELECT task."id",
      (EXISTS (SELECT 1 FROM "sub_agent_tasks" child WHERE child."sessionId" = task."sessionId" AND child."parentTaskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_steps" row WHERE row."sessionId" = task."sessionId" AND row."taskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_items" row WHERE row."sessionId" = task."sessionId" AND row."taskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_events" row WHERE row."sessionId" = task."sessionId" AND row."taskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_tree_budget_reservations" row WHERE row."taskId" = task."id" OR row."rootTaskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_native_semantic_rejections" row WHERE row."rootTaskId" = task."id" OR row."controlTaskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_mailbox_messages" row WHERE row."fromTaskId" = task."id" OR row."toTaskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_mailbox_hydration_checkpoints" row WHERE row."rootTaskId" = task."id" OR row."taskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_tool_result_references" row WHERE row."taskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_transcript_events" row WHERE row."taskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_approvals" row WHERE row."taskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_artifact_version" row WHERE row."taskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_artifact_review" row WHERE row."taskId" = task."id")
      OR EXISTS (SELECT 1 FROM "application_tasks" row WHERE row."workerTaskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_outbox" row WHERE (row."payload"->>'taskId' = task."id" OR row."payload"->'payload'->>'taskId' = task."id")
        AND NOT (row."topic" = 'agent.subagent.dispatch' AND row."aggregateId" = task."sessionId"
          AND row."idempotencyKey" = 'subagent-dispatch:' || task."id" AND row."payload"->>'taskId' = task."id"
          AND row."payload"->>'sessionId' = task."sessionId" AND row."payload"->>'rootTaskId' = task."rootTaskId"))) AS "hasNonWaitEvidence"
    FROM "sub_agent_tasks" task JOIN "agent_sessions" session ON session."id" = task."sessionId"
    JOIN "agent_turns" turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $4 AND session."userId" = $5 AND turn."userId" = $5 ORDER BY task."id"`,
  [taskIds, input.scope.sessionId, input.scope.turnId, input.scope.rootTaskId, input.scope.userId])
  if (result.rows.length !== taskIds.length || result.rows.some(row => row.hasNonWaitEvidence !== false)) return null
  const ids = new Set(result.rows.map(row => String(row.id)))
  return ids.size === taskIds.length && taskIds.every(taskId => ids.has(taskId)) ? ids : null
}
async function cancelPristineDescendant(client: Client, input: TaskGraphScheduleInput, taskId: string, row: TaskGraphBranchSourceRow, now: Date): Promise<number | null> {
  const result = await client.query(`UPDATE "sub_agent_tasks" SET "status" = 'cancelled', "nextAttemptAt" = NULL, "completedAt" = $6, "updatedAt" = $6
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "parentTaskId" = $4
      AND "status" = $5 AND "attemptCount" = 0 AND "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL AND "nextAttemptAt" IS NULL
      AND "startedAt" IS NULL AND "completedAt" IS NULL AND "closedAt" IS NULL AND "interruptRequestedAt" IS NULL
      AND "failureReason" IS NULL AND "result" IS NULL AND "confidence" IS NULL AND "qualityGateResult" IS NULL
      AND "contextSnapshotId" IS NULL AND "outputArtifactIds" = '[]'::jsonb`,
  [taskId, input.scope.sessionId, input.scope.turnId, input.scope.rootTaskId, row.status, now])
  return result.rowCount
}
async function hasPriorPlan(client: Client, input: TaskGraphScheduleInput, key: string): Promise<boolean> {
  const result = await client.query(`SELECT EXISTS (SELECT 1 FROM "agent_events" AS event
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3 AND event."idempotencyKey" = $4
      AND session."userId" = $5 AND turn."userId" = $5) AS "exists"`,
  [input.scope.sessionId, input.scope.turnId, taskGraphItemId(input.scope.rootTaskId), key, input.scope.userId])
  return (result.rows[0] as Row | undefined)?.exists === true
}
function sameReplacement(left: TaskGraphOperationalFailureReplacement | undefined,
  right: TaskGraphOperationalFailureReplacement | undefined): TaskGraphOperationalFailureReplacement | null {
  if (!left || !right) return null
  const parsedLeft = parseOperational(left), parsedRight = parseOperational(right)
  return parsedLeft && parsedRight && canonicalTaskGraphJson(parsedLeft) === canonicalTaskGraphJson(parsedRight) ? parsedLeft : null
}
function parseOperational(value: unknown): TaskGraphOperationalFailureReplacement | null {
  const parsed = parseTaskGraphOperationalFailureReplacement(value)
  return parsed.ok ? parsed.value : null
}
function sameScope(left: TaskGraphScheduleInput["scope"], right: SteeringReconciliationOperation["scope"]): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId && left.turnId === right.turnId
    && left.rootTaskId === right.rootTaskId && left.parentTaskId === right.parentTaskId && left.stepId === right.stepId
    && left.turnLeaseOwner === right.turnLeaseOwner && left.turnLeaseVersion === right.turnLeaseVersion
    && left.parentLeaseOwner === right.parentLeaseOwner && left.parentAttemptCount === right.parentAttemptCount
}
function invalid(): never { throw new TaskGraphCommandError("task_graph_operational_failure_replacement_not_eligible", "The requested operational failure cannot be replaced") }
function conflict(): TaskGraphCommandError { return new TaskGraphCommandError("idempotency_conflict", "Operational failure replacement key was already used") }
