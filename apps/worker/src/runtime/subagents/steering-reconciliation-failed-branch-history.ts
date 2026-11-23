import type pg from "pg"
import { validateTaskGraphBranchReplacement } from "../planning/task-graph-branch-replacement.js"
import type { TaskGraphNodeProposal } from "../planning/task-graph.js"
import type { TaskGraphBranchReplacement } from "../planning/task-graph-branch-replacement.js"
import { canonicalTaskGraphJson, taskGraphItemId, taskGraphProposalKey } from "./task-graph-snapshot.js"
import type { StoredTaskGraphNode } from "./task-graph-snapshot.js"
import { parseTaskGraphFailedBranchRepairRelation, taskGraphFailedBranchRepairFingerprint,
  type TaskGraphFailedBranchRepairRelation } from "./task-graph-pg-failed-branch-relation.js"
import { proveTaskGraphFailedBranchEvidence } from "./task-graph-pg-failed-branch-evidence.js"
import { verifyTaskGraphFailedBranchCancellationHistory } from "./steering-reconciliation-failed-branch-cancellations.js"
import { steeringReconciliationDurableIdempotencyKey, steeringReconciliationIdempotencyKey,
  validHistoricalFailedBranchReplacementToolCall, validSteeringReconciliationToolCall,
  type SteeringReconciliationDurableScope, type SteeringReconciliationScope } from "./steering-reconciliation-contract.js"
import { parseTaskGraphReplacementScheduleReceipt, parseTaskGraphReplacementSnapshot, readTaskGraphReplacementObservedSnapshot,
  taskGraphFailedBranchReplacementDeltaMatches, type VerifiedTaskGraphFailedBranchReplacementMemoryWitness }
  from "./steering-reconciliation-failed-branch-proof-readers.js"
import type { TaskGraphScheduleReceipt } from "./task-graph-command-port.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
const MAX_SEQUENCE = 9_223_372_036_854_775_807n
type CallValidator = (event: Row, item: Row, stepId: string, expectedRevision: number, replaceBranch: TaskGraphBranchReplacement) => boolean

function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : null } catch { return null }
}
function exact(row: Row | null, keys: readonly string[]): row is Row {
  return row !== null && Reflect.ownKeys(row).length === keys.length && Reflect.ownKeys(row).every(key => typeof key === "string" && keys.includes(key))
}
function sequence(value: unknown): bigint | null {
  if (typeof value === "bigint") return value > 0n && value <= MAX_SEQUENCE ? value : null
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? BigInt(value) : null
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) return null
  const parsed = BigInt(value); return parsed <= MAX_SEQUENCE ? parsed : null
}
function invalid(): never { throw new Error("steering_reconciliation_failed_branch_event_invalid") }

type PersistedCall = Readonly<{ sequence: bigint; nodes: readonly TaskGraphNodeProposal[]; rootSuccessCriteria?: readonly string[] }>
async function readCall(client: Client, scope: SteeringReconciliationDurableScope, relation: TaskGraphFailedBranchRepairRelation,
  validCall: CallValidator): Promise<PersistedCall> {
  const stepId = relation.agentPlanCall.stepId
  const result = await client.query<Row>(`SELECT event."id" AS "eventId", event."sequence" AS "eventSequence", event."type", event."actor",
      event."taskId" AS "eventTaskId", event."itemId" AS "eventItemId", event."correlationId", event."idempotencyKey", event."payload",
      item."id" AS "callItemId", item."stepId", item."taskId" AS "itemTaskId", item."type" AS "itemType", item."content" AS "itemContent"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId" AND session."userId" = $6
      JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
        AND turn."userId" = $6 AND turn."rootTaskId" = $3
      JOIN "agent_items" AS item ON item."id" = event."itemId" AND item."sessionId" = event."sessionId" AND item."turnId" = event."turnId"
      JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId"
        AND step."turnId" = item."turnId" AND step."taskId" = item."taskId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = 'tool_call.started' AND event."taskId" = $3
      AND event."correlationId" = $4 AND item."taskId" = $3 AND item."type" = 'tool_call' AND item."stepId" = $5 AND step."id" = $5 LIMIT 2`,
  [scope.sessionId, scope.turnId, scope.rootTaskId, relation.agentPlanCall.callId, stepId, scope.userId])
  const row = result.rows.length === 1 ? result.rows[0]! : null, event: Row = row ? {
    id: row.eventId, sequence: row.eventSequence, type: row.type, actor: row.actor, taskId: row.eventTaskId,
    itemId: row.eventItemId, correlationId: row.correlationId, idempotencyKey: row.idempotencyKey, payload: row.payload,
  } : {}, item: Row = row ? { id: row.callItemId, stepId: row.stepId, taskId: row.itemTaskId, type: row.itemType, content: row.itemContent } : {}
  const content = object(item.content), input = object(content?.input), seq = sequence(row?.eventSequence)
  if (!row || seq === null || !validCall(event, item, stepId, relation.observedRevision, relation.agentPlanCall.replaceBranch)
    || !Array.isArray(input?.nodes)) invalid()
  const fingerprint = taskGraphFailedBranchRepairFingerprint({ expectedRevision: relation.observedRevision,
    replaceBranch: relation.agentPlanCall.replaceBranch, nodes: input.nodes as unknown[],
    ...(input.rootSuccessCriteria === undefined ? {} : { rootSuccessCriteria: input.rootSuccessCriteria as string[] }) })
  if (fingerprint !== relation.requestFingerprint || canonicalTaskGraphJson(input.replaceBranch) !== canonicalTaskGraphJson(relation.agentPlanCall.replaceBranch)
    || BigInt(relation.failedSource.event.sequence) >= seq
    || relation.cancellations.some(cancellation => BigInt(cancellation.event.sequence) <= seq)) invalid()
  return { sequence: seq, nodes: input.nodes as TaskGraphNodeProposal[],
    ...(input.rootSuccessCriteria === undefined ? {} : { rootSuccessCriteria: input.rootSuccessCriteria as string[] }) }
}

type VerifiedReplacement = Readonly<{ receipt: TaskGraphScheduleReceipt; witness: VerifiedTaskGraphFailedBranchReplacementMemoryWitness }>
type ReceiptEvent = Readonly<{ id: string; sequence: bigint; stepId: string; idempotencyKey: string }>

async function verifyTaskGraphFailedBranchReplacementHistory(client: Client, scope: SteeringReconciliationDurableScope,
  relation: TaskGraphFailedBranchRepairRelation, receiptEvent: ReceiptEvent, operationKey: string | null,
  validCall: CallValidator): Promise<VerifiedReplacement> {
  const parsed = parseTaskGraphFailedBranchRepairRelation(relation), callStep = relation.agentPlanCall.stepId
  if (!parsed || !operationKey || relation.graphRootTaskId !== scope.rootTaskId || !receiptEvent.id || receiptEvent.sequence <= 0n
    || receiptEvent.stepId !== callStep || receiptEvent.idempotencyKey !== relation.operationKey || relation.operationKey !== operationKey) invalid()
  const relationIds = [relation.failedSource.event.id, ...relation.cancellations.map(value => value.event.id),
    ...relation.verifiedExternalDependencies.map(value => value.completedEvent.id), relation.planEvent.id]
  if (new Set(relationIds).size !== relationIds.length || relationIds.includes(receiptEvent.id)) invalid()
  const result = await client.query<Row>(`SELECT event."id", event."sessionId", event."turnId", event."itemId", event."taskId", event."type",
      event."actor", event."correlationId", event."causationId", event."sequence"::text AS "sequence", event."idempotencyKey", event."payload",
      session."userId" AS "sessionUserId", turn."userId" AS "turnUserId", turn."rootTaskId" AS "turnRootTaskId",
      outbox."topic" AS "outboxTopic", outbox."aggregateId" AS "outboxAggregateId", outbox."idempotencyKey" AS "outboxIdempotencyKey", outbox."payload" AS "outboxPayload"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId" AND session."userId" = $3
      JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
        AND turn."userId" = $3 AND turn."rootTaskId" = $4
      LEFT JOIN "agent_outbox" AS outbox ON outbox."idempotencyKey" = 'agent-event:' || event."id"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."id" = ANY($5::text[])
    ORDER BY event."sequence", event."id"`, [scope.sessionId, scope.turnId, scope.userId, scope.rootTaskId, relationIds])
  if (result.rows.length !== relationIds.length || result.rows.some(row => row.sessionUserId !== scope.userId
    || row.turnUserId !== scope.userId || row.turnRootTaskId !== scope.rootTaskId)) invalid()
  const rows = new Map(result.rows.map(row => [String(row.id), row])), failedRow = rows.get(relation.failedSource.event.id)
  const failedPayload = object(failedRow?.payload), failedItem = object(failedPayload?.item)
  const before = parseTaskGraphReplacementSnapshot(failedItem?.content)
  if (!before) invalid()
  const failedSourceNodes = relation.sources.map(binding => before.nodes.find(node => node.key === binding.source.nodeKey && node.taskId === binding.source.taskId))
  if (failedSourceNodes.some(node => node === undefined)) invalid()
  const persistedSources = failedSourceNodes.filter((node): node is StoredTaskGraphNode => node !== undefined)
  const proof = await proveTaskGraphFailedBranchEvidence(client, { scope: { userId: scope.userId, sessionId: scope.sessionId,
    turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.rootTaskId }, snapshot: before,
    sourceNodes: persistedSources })
  if (!proof || canonicalTaskGraphJson(proof.failedSource) !== canonicalTaskGraphJson(relation.failedSource)
    || canonicalTaskGraphJson(proof.verifiedExternalDependencies) !== canonicalTaskGraphJson(relation.verifiedExternalDependencies)) invalid()

  const call = await readCall(client, scope, relation, validCall)
  const observed = await readTaskGraphReplacementObservedSnapshot(client, scope, call.sequence, relation.observedRevision)
  const observedSources = relation.sources.map(binding => observed.snapshot.nodes.find(node => node.key === binding.source.nodeKey && node.taskId === binding.source.taskId))
  if (observedSources.some(node => node === undefined)
    || observedSources.some((node, index) => canonicalTaskGraphJson(node) !== canonicalTaskGraphJson(persistedSources[index]))) invalid()
  const validation = validateTaskGraphBranchReplacement({ snapshot: observed.snapshot, replaceBranch: relation.agentPlanCall.replaceBranch,
    proposal: { expectedRevision: relation.observedRevision, nodes: call.nodes },
    ...(call.rootSuccessCriteria === undefined ? {} : { proposedRootSuccessCriteria: call.rootSuccessCriteria }) })
  if (!validation.ok || validation.value.sourceNodes.length !== relation.sources.length
    || validation.value.sourceNodes.some((node, index) => relation.sources[index]?.source.nodeKey !== node.key
      || relation.sources[index]?.source.taskId !== node.taskId
      || relation.sources[index]?.replacementKey !== validation.value.sourceToReplacementKey.get(node.key))) invalid()
  if (!await verifyTaskGraphFailedBranchCancellationHistory(client, scope, relation, observed.snapshot, observed.itemStepId, call.sequence, result.rows)) invalid()
  const planRow = rows.get(relation.planEvent.id), planSequence = sequence(planRow?.sequence), planPayload = object(planRow?.payload)
  const planItem = object(planPayload?.item), after = parseTaskGraphReplacementSnapshot(planItem?.content), receipt = parseTaskGraphReplacementScheduleReceipt(planPayload?.receipt)
  const expectedPlanOutbox = planRow && { eventId: planRow.id, sessionId: planRow.sessionId, turnId: planRow.turnId,
    itemId: planRow.itemId, taskId: planRow.taskId, sequence: String(planRow.sequence), type: planRow.type, actor: planRow.actor,
    correlationId: planRow.correlationId, causationId: planRow.causationId, idempotencyKey: planRow.idempotencyKey, payload: planRow.payload }
  if (!planRow || !after || !receipt || !exact(planPayload, ["kind", "fingerprint", "receipt", "revision", "item", "content"])
    || planSequence?.toString() !== relation.planEvent.sequence || planSequence <= call.sequence
    || planSequence >= receiptEvent.sequence || planRow.itemId !== taskGraphItemId(scope.rootTaskId) || planRow.taskId !== scope.rootTaskId
    || planRow.sessionId !== scope.sessionId || planRow.turnId !== scope.turnId || planRow.sessionUserId !== scope.userId
    || planRow.turnUserId !== scope.userId || planRow.turnRootTaskId !== scope.rootTaskId
    || planRow.type !== "item.delta" || planRow.actor !== "orchestrator" || planRow.correlationId !== scope.turnId
    || planRow.causationId !== callStep || planRow.idempotencyKey !== relation.planEvent.idempotencyKey
    || planRow.outboxTopic !== "agent.session.event" || planRow.outboxAggregateId !== scope.sessionId
    || planRow.outboxIdempotencyKey !== `agent-event:${relation.planEvent.id}` || planPayload?.kind !== "proposal"
    || planPayload.fingerprint !== relation.requestFingerprint || planPayload.revision !== relation.resultingRevision
    || Object.hasOwn(planPayload, "operationKey") || Object.hasOwn(planPayload, "observedRevision")
    || canonicalTaskGraphJson(planRow.outboxPayload) !== canonicalTaskGraphJson(expectedPlanOutbox)
    || planItem?.id !== taskGraphItemId(scope.rootTaskId) || planItem.sessionId !== scope.sessionId || planItem.turnId !== scope.turnId
    || planItem.stepId !== callStep
    || planItem.taskId !== scope.rootTaskId || planItem.type !== "task_graph" || planItem.revision !== relation.resultingRevision
    || canonicalTaskGraphJson(planPayload.content) !== canonicalTaskGraphJson(planItem.content)
    || !taskGraphFailedBranchReplacementDeltaMatches(observed.snapshot, after, validation.value.sourceNodes, validation.value.sourceToReplacementKey,
      validation.value.replacementNodes, receipt, relation.resultingRevision)) invalid()
  return { receipt, witness: { reason: "result_invalid",
    sourceTemplateIds: validation.value.sourceNodes.map(node => node.templateId),
    successorTemplateIds: validation.value.replacementNodes.map(node => node.templateId) } }
}

async function assertHistoricalResultInvalidCause(client: Client, scope: SteeringReconciliationDurableScope, taskId: string): Promise<void> {
  const result = await client.query<Row>(`SELECT task."id", task."role", task."status", task."failureReason", task."result",
      session."userId" AS "sessionUserId", turn."userId" AS "turnUserId", turn."rootTaskId" AS "turnRootTaskId"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
      AND task."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6 FOR UPDATE OF task`,
  [taskId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId])
  const row = result.rows[0], taskResult = object(row?.result), report = object(taskResult?.taskGraphVerificationReport)
  if (result.rows.length !== 1 || !row || row.id !== taskId || row.role !== "scout" || row.status !== "failed"
    || row.failureReason !== "task_graph_verification_unverified" || row.sessionUserId !== scope.userId
    || row.turnUserId !== scope.userId || row.turnRootTaskId !== scope.rootTaskId
    || report?.status !== "unverified" || report.reasonCode !== "result_invalid"
    || report.evidenceDigest !== null || report.resultDigest !== null) invalid()
}

/** Reconstructs the v4 receipt only from the original call, lifecycle evidence, and public plan event. */
export async function assertTaskGraphFailedBranchRepairHistory(client: Client, scope: SteeringReconciliationScope,
  relation: TaskGraphFailedBranchRepairRelation, receiptEvent: ReceiptEvent): Promise<TaskGraphScheduleReceipt> {
  const { stepId, callId } = relation.agentPlanCall
  const validCall: CallValidator = (event, item, id, revision, branch) =>
    validSteeringReconciliationToolCall(event, item, scope, id, "revise", revision, undefined, branch)
  return (await verifyTaskGraphFailedBranchReplacementHistory(client, scope, relation, receiptEvent,
    steeringReconciliationIdempotencyKey({ ...scope, stepId }, callId), validCall)).receipt
}

/** Revalidates a historical receipt without manufacturing live lease values. */
export async function verifyHistoricalFailedBranchReplacementMemory(client: Client, scope: SteeringReconciliationDurableScope,
  relation: TaskGraphFailedBranchRepairRelation, receiptEvent: ReceiptEvent): Promise<VerifiedTaskGraphFailedBranchReplacementMemoryWitness> {
  const { stepId, callId } = relation.agentPlanCall
  const validCall: CallValidator = (event, item, id, revision, branch) =>
    validHistoricalFailedBranchReplacementToolCall(event, item, scope, id, revision, branch)
  const verified = await verifyTaskGraphFailedBranchReplacementHistory(client, scope, relation, receiptEvent,
    steeringReconciliationDurableIdempotencyKey(scope, stepId, callId), validCall)
  await assertHistoricalResultInvalidCause(client, scope, relation.failedSource.source.taskId)
  return verified.witness
}
