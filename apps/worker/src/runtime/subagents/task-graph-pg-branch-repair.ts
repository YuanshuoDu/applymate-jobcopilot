import { reduceTaskGraphEvent } from "../planning/task-graph.js"
import { parseTaskGraphBranchReplacement, validateTaskGraphBranchReplacement, type TaskGraphBranchReplacement } from "../planning/task-graph-branch-replacement.js"
import { TaskGraphCommandError, type TaskGraphScheduleInput, type TaskGraphScheduleReceipt } from "./task-graph-command-port.js"
import { createGraphTasks } from "./task-graph-pg-create.js"
import { writePlanReceiptWithIdentity, writeTaskLifecycleReceiptWithIdentity } from "./task-graph-pg-events.js"
import { loadTaskGraph, type GraphParent } from "./task-graph-pg-state.js"
import { stampCreatedScoutEnvelopes, taskGraphSupersessionTemplateMatches } from "./task-graph-pg-supersession.js"
import { deleteGraphDispatch } from "./task-graph-pg-lifecycle.js"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, taskGraphItemId, taskGraphLifecycleKey, taskGraphProposalKey,
  type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { actionList, type Queryable } from "./pg-store-persistence.js"
import { requireNormalizedRootPlanCriteria, requireOwnedRootPlanCriteria } from "./root-plan-criteria.js"
import { assertTaskGraphBranchRepairCall, assertTaskGraphBranchRepairHistory, assertTaskGraphBranchRepairToolCall } from "./steering-reconciliation-branch-repair-history.js"
import { parseSteeringReconciliationReceipt, steeringReconciliationIdempotencyKey, steeringReconciliationSequence,
  STEERING_RECONCILIATION_EVENT_TYPE, type SteeringReconciliationOperation } from "./steering-reconciliation-contract.js"
import { prepareSteeringReconciliation, writeSteeringReconciliationReceipt } from "./steering-reconciliation-ledger.js"
import { parseTaskGraphBranchRepairRelation, TASK_GRAPH_BRANCH_REPAIR_RELATION_SCHEMA_VERSION,
  taskGraphBranchRepairFingerprint } from "./task-graph-pg-branch-repair-relation.js"

export type TaskGraphBranchSourceRow = Record<string, unknown>
type Row = TaskGraphBranchSourceRow
type Client = Queryable
const MAX_REVISION = 2_147_483_646

export async function scheduleTaskGraphBranchRepair(client: Client, input: TaskGraphScheduleInput, parent: GraphParent,
  operation: SteeringReconciliationOperation, checkBudget: () => Promise<void>): Promise<TaskGraphScheduleReceipt> {
  const opKey = steeringReconciliationIdempotencyKey(operation.scope, operation.callId)
  if (!opKey) return invalid()
  const existingReplay = await replayTaskGraphBranchRepairIfPresent(client, input, operation)
  if (existingReplay) return existingReplay

  const branch = sameBranch(input.replaceBranch, operation.replaceBranch)
  if (!branch || !sameScope(input.scope, operation.scope) || operation.decision !== "revise"
    || operation.expectedRevision !== input.proposal.expectedRevision || input.replaceUnstarted || operation.replaceUnstartedNodeKey
    || input.scope.parentTaskId !== input.scope.rootTaskId || !input.scope.stepId) return invalid()
  const fingerprint = taskGraphBranchRepairFingerprint({ expectedRevision: input.proposal.expectedRevision, replaceBranch: branch,
    nodes: input.proposal.nodes, ...(input.rootSuccessCriteria === undefined ? {} : { rootSuccessCriteria: input.rootSuccessCriteria }) })
  const persisted = await assertTaskGraphBranchRepairToolCall(client, operation.scope, operation.callId, operation.expectedRevision, branch)
    .catch(error => { if (error instanceof Error && error.message === "steering_reconciliation_branch_repair_event_invalid") return invalid(); throw error })
  if (persisted.fingerprint !== fingerprint) return invalid()
  const proposalKey = taskGraphProposalKey(input.scope.rootTaskId, input.proposal.expectedRevision + branch.sources.length)
  if (await hasPriorPlan(client, input.scope, proposalKey)) throw conflict()

  const prepared = await prepareSteeringReconciliation(client, operation)
  if (!prepared || prepared.decision !== "revise" || prepared.expectedRevision !== input.proposal.expectedRevision
    || prepared.idempotencyKey !== opKey || prepared.inputThroughSequence < 0n) return invalid()
  const expectedRevision = input.proposal.expectedRevision
  if (prepared.resultingRevision !== expectedRevision + 1 || expectedRevision >= MAX_REVISION) return invalid()
  const normalizedCriteria = requireNormalizedRootPlanCriteria(input.rootSuccessCriteria)
  const loaded = await loadTaskGraph(client, input.scope, true)
  const current = loaded.state, before = loaded.snapshot
  if (!loaded.item || !current || !before || current.revision !== expectedRevision || loaded.item.revision !== expectedRevision) {
    throw new TaskGraphCommandError("revision_mismatch", "TaskGraph revision is stale", current?.revision)
  }
  if (parent.taskType !== "root" || parent.role !== "orchestrator" || !actionList(parent.allowedActions).includes("agent.plan")) return invalid()
  const pinned = before.rootSuccessCriteria
  const rootCriteria = normalizedCriteria !== undefined || pinned !== undefined
    ? await requireOwnedRootPlanCriteria(client, input.scope, parent, pinned, normalizedCriteria) : undefined
  const validation = validateTaskGraphBranchReplacement({ snapshot: before, replaceBranch: branch, proposal: input.proposal,
    ...(normalizedCriteria === undefined ? {} : { proposedRootSuccessCriteria: normalizedCriteria }) })
  if (!validation.ok) {
    if (validation.code === "task_graph_dependency_unverified") throw new TaskGraphCommandError(validation.code, "Replacement depends on legacy-unverified work")
    return invalid()
  }
  if (validation.value.sourceNodes.length !== branch.sources.length) return invalid()
  if (expectedRevision > MAX_REVISION - validation.value.sourceNodes.length - 1) return invalid()
  const statusRows = await lockTaskGraphBranchSources(client, input, validation.value.sourceNodes)
  for (const source of validation.value.sourceNodes) {
    const row = statusRows.get(source.taskId), graphNode = current.nodes.find(node => node.key === source.key)
    if (!row || !graphNode || graphNode.taskId !== source.taskId || graphNode.status !== row.status
      || (row.status !== "queued" && row.status !== "waiting") || row.attemptCount !== 0
      || row.leaseOwner !== null || row.leaseExpiresAt !== null || row.nextAttemptAt !== null || row.startedAt !== null
      || row.completedAt !== null || row.closedAt !== null || row.interruptRequestedAt !== null || row.failureReason !== null
      || row.result !== null || row.confidence !== null || row.qualityGateResult !== null || row.contextSnapshotId !== null
      || !Array.isArray(row.outputArtifactIds) || row.outputArtifactIds.length !== 0 || row.hasExecutionEvidence !== false
      || row.hasCanonicalDispatch !== (row.status === "queued") || !taskGraphSupersessionTemplateMatches(row, input.templates[source.templateId])) return invalid()
  }
  const retained = before.nodes.filter(node => !validation.value.sourceToReplacementKey.has(node.key))
  const now = new Date(), identity = validation.value.sourceNodes.map(node => ({ nodeKey: node.key, taskId: node.taskId }))
  await checkBudget()
  let cancelled = current
  const cancellationEvents: Array<{ id: string; sequence: string }> = []
  for (const [index, source] of validation.value.sourceNodes.entries()) {
    const row = statusRows.get(source.taskId)!, lifecycleKey = taskGraphLifecycleKey(input.scope.rootTaskId, source.key, 0, "task.cancelled")
    const event = { type: "task.cancelled" as const, idempotencyKey: lifecycleKey, expectedRevision: expectedRevision + index, nodeKey: source.key }
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
    const written = await writeTaskLifecycleReceiptWithIdentity(client, input.scope, loaded.item.id, source.taskId, event,
      expectedRevision + index, before, now)
    if (written.revision !== expectedRevision + index + 1) throw new Error("task_graph_revision_transition_mismatch")
    cancellationEvents.push({ id: written.id, sequence: written.sequence })
    cancelled = reduced.state
  }
  const sourceKeys = new Set(identity.map(item => item.nodeKey))
  const working = { ...cancelled, nodes: cancelled.nodes.filter(node => !sourceKeys.has(node.key)),
    repairSatisfiedNodeKeys: cancelled.repairSatisfiedNodeKeys?.filter(key => !sourceKeys.has(key)),
    repairPendingNodeKeys: cancelled.repairPendingNodeKeys?.filter(key => !sourceKeys.has(key)) }
  const priorIds = new Map(retained.map(node => [node.key, node.taskId] as const))
  const created = await createGraphTasks(client, { ...input, proposal: { ...input.proposal, expectedRevision: expectedRevision + identity.length } },
    parent, working, priorIds, loaded)
  const stamped = stampCreatedScoutEnvelopes(created.snapshot, created.created, input.templates)
  const snapshot = rootCriteria ? parseTaskGraphSnapshot({ ...stamped, rootSuccessCriteria: rootCriteria }) : stamped
  assertReplacementSnapshot(before, snapshot, validation.value.sourceNodes, validation.value.sourceToReplacementKey)
  const revision = expectedRevision + identity.length + 1
  if (created.state.revision !== revision) throw new Error("task_graph_revision_transition_mismatch")
  const receipt: TaskGraphScheduleReceipt = { status: "accepted", revision, nodes: created.created, readyTaskIds: created.readyTaskIds }
  const planEvent = await writePlanReceiptWithIdentity(client, { scope: input.scope, state: created.state, snapshot,
    expectedRevision: revision - 1, now, idempotencyKey: proposalKey, fingerprint, receipt })
  const relation = parseTaskGraphBranchRepairRelation({ schemaVersion: TASK_GRAPH_BRANCH_REPAIR_RELATION_SCHEMA_VERSION,
    operationKey: opKey, graphRootTaskId: input.scope.rootTaskId, observedRevision: expectedRevision, resultingRevision: revision,
    root: branch.root, sources: validation.value.sourceNodes.map((source, index) => ({ source: { nodeKey: source.key, taskId: source.taskId },
      replacementKey: validation.value.sourceToReplacementKey.get(source.key), cancellationEvent: cancellationEvents[index] })),
    planEvent: { ...planEvent, idempotencyKey: proposalKey }, replacementFingerprint: fingerprint,
    agentPlanCall: { callId: operation.callId, stepId: input.scope.stepId, expectedRevision, replaceBranch: branch } })
  if (!relation) throw new Error("task_graph_branch_repair_relation_invalid")
  await assertTaskGraphBranchRepairCall(client, operation.scope, relation, fingerprint)
  await writeSteeringReconciliationReceipt(client, prepared, revision, undefined, relation)
  return receipt
}

/** Replay a persisted v3 branch receipt without loading or validating the current graph. */
export async function replayTaskGraphBranchRepairIfPresent(client: Client, input: TaskGraphScheduleInput,
  operation: SteeringReconciliationOperation): Promise<TaskGraphScheduleReceipt | null> {
  const key = steeringReconciliationIdempotencyKey(operation.scope, operation.callId)
  if (!key) return invalid()
  const row = await readReceipt(client, operation.scope.sessionId, operation.scope.userId, key)
  return row ? replay(client, input, operation, key, row) : null
}

async function replay(client: Client, input: TaskGraphScheduleInput, operation: SteeringReconciliationOperation, key: string, row: Row): Promise<TaskGraphScheduleReceipt> {
  const seq = steeringReconciliationSequence(row.sequence), receipt = parseSteeringReconciliationReceipt(row.payload, operation.scope)
  const relation = receipt?.branchRepair
  if (!seq || !receipt || !relation || row.turnId !== operation.scope.turnId || row.itemId !== null || row.taskId !== operation.scope.rootTaskId
    || row.type !== STEERING_RECONCILIATION_EVENT_TYPE || row.actor !== "orchestrator" || row.correlationId !== operation.scope.turnId
    || row.causationId !== operation.scope.stepId || row.idempotencyKey !== key || row.hasOutbox !== false
    || receipt.decision !== "revise" || receipt.stepId !== operation.scope.stepId || receipt.observedRevision !== operation.expectedRevision
    || relation.operationKey !== key || relation.agentPlanCall.callId !== operation.callId
    || relation.agentPlanCall.stepId !== operation.scope.stepId || operation.replaceBranch === undefined || input.replaceBranch === undefined
    || canonicalTaskGraphJson(operation.replaceBranch) !== canonicalTaskGraphJson(relation.agentPlanCall.replaceBranch)
    || canonicalTaskGraphJson(input.replaceBranch) !== canonicalTaskGraphJson(relation.agentPlanCall.replaceBranch)) throw conflict()
  const fingerprint = taskGraphBranchRepairFingerprint({ expectedRevision: input.proposal.expectedRevision,
    replaceBranch: relation.agentPlanCall.replaceBranch, nodes: input.proposal.nodes,
    ...(input.rootSuccessCriteria === undefined ? {} : { rootSuccessCriteria: input.rootSuccessCriteria }) })
  if (fingerprint !== relation.replacementFingerprint || input.proposal.expectedRevision !== relation.observedRevision
    || !sameScope(input.scope, operation.scope) || operation.decision !== "revise" || operation.expectedRevision !== relation.observedRevision) throw conflict()
  await assertTaskGraphBranchRepairCall(client, operation.scope, relation, fingerprint).catch(() => { throw conflict() })
  const original = await assertTaskGraphBranchRepairHistory(client, operation.scope, relation,
    { id: String(row.id), sequence: seq, stepId: receipt.stepId, idempotencyKey: String(row.idempotencyKey) }).catch(() => { throw conflict() })
  return { ...original, status: "duplicate" }
}

async function readReceipt(client: Client, sessionId: string, userId: string, key: string): Promise<Row | null> {
  const result = await client.query<Row>(`SELECT event."id", event."sequence", event."turnId", event."itemId", event."taskId", event."type", event."actor",
      event."correlationId", event."causationId", event."idempotencyKey", event."payload",
      EXISTS (SELECT 1 FROM "agent_outbox" AS outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id") AS "hasOutbox"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."idempotencyKey" = $2 AND session."userId" = $3 LIMIT 2`, [sessionId, key, userId])
  if (result.rows.length > 1) throw conflict()
  return result.rows[0] ?? null
}

async function hasPriorPlan(client: Client, scope: TaskGraphScheduleInput["scope"], key: string): Promise<boolean> {
  const result = await client.query(`SELECT EXISTS (SELECT 1 FROM "agent_events" AS event
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId" JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3 AND event."idempotencyKey" = $4
      AND session."userId" = $5 AND turn."userId" = $5) AS "exists"`,
  [scope.sessionId, scope.turnId, taskGraphItemId(scope.rootTaskId), key, scope.userId])
  return result.rows[0]?.exists === true
}

export async function lockTaskGraphBranchSources(client: Client, input: TaskGraphScheduleInput,
  sources: readonly StoredTaskGraphNode[]): Promise<Map<string, TaskGraphBranchSourceRow>> {
  const result = await client.query<Row>(`SELECT task."id", task."status", task."role", task."taskType", task."constraints", task."allowedActions", task."expectedOutputSchema",
      task."attemptCount", task."leaseOwner", task."leaseExpiresAt", task."nextAttemptAt", task."startedAt", task."completedAt", task."closedAt",
      task."interruptRequestedAt", task."failureReason", task."result", task."confidence", task."qualityGateResult", task."outputArtifactIds", task."contextSnapshotId",
      EXISTS (SELECT 1 FROM "sub_agent_tasks" child WHERE child."sessionId" = task."sessionId" AND child."parentTaskId" = task."id"
        UNION ALL SELECT 1 FROM "agent_steps" step WHERE step."sessionId" = task."sessionId" AND step."taskId" = task."id"
        UNION ALL SELECT 1 FROM "agent_items" item WHERE item."sessionId" = task."sessionId" AND item."taskId" = task."id"
        UNION ALL SELECT 1 FROM "agent_events" event WHERE event."sessionId" = task."sessionId" AND event."taskId" = task."id"
        UNION ALL SELECT 1 FROM "agent_tree_budget_reservations" reservation WHERE reservation."taskId" = task."id" OR reservation."rootTaskId" = task."id"
        UNION ALL SELECT 1 FROM "agent_native_semantic_rejections" rejection WHERE rejection."rootTaskId" = task."id" OR rejection."controlTaskId" = task."id"
        UNION ALL SELECT 1 FROM "agent_mailbox_messages" message WHERE message."fromTaskId" = task."id" OR message."toTaskId" = task."id"
        UNION ALL SELECT 1 FROM "agent_mailbox_hydration_checkpoints" checkpoint WHERE checkpoint."rootTaskId" = task."id" OR checkpoint."taskId" = task."id"
        UNION ALL SELECT 1 FROM "agent_tool_result_references" reference WHERE reference."taskId" = task."id" UNION ALL ${waitEvidenceSql()}
        UNION ALL SELECT 1 FROM "agent_transcript_events" transcript WHERE transcript."taskId" = task."id"
        UNION ALL SELECT 1 FROM "agent_approvals" approval WHERE approval."taskId" = task."id"
        UNION ALL SELECT 1 FROM "agent_artifact_version" artifact WHERE artifact."taskId" = task."id"
        UNION ALL SELECT 1 FROM "agent_artifact_review" review WHERE review."taskId" = task."id"
        UNION ALL SELECT 1 FROM "application_tasks" application WHERE application."workerTaskId" = task."id"
        UNION ALL SELECT 1 FROM "agent_outbox" outbox WHERE (outbox."payload"->>'taskId' = task."id" OR outbox."payload"->'payload'->>'taskId' = task."id")
          AND NOT (outbox."topic" = 'agent.subagent.dispatch' AND outbox."aggregateId" = task."sessionId"
            AND outbox."idempotencyKey" = 'subagent-dispatch:' || task."id" AND outbox."payload"->>'taskId' = task."id"
            AND outbox."payload"->>'sessionId' = task."sessionId" AND outbox."payload"->>'rootTaskId' = task."rootTaskId")) AS "hasExecutionEvidence",
      EXISTS (SELECT 1 FROM "agent_outbox" dispatch WHERE dispatch."topic" = 'agent.subagent.dispatch' AND dispatch."aggregateId" = task."sessionId"
        AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id" AND dispatch."payload"->>'taskId' = task."id"
        AND dispatch."payload"->>'sessionId' = task."sessionId" AND dispatch."payload"->>'rootTaskId' = task."rootTaskId") AS "hasCanonicalDispatch"
    FROM "sub_agent_tasks" task JOIN "agent_sessions" session ON session."id" = task."sessionId"
    JOIN "agent_turns" turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 AND task."parentTaskId" = $4
      AND session."userId" = $5 AND turn."userId" = $5 ORDER BY task."id" FOR UPDATE OF task`,
  [sources.map(source => source.taskId), input.scope.sessionId, input.scope.turnId, input.scope.rootTaskId, input.scope.userId])
  if (result.rows.length !== sources.length) return new Map()
  return new Map(result.rows.map(row => [String(row.id), row]))
}

function waitEvidenceSql(): string { return `SELECT 1 FROM "agent_wait_conditions" wait WHERE wait."sessionId" = task."sessionId" AND wait."turnId" = task."turnId"
  AND (wait."parentTaskId" = task."id" OR wait."targetTaskIds" @> jsonb_build_array(task."id") OR wait."matchedTaskIds" @> jsonb_build_array(task."id"))` }

export function assertReplacementSnapshot(before: TaskGraphSnapshot, after: TaskGraphSnapshot, sources: readonly StoredTaskGraphNode[], mapping: ReadonlyMap<string, string>): void {
  const oldKeys = new Set(sources.map(node => node.key)), oldIds = new Set(before.nodes.map(node => node.taskId))
  const retained = before.nodes.filter(node => !oldKeys.has(node.key)), inserted = after.nodes.filter(node => !before.nodes.some(old => old.key === node.key))
  if (after.nodes.length !== retained.length + sources.length || inserted.length !== sources.length
    || canonicalTaskGraphJson(before.rootSuccessCriteria ?? null) !== canonicalTaskGraphJson(after.rootSuccessCriteria ?? null)
    || retained.some(node => canonicalTaskGraphJson(node) !== canonicalTaskGraphJson(after.nodes.find(next => next.key === node.key)))) throw invalid()
  for (const source of sources) {
    const key = mapping.get(source.key), replacement = key && after.nodes.find(node => node.key === key)
    if (!replacement || oldIds.has(replacement.taskId) || !replacementEnvelopeMatches(source, replacement, after.nodes)) throw invalid()
  }
}

function replacementEnvelopeMatches(source: StoredTaskGraphNode, replacement: StoredTaskGraphNode, graph: readonly StoredTaskGraphNode[]): boolean {
  const expectedDepth = depthOf(replacement.key, graph, new Set())
  if (expectedDepth === null || replacement.depth !== expectedDepth) return false
  const normalized = { ...source, key: replacement.key, taskId: replacement.taskId, goal: replacement.goal,
    successCriteria: replacement.successCriteria, dependsOn: replacement.dependsOn, depth: replacement.depth, verification: replacement.verification }
  return canonicalTaskGraphJson(normalized) === canonicalTaskGraphJson(replacement)
}
function depthOf(key: string, nodes: readonly StoredTaskGraphNode[], visiting: Set<string>): number | null {
  if (visiting.has(key)) return null
  const node = nodes.find(item => item.key === key)
  if (!node) return null
  if (!node.dependsOn.length) return 1
  visiting.add(key)
  const depths = node.dependsOn.map(dependency => depthOf(dependency, nodes, visiting))
  visiting.delete(key)
  return depths.some(depth => depth === null) ? null : Math.max(...depths as number[]) + 1
}

function sameBranch(input: TaskGraphBranchReplacement | undefined, operation: TaskGraphBranchReplacement | undefined): TaskGraphBranchReplacement | null {
  if (!input || !operation) return null
  const left = parseTaskGraphBranchReplacement(input), right = parseTaskGraphBranchReplacement(operation)
  return left.ok && right.ok && canonicalTaskGraphJson(left.value) === canonicalTaskGraphJson(right.value) ? left.value : null
}
function sameScope(left: TaskGraphScheduleInput["scope"], right: SteeringReconciliationOperation["scope"]): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId && left.turnId === right.turnId && left.rootTaskId === right.rootTaskId
    && left.parentTaskId === right.parentTaskId && left.stepId === right.stepId && left.turnLeaseOwner === right.turnLeaseOwner
    && left.turnLeaseVersion === right.turnLeaseVersion && left.parentLeaseOwner === right.parentLeaseOwner && left.parentAttemptCount === right.parentAttemptCount
}
function invalid(): never { throw new TaskGraphCommandError("task_graph_branch_repair_not_eligible", "The requested TaskGraph branch cannot be replaced") }
function conflict(): TaskGraphCommandError { return new TaskGraphCommandError("idempotency_conflict", "TaskGraph branch repair key was already used") }
