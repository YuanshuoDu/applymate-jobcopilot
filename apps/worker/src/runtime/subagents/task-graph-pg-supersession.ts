import { taskGraphFingerprint, taskGraphItemId, taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import { parseRegisteredScoutEnvelope, TaskGraphCommandError, type RegisteredScoutEnvelope, type TaskGraphTaskTemplate } from "./task-graph-command-port.js"
import { actionList, type Queryable } from "./pg-store-persistence.js"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { reduceTaskGraphEvent, type TaskGraphNodeProposal } from "../planning/task-graph.js"
import { taskGraphVerificationRole } from "../planning/task-graph-verification.js"
import { createGraphTasks } from "./task-graph-pg-create.js"
import { parseTaskGraphSupersessionRelation, TASK_GRAPH_SUPERSESSION_SCHEMA_VERSION,
  taskGraphSupersessionEnvelopeMatches, taskGraphSupersessionProposalMatches, writePlanReceiptWithIdentity, writeTaskLifecycleReceiptWithIdentity } from "./task-graph-pg-events.js"
import { deleteGraphDispatch } from "./task-graph-pg-lifecycle.js"
import { prepareSteeringReconciliation, writeSteeringReconciliationReceipt } from "./steering-reconciliation-ledger.js"
import type { SteeringReconciliationOperation } from "./steering-reconciliation-contract.js"
import type { GraphEventScope, GraphParent, LoadedGraph } from "./task-graph-pg-state.js"
import type { TaskGraphScheduleInput, TaskGraphScheduleReceipt } from "./task-graph-command-port.js"

type Row = Record<string, unknown>
type TaskIdentity = Readonly<{ nodeKey: string; taskId: string; dependsOn?: readonly string[] }>
type EventIdentity = Readonly<{ id: string; sequence: string }>
type PlanEventIdentity = EventIdentity & Readonly<{ idempotencyKey: string }>
const MAX_REVISION = 2_147_483_646
type PlanReplayLookup = (input: TaskGraphScheduleInput, key: string, fingerprint: string, itemId: string | null,
  supersession?: Readonly<{ operationKey: string; observedRevision: number }>) => Promise<TaskGraphScheduleReceipt | null>

export type TaskGraphSupersessionRelation = Readonly<{
  schemaVersion: typeof TASK_GRAPH_SUPERSESSION_SCHEMA_VERSION
  operationKey: string
  observedRevision: number
  cancellationRevision: number
  resultingRevision: number
  source: TaskIdentity
  replacement: TaskIdentity
  cancellationEvent: EventIdentity
  planEvent: PlanEventIdentity
  replacementFingerprint: string
  agentPlanCall: Readonly<{
    callId: string
    stepId: string
    expectedRevision: number
    replaceUnstarted: Readonly<{ nodeKey: string }>
  }>
}>

export { parseTaskGraphSupersessionRelation }

export async function loadTaskGraphCancellationSource(client: Queryable, scope: GraphEventScope, selection: Readonly<{
  eventId?: string; sequence?: string; nodeKey: string; taskId: string; expectedRevision: number; stepId: string
}>): Promise<StoredTaskGraphNode | null> {
  const result = await client.query<Row>(`SELECT event."payload"->'item'->'content' AS "content",
      EXISTS (SELECT 1 FROM "agent_outbox" outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id") AS "hasOutbox"
    FROM "agent_events" AS event JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    WHERE ($1::text IS NULL OR event."id" = $1) AND ($2::bigint IS NULL OR event."sequence" = $2::bigint)
      AND event."sessionId" = $3 AND event."turnId" = $4 AND event."itemId" = $5 AND event."taskId" = $6
      AND event."type" = 'item.delta' AND event."actor" = 'system' AND event."correlationId" = $4 AND event."causationId" = $7
      AND event."idempotencyKey" = $8 AND event."payload"->>'kind' = 'lifecycle' AND event."payload"->>'revision' = $9::text
      AND event."payload"->'event'->>'type' = 'task.cancelled' AND event."payload"->'event'->>'nodeKey' = $10
      AND event."payload"->'event'->>'expectedRevision' = $11::text
      AND event."payload"->'item'->>'id' = $5 AND event."payload"->'item'->>'revision' = $9::text
      AND turn."userId" = $12 AND turn."rootTaskId" = $13 AND session."userId" = $12 LIMIT 2`,
  [selection.eventId ?? null, selection.sequence ?? null, scope.sessionId, scope.turnId, taskGraphItemId(scope.rootTaskId), selection.taskId,
    selection.stepId, taskGraphLifecycleKey(scope.rootTaskId, selection.nodeKey, 0, "task.cancelled"), selection.expectedRevision + 1,
    selection.nodeKey, selection.expectedRevision, scope.userId, scope.rootTaskId])
  if (result.rows.length !== 1 || result.rows[0]!.hasOutbox !== true) return null
  try {
    const source = parseTaskGraphSnapshot(result.rows[0]!.content).nodes.find(node => node.key === selection.nodeKey)
    return source?.taskId === selection.taskId ? source : null
  } catch { return null }
}

export function taskGraphSupersessionProposalKey(rootTaskId: string, expectedRevision: number): string {
  return `${taskGraphItemId(rootTaskId)}:supersession:${expectedRevision}`
}

export function taskGraphSupersessionFingerprint(source: TaskIdentity, proposal: Readonly<{
  expectedRevision: number
  replaceUnstartedNodeKey: string
  nodes: readonly unknown[]
  rootSuccessCriteria?: readonly string[]
}>): string {
  const replacement = proposal.nodes.length === 1 && proposal.nodes[0] && typeof proposal.nodes[0] === "object"
    ? proposal.nodes[0] as Record<string, unknown> : null
  const oldEdgesDiffer = source.dependsOn !== undefined
    && canonicalTaskGraphJson(source.dependsOn) !== canonicalTaskGraphJson(replacement?.dependsOn ?? null)
  return taskGraphFingerprint({
    source: { nodeKey: source.nodeKey, taskId: source.taskId },
    ...(oldEdgesDiffer ? { sourceDependsOn: source.dependsOn } : {}),
    expectedRevision: proposal.expectedRevision,
    replaceUnstarted: { nodeKey: proposal.replaceUnstartedNodeKey },
    nodes: proposal.nodes,
    ...(proposal.rootSuccessCriteria === undefined ? {} : { rootSuccessCriteria: proposal.rootSuccessCriteria }),
  })
}

export function taskGraphWaitConditionEvidenceSql(): string {
  return `SELECT 1 FROM "agent_wait_conditions" wait
    WHERE wait."sessionId" = task."sessionId" AND wait."turnId" = task."turnId"
      AND (wait."parentTaskId" = task."id" OR wait."targetTaskIds" @> jsonb_build_array(task."id")
        OR wait."matchedTaskIds" @> jsonb_build_array(task."id"))`
}

export async function scheduleTaskGraphSupersession(client: Queryable, input: TaskGraphScheduleInput, parent: GraphParent,
  loaded: LoadedGraph, operation: SteeringReconciliationOperation | undefined, key: string, findReplay: PlanReplayLookup,
  checkBudget: () => Promise<void>, pinnedCriteria?: readonly string[]): Promise<TaskGraphScheduleReceipt> {
  const current = loaded.state, revision = current?.revision ?? 0, sourceKey = input.replaceUnstarted!.nodeKey
  if (!operation || operation.replaceUnstartedNodeKey !== sourceKey || input.proposal.nodes.length !== 1
    || input.scope.parentTaskId !== input.scope.rootTaskId || !input.scope.stepId) throw new TaskGraphCommandError("task_graph_supersession_invalid", "TaskGraph supersession request is invalid")
  const prepared = await prepareSteeringReconciliation(client, operation)
  if (!prepared || prepared.decision !== "revise" || prepared.expectedRevision !== input.proposal.expectedRevision) throw new TaskGraphCommandError("steering_reconciliation_revision_conflict", "TaskGraph supersession is not authorized for this revision")
  const priorRelation = parseTaskGraphSupersessionRelation(prepared.receipt.supersession)
  if (prepared.receipt.supersession && !priorRelation) throw new TaskGraphCommandError("idempotency_conflict", "Persisted supersession relation is invalid")
  const normalizedNodes = normalizeSupersessionNodes(input.proposal.nodes, input.scope.rootTaskId)
  const rootSuccessCriteria = input.rootSuccessCriteria
  if (priorRelation) {
    const cancelledSource = await loadTaskGraphCancellationSource(client, input.scope, {
      eventId: priorRelation.cancellationEvent.id, sequence: priorRelation.cancellationEvent.sequence,
      nodeKey: priorRelation.source.nodeKey, taskId: priorRelation.source.taskId,
      expectedRevision: priorRelation.observedRevision, stepId: priorRelation.agentPlanCall.stepId })
    if (!cancelledSource) throw new TaskGraphCommandError("idempotency_conflict", "Persisted supersession source proof is unavailable")
    const fingerprint = taskGraphSupersessionFingerprint({ ...priorRelation.source, dependsOn: cancelledSource.dependsOn }, { expectedRevision: input.proposal.expectedRevision,
      replaceUnstartedNodeKey: sourceKey, nodes: normalizedNodes, rootSuccessCriteria })
    const replay = await findReplay(input, key, fingerprint, taskGraphItemId(input.scope.parentTaskId), { operationKey: prepared.idempotencyKey, observedRevision: input.proposal.expectedRevision })
    if (!replay || priorRelation.operationKey !== prepared.idempotencyKey || priorRelation.observedRevision !== input.proposal.expectedRevision
      || priorRelation.source.nodeKey !== sourceKey || priorRelation.replacementFingerprint !== fingerprint || priorRelation.planEvent.idempotencyKey !== key
      || priorRelation.agentPlanCall.callId !== operation.callId || priorRelation.agentPlanCall.stepId !== input.scope.stepId) {
      throw new TaskGraphCommandError("idempotency_conflict", "TaskGraph supersession replay conflicts with persisted state")
    }
    return replay
  }
  if (input.proposal.expectedRevision !== revision) throw new TaskGraphCommandError("revision_mismatch", "TaskGraph revision is stale", revision)
  if (!current || !loaded.item || !loaded.snapshot || revision > MAX_REVISION - 2) throw new TaskGraphCommandError("task_graph_supersession_conflict", "TaskGraph supersession cannot be applied")
  if (parent.taskType !== "root" || parent.role !== "orchestrator" || !actionList(parent.allowedActions).includes("agent.plan")) throw new TaskGraphCommandError("task_graph_supersession_not_eligible", "Only the native planning Root can supersede a typed leaf")
  const source = loaded.snapshot.nodes.find(node => node.key === sourceKey), replacement = input.proposal.nodes[0]!
  if (!source || source.taskId === replacement.key || source.key === replacement.key || source.verificationDisposition !== "typed"
    || !taskGraphVerificationRole(source.templateId) || !taskGraphSupersessionProposalMatches(source, replacement, input.scope.rootTaskId, true)
    || loaded.snapshot.nodes.some(node => node.key !== sourceKey && (node.dependsOn.includes(sourceKey) || node.repairOf?.nodeKey === sourceKey))) {
    throw new TaskGraphCommandError("task_graph_supersession_not_eligible", "The requested typed leaf cannot be superseded")
  }
  const evidence = await client.query(`SELECT task."id", task."status", task."role", task."taskType", task."constraints", task."allowedActions", task."expectedOutputSchema", task."attemptCount", task."leaseOwner", task."leaseExpiresAt", task."nextAttemptAt", task."startedAt", task."completedAt", task."closedAt", task."interruptRequestedAt", task."failureReason", task."result", task."confidence", task."qualityGateResult", task."outputArtifactIds", task."contextSnapshotId",
    EXISTS (SELECT 1 FROM "sub_agent_tasks" child WHERE child."sessionId" = task."sessionId" AND child."parentTaskId" = task."id" UNION ALL SELECT 1 FROM "agent_steps" step WHERE step."sessionId" = task."sessionId" AND step."taskId" = task."id" UNION ALL SELECT 1 FROM "agent_items" item WHERE item."sessionId" = task."sessionId" AND item."taskId" = task."id" UNION ALL SELECT 1 FROM "agent_events" event WHERE event."sessionId" = task."sessionId" AND event."taskId" = task."id" UNION ALL SELECT 1 FROM "agent_tree_budget_reservations" reservation WHERE reservation."taskId" = task."id" OR reservation."rootTaskId" = task."id" UNION ALL SELECT 1 FROM "agent_native_semantic_rejections" rejection WHERE rejection."rootTaskId" = task."id" OR rejection."controlTaskId" = task."id"
      UNION ALL SELECT 1 FROM "agent_mailbox_messages" message WHERE message."fromTaskId" = task."id" OR message."toTaskId" = task."id" UNION ALL SELECT 1 FROM "agent_mailbox_hydration_checkpoints" checkpoint WHERE checkpoint."rootTaskId" = task."id" OR checkpoint."taskId" = task."id" UNION ALL SELECT 1 FROM "agent_tool_result_references" reference WHERE reference."taskId" = task."id" UNION ALL ${taskGraphWaitConditionEvidenceSql()} UNION ALL SELECT 1 FROM "agent_transcript_events" transcript WHERE transcript."taskId" = task."id" UNION ALL SELECT 1 FROM "agent_approvals" approval WHERE approval."taskId" = task."id"
      UNION ALL SELECT 1 FROM "agent_artifact_version" artifact WHERE artifact."taskId" = task."id" UNION ALL SELECT 1 FROM "agent_artifact_review" review WHERE review."taskId" = task."id" UNION ALL SELECT 1 FROM "application_tasks" application WHERE application."workerTaskId" = task."id" UNION ALL SELECT 1 FROM "agent_outbox" outbox WHERE (outbox."payload"->>'taskId' = task."id" OR outbox."payload"->'payload'->>'taskId' = task."id")
        AND NOT (outbox."topic" = 'agent.subagent.dispatch' AND outbox."aggregateId" = task."sessionId" AND outbox."idempotencyKey" = 'subagent-dispatch:' || task."id" AND outbox."payload"->>'taskId' = task."id" AND outbox."payload"->>'sessionId' = task."sessionId" AND outbox."payload"->>'rootTaskId' = task."rootTaskId")) AS "hasExecutionEvidence",
    EXISTS (SELECT 1 FROM "agent_outbox" dispatch WHERE dispatch."topic" = 'agent.subagent.dispatch' AND dispatch."aggregateId" = task."sessionId" AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id" AND dispatch."payload"->>'taskId' = task."id" AND dispatch."payload"->>'sessionId' = task."sessionId" AND dispatch."payload"->>'rootTaskId' = task."rootTaskId") AS "hasCanonicalDispatch"
    FROM "sub_agent_tasks" task WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 AND task."parentTaskId" = $4 FOR UPDATE OF task`, [source.taskId, input.scope.sessionId, input.scope.turnId, input.scope.rootTaskId])
  const row = evidence.rows[0] as Row | undefined
  if (!row || row.status !== "queued" || row.role !== taskGraphVerificationRole(source.templateId) || !taskGraphSupersessionTemplateMatches(row, input.templates[source.templateId]) || row.attemptCount !== 0
    || row.leaseOwner !== null || row.leaseExpiresAt !== null || row.nextAttemptAt !== null || row.startedAt !== null || row.completedAt !== null || row.closedAt !== null
    || row.interruptRequestedAt !== null || row.failureReason !== null || row.result !== null || row.confidence !== null || row.qualityGateResult !== null
    || row.contextSnapshotId !== null || JSON.stringify(row.outputArtifactIds) !== "[]" || row.hasExecutionEvidence === true || row.hasCanonicalDispatch !== true) {
    throw new TaskGraphCommandError("task_graph_supersession_not_eligible", "The requested typed leaf has execution evidence or is no longer queued")
  }
  const sourceTaskId = typeof row.id === "string" ? row.id : ""
  if (!sourceTaskId || sourceTaskId !== source.taskId) throw new TaskGraphCommandError("task_graph_supersession_not_eligible", "The locked source identity changed")
  const sourceIdentity = { nodeKey: sourceKey, taskId: sourceTaskId }
  const fingerprint = taskGraphSupersessionFingerprint({ ...sourceIdentity, dependsOn: source.dependsOn }, { expectedRevision: input.proposal.expectedRevision,
    replaceUnstartedNodeKey: sourceKey, nodes: normalizedNodes, rootSuccessCriteria })
  if (await findReplay(input, key, fingerprint, taskGraphItemId(input.scope.parentTaskId), { operationKey: prepared.idempotencyKey, observedRevision: input.proposal.expectedRevision })) {
    throw new TaskGraphCommandError("idempotency_conflict", "A supersession plan event exists without its validated relation")
  }
  await checkBudget()
  const cancelKey = taskGraphLifecycleKey(input.scope.rootTaskId, sourceKey, 0, "task.cancelled")
  const cancelEvent = { type: "task.cancelled" as const, idempotencyKey: cancelKey, expectedRevision: revision, nodeKey: sourceKey }
  const cancelled = reduceTaskGraphEvent(current, cancelEvent)
  if (!cancelled.ok) throw new TaskGraphCommandError("task_graph_supersession_not_eligible", "The requested typed leaf cannot be cancelled")
  const now = new Date(), updated = await client.query(`UPDATE "sub_agent_tasks" SET "status" = 'cancelled', "nextAttemptAt" = NULL, "completedAt" = $5, "updatedAt" = $5
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "parentTaskId" = $4 AND "status" = 'queued'
      AND "attemptCount" = 0 AND "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL AND "nextAttemptAt" IS NULL AND "startedAt" IS NULL AND "completedAt" IS NULL
      AND "closedAt" IS NULL AND "interruptRequestedAt" IS NULL AND "failureReason" IS NULL AND "result" IS NULL AND "confidence" IS NULL AND "qualityGateResult" IS NULL
      AND "contextSnapshotId" IS NULL AND "outputArtifactIds" = '[]'::jsonb`, [source.taskId, input.scope.sessionId, input.scope.turnId, input.scope.rootTaskId, now])
  if (updated.rowCount !== 1) throw new TaskGraphCommandError("task_graph_supersession_not_eligible", "The requested typed leaf changed before cancellation")
  await deleteGraphDispatch(client, input.scope.sessionId, source.taskId)
  const afterCancel = await writeTaskLifecycleReceiptWithIdentity(client, input.scope, loaded.item.id, source.taskId, cancelEvent, revision, loaded.snapshot, now)
  if (afterCancel.revision !== revision + 1) throw new Error("task_graph_revision_transition_mismatch")
  const working = { ...cancelled.state, nodes: cancelled.state.nodes.filter(node => node.key !== sourceKey),
    repairSatisfiedNodeKeys: cancelled.state.repairSatisfiedNodeKeys?.filter(nodeKey => nodeKey !== sourceKey), repairPendingNodeKeys: cancelled.state.repairPendingNodeKeys?.filter(nodeKey => nodeKey !== sourceKey) }
  const priorIds = new Map(loaded.snapshot.nodes.filter(node => node.key !== sourceKey).map(node => [node.key, node.taskId] as const))
  const created = await createGraphTasks(client, { ...input, proposal: { ...input.proposal, expectedRevision: revision + 1 } }, parent, working, priorIds, loaded)
  const stamped = stampCreatedScoutEnvelopes(created.snapshot, created.created, input.templates)
  const snapshot = pinnedCriteria ? parseTaskGraphSnapshot({ ...stamped, rootSuccessCriteria: pinnedCriteria }) : stamped
  const replacementNode = snapshot.nodes.find(node => node.key === created.created[0]?.key)
  if (created.state.revision !== revision + 2 || created.created.length !== 1 || !replacementNode || replacementNode.taskId === source.taskId
    || !taskGraphSupersessionEnvelopeMatches(source, replacementNode, true, snapshot.nodes) || snapshot.nodes.some(node => node.key === sourceKey || node.taskId === sourceTaskId)
    || loaded.snapshot.nodes.filter(node => node.key !== sourceKey).some(node => { const next = snapshot.nodes.find(candidate => candidate.key === node.key)
      return !next || next.taskId !== node.taskId || canonicalTaskGraphJson(node) !== canonicalTaskGraphJson(next) })) throw new TaskGraphCommandError("task_graph_supersession_conflict", "Replacement does not preserve the original graph envelope")
  const receipt: TaskGraphScheduleReceipt = { status: "accepted", revision: created.state.revision, nodes: created.created, readyTaskIds: created.readyTaskIds }
  const planEvent = await writePlanReceiptWithIdentity(client, { scope: input.scope, state: created.state, snapshot, expectedRevision: revision + 1,
    now, idempotencyKey: key, fingerprint, receipt, operationKey: prepared.idempotencyKey, observedRevision: revision })
  const relation = parseTaskGraphSupersessionRelation({ schemaVersion: TASK_GRAPH_SUPERSESSION_SCHEMA_VERSION, operationKey: prepared.idempotencyKey,
    observedRevision: revision, cancellationRevision: revision + 1, resultingRevision: revision + 2,
    source: sourceIdentity, replacement: { nodeKey: replacementNode.key, taskId: replacementNode.taskId },
    cancellationEvent: { id: afterCancel.id, sequence: afterCancel.sequence }, planEvent: { ...planEvent, idempotencyKey: key }, replacementFingerprint: fingerprint,
    agentPlanCall: { callId: operation.callId, stepId: input.scope.stepId, expectedRevision: revision, replaceUnstarted: { nodeKey: sourceKey } } })
  if (!relation) throw new Error("task_graph_supersession_relation_invalid")
  await writeSteeringReconciliationReceipt(client, prepared, created.state.revision, relation)
  return receipt
}
function normalizeSupersessionNodes(nodes: readonly TaskGraphNodeProposal[], rootTaskId: string): readonly TaskGraphNodeProposal[] {
  return nodes.map(node => node.repairOf && !node.repairOf.graphRootTaskId
    ? { ...node, repairOf: { ...node.repairOf, graphRootTaskId: rootTaskId } } : node)
}

export function taskGraphSupersessionTemplateMatches(source: Row, template: TaskGraphTaskTemplate | undefined): boolean {
  return Boolean(template && source.role === template.role && source.taskType === template.taskType
    && canonicalTaskGraphJson(actionList(source.allowedActions)) === canonicalTaskGraphJson(actionList(template.allowedActions))
    && canonicalTaskGraphJson(source.constraints) === canonicalTaskGraphJson(template.constraints ?? [])
    && canonicalTaskGraphJson(source.expectedOutputSchema) === canonicalTaskGraphJson(template.expectedOutputSchema ?? {}))
}

export function stampCreatedScoutEnvelopes(snapshot: TaskGraphSnapshot, created: readonly { key: string }[], templates: Readonly<Record<string, TaskGraphTaskTemplate>>): TaskGraphSnapshot {
  const keys = new Set(created.map(node => node.key))
  return parseTaskGraphSnapshot({ ...snapshot, nodes: snapshot.nodes.map(node => {
    if (!keys.has(node.key) || node.templateId !== "scout" || node.verificationDisposition !== "typed") return node
    const registeredScoutEnvelope = templates.scout && registeredScoutEnvelopeFor(templates.scout)
    if (!registeredScoutEnvelope) throw new TaskGraphCommandError("task_graph_registered_scout_envelope_invalid", "Registered Scout template is invalid")
    return { ...node, registeredScoutEnvelope }
  }) })
}
function registeredScoutEnvelopeFor(template: TaskGraphTaskTemplate): RegisteredScoutEnvelope | undefined {
  return parseRegisteredScoutEnvelope({ role: template.role, taskType: template.taskType,
    expectedOutputSchema: parseScoutSchemaMarker(template.expectedOutputSchema), allowedActions: actionList(template.allowedActions) })
}
function parseScoutSchemaMarker(value: unknown): unknown {
  if (typeof value !== "string") return value
  try { const parsed: unknown = JSON.parse(value) as unknown; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined }
  catch { return undefined }
}
