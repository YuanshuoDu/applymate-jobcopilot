import type pg from "pg"
import { createHash } from "node:crypto"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { validateTaskGraphBranchReplacement } from "../planning/task-graph-branch-replacement.js"
import type { TaskGraphNodeProposal } from "../planning/task-graph.js"
import { canonicalTaskGraphJson, parseTaskGraphEvent, parseTaskGraphSnapshot, taskGraphItemId, taskGraphLifecycleKey, taskGraphProposalKey } from "./task-graph-snapshot.js"
import type { StoredTaskGraphNode, TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { parseTaskGraphFailedBranchRepairRelation, taskGraphFailedBranchRepairFingerprint,
  type TaskGraphFailedBranchRepairRelation } from "./task-graph-pg-failed-branch-relation.js"
import { proveTaskGraphFailedBranchEvidence } from "./task-graph-pg-failed-branch-evidence.js"
import { verifyTaskGraphFailedBranchCancellationHistory } from "./steering-reconciliation-failed-branch-cancellations.js"
import { steeringReconciliationIdempotencyKey, validSteeringReconciliationToolCall,
  type SteeringReconciliationScope } from "./steering-reconciliation-contract.js"
import type { TaskGraphScheduleReceipt } from "./task-graph-command-port.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
const MAX_SEQUENCE = 9_223_372_036_854_775_807n

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
async function readCall(client: Client, scope: SteeringReconciliationScope, relation: TaskGraphFailedBranchRepairRelation): Promise<PersistedCall> {
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
  if (!row || seq === null || !validSteeringReconciliationToolCall(event, item, scope, stepId, "revise",
    relation.observedRevision, undefined, relation.agentPlanCall.replaceBranch) || !Array.isArray(input?.nodes)) invalid()
  const fingerprint = taskGraphFailedBranchRepairFingerprint({ expectedRevision: relation.observedRevision,
    replaceBranch: relation.agentPlanCall.replaceBranch, nodes: input.nodes as unknown[],
    ...(input.rootSuccessCriteria === undefined ? {} : { rootSuccessCriteria: input.rootSuccessCriteria as string[] }) })
  if (fingerprint !== relation.requestFingerprint || canonicalTaskGraphJson(input.replaceBranch) !== canonicalTaskGraphJson(relation.agentPlanCall.replaceBranch)
    || BigInt(relation.failedSource.event.sequence) >= seq
    || relation.cancellations.some(cancellation => BigInt(cancellation.event.sequence) <= seq)) invalid()
  return { sequence: seq, nodes: input.nodes as TaskGraphNodeProposal[],
    ...(input.rootSuccessCriteria === undefined ? {} : { rootSuccessCriteria: input.rootSuccessCriteria as string[] }) }
}

async function readObservedSnapshot(client: Client, scope: SteeringReconciliationScope, beforeSequence: bigint,
  expectedRevision: number): Promise<Readonly<{ snapshot: TaskGraphSnapshot; sequence: bigint; id: string }>> {
  const result = await client.query<Row>(`SELECT event."id", event."sessionId", event."turnId", event."itemId", event."taskId",
      event."sequence"::text AS "sequence", event."type", event."actor", event."correlationId", event."causationId",
      event."idempotencyKey", event."payload", session."userId" AS "sessionUserId", turn."userId" AS "turnUserId",
      turn."rootTaskId" AS "turnRootTaskId", outbox."topic" AS "outboxTopic", outbox."aggregateId" AS "outboxAggregateId",
      outbox."idempotencyKey" AS "outboxIdempotencyKey", outbox."payload" AS "outboxPayload"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId" AND session."userId" = $4
      JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
        AND turn."userId" = $4 AND turn."rootTaskId" = $3
      LEFT JOIN "agent_outbox" AS outbox ON outbox."idempotencyKey" = 'agent-event:' || event."id"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $5
      AND event."type" IN ('item.started', 'item.delta') AND event."sequence" < $6::bigint
    ORDER BY event."sequence" DESC LIMIT 1`, [scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId,
    taskGraphItemId(scope.rootTaskId), beforeSequence.toString()])
  const row = result.rows[0], payload = object(row?.payload), item = object(payload?.item), seq = sequence(row?.sequence)
  const snapshot = parseSnapshot(item?.content)
  if (result.rows.length !== 1 || !row || !payload || !item || !snapshot || seq === null || seq >= beforeSequence
    || Number(payload.revision) !== expectedRevision || item.revision !== expectedRevision || item.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION
    || item.id !== taskGraphItemId(scope.rootTaskId) || item.sessionId !== scope.sessionId || item.turnId !== scope.turnId
    || item.taskId !== scope.rootTaskId || item.type !== "task_graph" || row.sessionId !== scope.sessionId || row.turnId !== scope.turnId
    || row.itemId !== taskGraphItemId(scope.rootTaskId)
    || row.sessionUserId !== scope.userId || row.turnUserId !== scope.userId || row.turnRootTaskId !== scope.rootTaskId
    || row.correlationId !== scope.turnId || row.type !== "item.delta"
    || row.outboxTopic !== "agent.session.event" || row.outboxAggregateId !== scope.sessionId
    || row.outboxIdempotencyKey !== `agent-event:${row.id}`) invalid()
  const expectedOutbox = { eventId: row.id, sessionId: row.sessionId, turnId: row.turnId, itemId: row.itemId,
    taskId: row.taskId, sequence: String(row.sequence), type: row.type, actor: row.actor,
    correlationId: row.correlationId, causationId: row.causationId, idempotencyKey: row.idempotencyKey, payload: row.payload }
  if (canonicalTaskGraphJson(row.outboxPayload) !== canonicalTaskGraphJson(expectedOutbox)) invalid()
  if (payload.kind === "lifecycle") {
    const event = parseTaskGraphEvent(payload.event), node = event && snapshot.nodes.find(value => value.key === event.nodeKey)
    if (!event || !node || row.actor !== "system" || row.taskId !== node.taskId || row.causationId !== null
      || payload.revision !== expectedRevision || event.expectedRevision !== expectedRevision - 1
      || event.idempotencyKey !== row.idempotencyKey || !validLifecycleKey(row.idempotencyKey, scope.rootTaskId, event.nodeKey, event.type)) invalid()
  } else if (payload.kind === "proposal") {
    const allowed = ["kind", "fingerprint", "receipt", "revision", "item", "content"]
    if (Object.hasOwn(payload, "operationKey")) allowed.push("operationKey")
    if (Object.hasOwn(payload, "observedRevision")) allowed.push("observedRevision")
    if (!exact(payload, allowed) || row.taskId !== scope.rootTaskId || row.actor !== "orchestrator" || row.causationId !== item.stepId
      || typeof row.causationId !== "string" || !/^[0-9a-f]{64}$/.test(String(payload.fingerprint))
      || row.idempotencyKey !== taskGraphProposalKey(scope.rootTaskId, expectedRevision - 1)
      || !parseReceipt(payload.receipt) || canonicalTaskGraphJson(payload.content) !== canonicalTaskGraphJson(item.content)) invalid()
  } else invalid()
  return { snapshot, sequence: seq, id: String(row.id) }
}

function validLifecycleKey(key: unknown, rootTaskId: string, nodeKey: string, type: string): boolean {
  const hash = createHash("sha256").update(nodeKey).digest("hex").slice(0, 20)
  const prefix = `${taskGraphItemId(rootTaskId)}:node:${hash}:`
  if (typeof key !== "string" || !key.startsWith(prefix)) return false
  const match = /^(0|[1-9][0-9]*):(task\.[a-z_]+)$/.exec(key.slice(prefix.length))
  return Boolean(match && match[2] === type && Number.isSafeInteger(Number(match[1]))
    && taskGraphLifecycleKey(rootTaskId, nodeKey, Number(match[1]), type) === key)
}

/** Reconstructs the v4 receipt only from the original call, lifecycle evidence, and public plan event. */
export async function assertTaskGraphFailedBranchRepairHistory(client: Client, scope: SteeringReconciliationScope,
  relation: TaskGraphFailedBranchRepairRelation, receiptEvent: Readonly<{ id: string; sequence: bigint; stepId: string; idempotencyKey: string }>): Promise<TaskGraphScheduleReceipt> {
  const parsed = parseTaskGraphFailedBranchRepairRelation(relation), callStep = relation.agentPlanCall.stepId
  if (!parsed || relation.graphRootTaskId !== scope.rootTaskId || !receiptEvent.id || receiptEvent.sequence <= 0n
    || receiptEvent.stepId !== callStep || receiptEvent.idempotencyKey !== relation.operationKey
    || relation.operationKey !== steeringReconciliationIdempotencyKey({ ...scope, stepId: callStep }, relation.agentPlanCall.callId)) invalid()
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
  let before: TaskGraphSnapshot
  try { before = parseTaskGraphSnapshot(failedItem?.content) } catch { return invalid() }
  const failedSourceNodes = relation.sources.map(binding => before.nodes.find(node => node.key === binding.source.nodeKey && node.taskId === binding.source.taskId))
  if (failedSourceNodes.some(node => node === undefined)) invalid()
  const persistedSources = failedSourceNodes.filter((node): node is StoredTaskGraphNode => node !== undefined)
  const proof = await proveTaskGraphFailedBranchEvidence(client, { scope: { userId: scope.userId, sessionId: scope.sessionId,
    turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.rootTaskId }, snapshot: before,
    sourceNodes: persistedSources })
  if (!proof || canonicalTaskGraphJson(proof.failedSource) !== canonicalTaskGraphJson(relation.failedSource)
    || canonicalTaskGraphJson(proof.verifiedExternalDependencies) !== canonicalTaskGraphJson(relation.verifiedExternalDependencies)) invalid()

  const call = await readCall(client, scope, relation)
  const observed = await readObservedSnapshot(client, scope, call.sequence, relation.observedRevision)
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
  if (!await verifyTaskGraphFailedBranchCancellationHistory(client, scope, relation, observed.snapshot, call.sequence, result.rows)) invalid()
  const planRow = rows.get(relation.planEvent.id), planSequence = sequence(planRow?.sequence), planPayload = object(planRow?.payload)
  const planItem = object(planPayload?.item), after = parseSnapshot(planItem?.content), receipt = parseReceipt(planPayload?.receipt)
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
    || !deltaMatches(observed.snapshot, after, validation.value.sourceNodes, validation.value.sourceToReplacementKey,
      validation.value.replacementNodes, receipt, relation.resultingRevision)) invalid()
  return receipt
}

function parseSnapshot(value: unknown): TaskGraphSnapshot | null { try { return parseTaskGraphSnapshot(value) } catch { return null } }
function parseReceipt(value: unknown): TaskGraphScheduleReceipt | null {
  const row = object(value)
  if (!row || !exact(row, ["status", "revision", "nodes", "readyTaskIds"]) || row.status !== "accepted"
    || !Number.isSafeInteger(row.revision) || !Array.isArray(row.nodes) || !Array.isArray(row.readyTaskIds)) return null
  const nodes = row.nodes.map(object)
  if (nodes.some(node => !node || !exact(node, ["key", "taskId", "status"])
    || typeof node.key !== "string" || typeof node.taskId !== "string" || node.status !== "queued" && node.status !== "waiting")
    || nodes.some((node, index) => nodes.slice(0, index).some(previous => previous?.key === node?.key || previous?.taskId === node?.taskId))) return null
  const queued = new Set(nodes.filter((node): node is Row => node?.status === "queued").map(node => node.taskId as string))
  if (!row.readyTaskIds.every((id): id is string => typeof id === "string" && id.length > 0 && queued.has(id))
    || new Set(row.readyTaskIds).size !== row.readyTaskIds.length) return null
  return row as unknown as TaskGraphScheduleReceipt
}
function deltaMatches(before: TaskGraphSnapshot, after: TaskGraphSnapshot, sources: readonly TaskGraphSnapshot["nodes"][number][],
  mapping: ReadonlyMap<string, string>, proposals: readonly unknown[], receipt: TaskGraphScheduleReceipt, revision: number): boolean {
  const removed = new Set(sources.map(node => node.key)), retained = before.nodes.filter(node => !removed.has(node.key))
  const inserted = after.nodes.filter(node => !before.nodes.some(old => old.key === node.key))
  const oldTaskIds = new Set(before.nodes.map(node => node.taskId))
  if (receipt.revision !== revision || after.nodes.length !== retained.length + sources.length || inserted.length !== sources.length
    || receipt.nodes.length !== sources.length || canonicalTaskGraphJson(before.rootSuccessCriteria ?? null) !== canonicalTaskGraphJson(after.rootSuccessCriteria ?? null)
    || retained.some(node => canonicalTaskGraphJson(node) !== canonicalTaskGraphJson(after.nodes.find(next => next.key === node.key)))) return false
  return sources.every(source => {
    const key = mapping.get(source.key), node = key && after.nodes.find(value => value.key === key)
    const proposal = proposals.find(value => object(value)?.key === key), receiptNode = receipt.nodes.find(value => value.key === key)
    const proposalRow = object(proposal)
    if (!node || !proposal || !receiptNode || node.taskId === source.taskId || oldTaskIds.has(node.taskId) || node.verificationDisposition !== "typed"
      || !proposalRow || !exact(receiptNode as unknown as Row, ["key", "taskId", "status"]) || receiptNode.taskId !== node.taskId
      || receiptNode.status !== "queued" && receiptNode.status !== "waiting") return false
    const { depth: _depth, taskId: _taskId, verificationDisposition: _disposition, registeredScoutEnvelope: _envelope, ...stored } = node
    const envelope = { ...source, key: node.key, taskId: node.taskId, goal: proposalRow.goal,
      successCriteria: proposalRow.successCriteria, dependsOn: proposalRow.dependsOn, verification: proposalRow.verification }
    return canonicalTaskGraphJson(stored) === canonicalTaskGraphJson(proposal)
      && node.depth === source.depth && canonicalTaskGraphJson(envelope) === canonicalTaskGraphJson(node)
  })
}
