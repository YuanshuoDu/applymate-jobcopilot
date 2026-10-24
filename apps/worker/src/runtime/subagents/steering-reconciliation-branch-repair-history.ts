import type pg from "pg"
import { validateTaskGraphBranchReplacement } from "../planning/task-graph-branch-replacement.js"
import type { TaskGraphNodeProposal } from "../planning/task-graph.js"
import type { TaskGraphVerificationContract } from "../planning/task-graph-verification.js"
import { canonicalTaskGraphJson, parseTaskGraphEvent, parseTaskGraphSnapshot, taskGraphItemId, taskGraphLifecycleKey,
  type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { parseTaskGraphBranchRepairRelation, taskGraphBranchRepairFingerprint, type TaskGraphBranchRepairRelation } from "./task-graph-pg-branch-repair-relation.js"
import { steeringReconciliationIdempotencyKey, validSteeringReconciliationToolCall, type SteeringReconciliationScope } from "./steering-reconciliation-contract.js"
import type { TaskGraphBranchReplacement } from "../planning/task-graph-branch-replacement.js"
import type { TaskGraphScheduleReceipt } from "./task-graph-command-port.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type BranchCall = Readonly<{ sequence: bigint; fingerprint: string; nodes: readonly TaskGraphNodeProposal[]; rootSuccessCriteria?: readonly string[] }>
const MAX_SEQUENCE = 9_223_372_036_854_775_807n

function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const prototype = Object.getPrototypeOf(parsed)
  return prototype === Object.prototype || prototype === null ? parsed as Row : null
}
function exact(value: Row | null, keys: readonly string[]): value is Row {
  return value !== null && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.trim() === value }
function seq(value: unknown): bigint | null {
  if (typeof value === "bigint") return value > 0n && value <= MAX_SEQUENCE ? value : null
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? BigInt(value) : null
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) return null
  const parsed = BigInt(value)
  return parsed <= MAX_SEQUENCE ? parsed : null
}
function mismatch(): never { throw new Error("steering_reconciliation_branch_repair_event_invalid") }

async function readBranchCall(client: Client, scope: SteeringReconciliationScope, callId: string, expectedRevision: number,
  replaceBranch: TaskGraphBranchReplacement): Promise<BranchCall> {
  if (!scope.stepId) mismatch()
  const result = await client.query<Row>(`SELECT event."id" AS "eventId", event."sequence" AS "eventSequence", event."type", event."actor", event."taskId" AS "eventTaskId", event."itemId" AS "eventItemId", event."correlationId", event."idempotencyKey", event."payload",
      item."id" AS "callItemId", item."stepId", item."taskId" AS "itemTaskId", item."type" AS "itemType", item."content" AS "itemContent"
    FROM "agent_events" AS event JOIN "agent_items" AS item ON item."id" = event."itemId" AND item."sessionId" = event."sessionId" AND item."turnId" = event."turnId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = 'tool_call.started' AND event."taskId" = $3
      AND event."correlationId" = $4 AND item."taskId" = $3 AND item."type" = 'tool_call' AND item."stepId" = $5 LIMIT 2`,
  [scope.sessionId, scope.turnId, scope.rootTaskId, callId, scope.stepId])
  const row = result.rows.length === 1 ? result.rows[0]! : null
  const event: Row = row ? { id: row.eventId, sequence: row.eventSequence, type: row.type, actor: row.actor, taskId: row.eventTaskId,
    itemId: row.eventItemId, correlationId: row.correlationId, idempotencyKey: row.idempotencyKey, payload: row.payload } : {}
  const item: Row = row ? { id: row.callItemId, stepId: row.stepId, taskId: row.itemTaskId, type: row.itemType, content: row.itemContent } : {}
  const content = object(item.content), input = object(content?.input), sequence = seq(row?.eventSequence)
  if (!row || sequence === null || !validSteeringReconciliationToolCall(event, item, scope, scope.stepId, "revise", expectedRevision,
    undefined, replaceBranch) || !Array.isArray(input?.nodes)) mismatch()
  const branch = input.replaceBranch, rootSuccessCriteria = Array.isArray(input.rootSuccessCriteria) ? input.rootSuccessCriteria as string[] : undefined
  const fingerprint = taskGraphBranchRepairFingerprint({ expectedRevision, replaceBranch, nodes: input.nodes as unknown[],
    ...(rootSuccessCriteria ? { rootSuccessCriteria } : {}) })
  if (canonicalTaskGraphJson(branch) !== canonicalTaskGraphJson(replaceBranch)) mismatch()
  return { sequence, fingerprint, nodes: input.nodes as TaskGraphNodeProposal[], ...(rootSuccessCriteria ? { rootSuccessCriteria } : {}) }
}

export async function assertTaskGraphBranchRepairToolCall(client: Client, scope: SteeringReconciliationScope, callId: string,
  expectedRevision: number, replaceBranch: TaskGraphBranchReplacement): Promise<BranchCall> {
  return readBranchCall(client, scope, callId, expectedRevision, replaceBranch)
}

export async function assertTaskGraphBranchRepairCall(client: Client, scope: SteeringReconciliationScope, relation: TaskGraphBranchRepairRelation,
  expectedFingerprint = relation.replacementFingerprint): Promise<BranchCall> {
  if (!scope.stepId || relation.graphRootTaskId !== scope.rootTaskId || relation.agentPlanCall.stepId !== scope.stepId
    || relation.operationKey !== steeringReconciliationIdempotencyKey({ ...scope, stepId: scope.stepId }, relation.agentPlanCall.callId)) mismatch()
  const call = await readBranchCall(client, scope, relation.agentPlanCall.callId, relation.observedRevision, relation.agentPlanCall.replaceBranch)
  if (call.fingerprint !== expectedFingerprint) mismatch()
  return call
}

export async function assertTaskGraphBranchRepairHistory(client: Client, scope: SteeringReconciliationScope,
  relation: TaskGraphBranchRepairRelation, receiptEvent: Readonly<{ id: string; sequence: bigint }>): Promise<TaskGraphScheduleReceipt> {
  if (!scope.stepId || relation.graphRootTaskId !== scope.rootTaskId || !id(receiptEvent.id) || receiptEvent.sequence <= 0n
    || relation.operationKey !== steeringReconciliationIdempotencyKey({ ...scope, stepId: scope.stepId }, relation.agentPlanCall.callId)
    || parseTaskGraphBranchRepairRelation(relation) === null) mismatch()
  const ids = [...relation.sources.map(source => source.cancellationEvent.id), relation.planEvent.id]
  if (new Set(ids).size !== ids.length || ids.includes(receiptEvent.id)) mismatch()
  const result = await client.query<Row>(`SELECT event."id", event."itemId", event."taskId", event."type", event."actor", event."correlationId", event."causationId", event."sequence", event."idempotencyKey", event."payload",
      EXISTS (SELECT 1 FROM "agent_outbox" outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id") AS "hasOutbox"
    FROM "agent_events" AS event WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."id" = ANY($3::text[])
    ORDER BY event."sequence", event."id" LIMIT ${ids.length + 1}`, [scope.sessionId, scope.turnId, ids])
  if (result.rows.length !== ids.length) mismatch()
  const byId = new Map(result.rows.map(row => [String(row.id), row])), firstPayload = object(byId.get(ids[0]!)?.payload)
  const firstItem = object(firstPayload?.item)
  let before: TaskGraphSnapshot
  try { before = parseTaskGraphSnapshot(firstItem?.content) } catch { return mismatch() }
  const call = await assertTaskGraphBranchRepairCall(client, scope, relation)
  if (call.sequence >= BigInt(relation.sources[0]!.cancellationEvent.sequence)) mismatch()
  const validation = validateTaskGraphBranchReplacement({ snapshot: before, replaceBranch: relation.agentPlanCall.replaceBranch,
    proposal: { expectedRevision: relation.observedRevision, nodes: call.nodes },
    ...(call.rootSuccessCriteria ? { proposedRootSuccessCriteria: call.rootSuccessCriteria } : {}) })
  if (!validation.ok || validation.value.sourceNodes.length !== relation.sources.length
    || validation.value.sourceNodes.some((source, index) => {
      const binding = relation.sources[index]
      return !binding || binding.source.nodeKey !== source.key || binding.source.taskId !== source.taskId
        || binding.replacementKey !== validation.value.sourceToReplacementKey.get(source.key)
    })) mismatch()
  for (const [index, binding] of relation.sources.entries()) {
    const row = byId.get(binding.cancellationEvent.id), eventSequence = seq(row?.sequence), payload = object(row?.payload)
    const item = object(payload?.item), event = parseTaskGraphEvent(payload?.event), source = before.nodes.find(node => node.key === binding.source.nodeKey)
    if (!row || !source || eventSequence?.toString() !== binding.cancellationEvent.sequence
      || row.itemId !== taskGraphItemId(scope.rootTaskId) || row.taskId !== binding.source.taskId || row.type !== "item.delta"
      || row.actor !== "system" || row.correlationId !== scope.turnId || row.causationId !== relation.agentPlanCall.stepId
      || row.idempotencyKey !== taskGraphLifecycleKey(scope.rootTaskId, binding.source.nodeKey, 0, "task.cancelled") || row.hasOutbox !== true
      || payload?.kind !== "lifecycle" || payload.revision !== relation.observedRevision + index + 1
      || event?.type !== "task.cancelled" || event.nodeKey !== binding.source.nodeKey || event.expectedRevision !== relation.observedRevision + index
      || item?.id !== taskGraphItemId(scope.rootTaskId) || item.sessionId !== scope.sessionId || item.turnId !== scope.turnId
      || item.taskId !== scope.rootTaskId || item.type !== "task_graph" || item.revision !== relation.observedRevision + index + 1
      || canonicalTaskGraphJson(item.content) !== canonicalTaskGraphJson(before)) mismatch()
  }
  const planRow = byId.get(relation.planEvent.id), planSequence = seq(planRow?.sequence), planPayload = object(planRow?.payload)
  const planItem = object(planPayload?.item), planSnapshot = parseSnapshot(planItem?.content)
  const receipt = parseScheduleReceipt(planPayload?.receipt)
  if (!planRow || !planSnapshot || !receipt || planSequence?.toString() !== relation.planEvent.sequence
    || planSequence <= BigInt(relation.sources.at(-1)!.cancellationEvent.sequence) || planSequence >= receiptEvent.sequence
    || planRow.itemId !== taskGraphItemId(scope.rootTaskId) || planRow.taskId !== scope.rootTaskId || planRow.type !== "item.delta"
    || planRow.actor !== "orchestrator" || planRow.correlationId !== scope.turnId || planRow.causationId !== relation.agentPlanCall.stepId
    || planRow.idempotencyKey !== relation.planEvent.idempotencyKey || planRow.hasOutbox !== true || planPayload?.kind !== "proposal"
    || planPayload.fingerprint !== relation.replacementFingerprint || planPayload.revision !== relation.resultingRevision
    || Object.hasOwn(planPayload, "operationKey") || Object.hasOwn(planPayload, "observedRevision")
    || planItem?.id !== taskGraphItemId(scope.rootTaskId) || planItem.sessionId !== scope.sessionId || planItem.turnId !== scope.turnId
    || planItem.taskId !== scope.rootTaskId || planItem.type !== "task_graph" || planItem.revision !== relation.resultingRevision
    || canonicalTaskGraphJson(planPayload.content) !== canonicalTaskGraphJson(planItem.content)
    || !branchDeltaMatches(before, planSnapshot, validation.value.sourceNodes, validation.value.sourceToReplacementKey,
      validation.value.replacementNodes, receipt, relation)) mismatch()
  return receipt
}

function parseSnapshot(value: unknown): TaskGraphSnapshot | null { try { return parseTaskGraphSnapshot(value) } catch { return null } }
function parseScheduleReceipt(value: unknown): TaskGraphScheduleReceipt | null {
  const receipt = object(value)
  if (!receipt || Object.keys(receipt).sort().join(",") !== "nodes,readyTaskIds,revision,status" || receipt.status !== "accepted"
    || !Number.isSafeInteger(receipt.revision) || !Array.isArray(receipt.nodes) || !Array.isArray(receipt.readyTaskIds)) return null
  if (receipt.nodes.some(node => { const row = object(node); return !row || Object.keys(row).sort().join(",") !== "key,status,taskId"
    || !id(row.key) || !id(row.taskId) || row.status !== "queued" && row.status !== "waiting" })) return null
  if (!receipt.readyTaskIds.every(id) || new Set(receipt.readyTaskIds).size !== receipt.readyTaskIds.length) return null
  return receipt as unknown as TaskGraphScheduleReceipt
}
function branchDeltaMatches(before: TaskGraphSnapshot, after: TaskGraphSnapshot, sources: readonly StoredTaskGraphNode[], mapping: ReadonlyMap<string, string>, proposals: readonly unknown[], receipt: TaskGraphScheduleReceipt, relation: TaskGraphBranchRepairRelation): boolean {
  const oldKeys = new Set(sources.map(source => source.key)), oldIds = new Set(sources.map(source => source.taskId))
  const retained = before.nodes.filter(node => !oldKeys.has(node.key)), newNodes = after.nodes.filter(node => !before.nodes.some(old => old.key === node.key))
  if (after.nodes.length !== retained.length + sources.length || newNodes.length !== sources.length || receipt.revision !== relation.resultingRevision
    || canonicalTaskGraphJson(before.rootSuccessCriteria ?? null) !== canonicalTaskGraphJson(after.rootSuccessCriteria ?? null)
    || receipt.nodes.length !== sources.length || receipt.nodes.some(node => !mapping.has(sources.find(source => mapping.get(source.key) === node.key)?.key ?? ""))) return false
  if (retained.some(old => { const current = after.nodes.find(node => node.key === old.key); return !current || canonicalTaskGraphJson(old) !== canonicalTaskGraphJson(current) })) return false
  for (const source of sources) {
    const key = mapping.get(source.key), replacement = key && after.nodes.find(node => node.key === key), proposal = proposals.find(node => object(node)?.key === key)
    const receiptNode = receipt.nodes.find(node => node.key === key)
    if (!replacement || !proposal || !receiptNode || oldIds.has(replacement.taskId) || replacement.verificationDisposition !== "typed"
      || !sameProposal(replacement, proposal) || !branchEnvelopeMatches(source, replacement, mapping)
      || receiptNode.taskId !== replacement.taskId) return false
  }
  return !after.nodes.some(node => oldKeys.has(node.key) || oldIds.has(node.taskId))
}
function sameProposal(stored: TaskGraphSnapshot["nodes"][number], proposed: unknown): boolean {
  const row = object(proposed)
  if (!row) return false
  const { depth: _depth, taskId: _taskId, verificationDisposition: _disposition, registeredScoutEnvelope: _scout, ...node } = stored
  return canonicalTaskGraphJson(node) === canonicalTaskGraphJson(row)
}
function remapVerification(value: TaskGraphVerificationContract | undefined, mapping: ReadonlyMap<string, string>): TaskGraphVerificationContract | undefined {
  if (!value) return value
  return { ...value, criteria: value.criteria.map(criterion => {
    const check = criterion.check
    if (check.kind !== "findings_from_scout_dependency" && check.kind !== "findings_cover_scout_candidates_gte") return criterion
    const dependencyNodeKey = mapping.get(check.dependencyNodeKey)
    return dependencyNodeKey ? { ...criterion, check: { ...check, dependencyNodeKey } } : criterion
  }) }
}
function branchEnvelopeMatches(source: StoredTaskGraphNode, replacement: StoredTaskGraphNode, mapping: ReadonlyMap<string, string>): boolean {
  const normalized = { ...source, dependsOn: source.dependsOn.map(key => mapping.get(key) ?? key),
    verification: remapVerification(source.verification, mapping) }
  const envelope = (node: StoredTaskGraphNode) => {
    const { key: _key, taskId: _taskId, goal: _goal, successCriteria: _criteria, ...immutable } = node
    return immutable
  }
  return canonicalTaskGraphJson(envelope(normalized)) === canonicalTaskGraphJson(envelope(replacement))
}
