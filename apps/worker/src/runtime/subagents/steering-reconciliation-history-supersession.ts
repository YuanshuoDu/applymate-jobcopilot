import type pg from "pg"
import { steeringReconciliationId, steeringReconciliationSequence, type SteeringReconciliationScope } from "./steering-reconciliation-contract.js"
import { canonicalTaskGraphJson, parseTaskGraphEvent, parseTaskGraphSnapshot, taskGraphItemId, taskGraphLifecycleKey, type StoredTaskGraphNode } from "./task-graph-snapshot.js"
import { taskGraphSupersessionProposalKey, type TaskGraphSupersessionRelation } from "./task-graph-pg-supersession.js"
import { taskGraphSupersessionEnvelopeMatches } from "./task-graph-pg-events.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
export type VerifiedSupersession = Readonly<{ source: StoredTaskGraphNode; replacement: StoredTaskGraphNode }>

function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const prototype = Object.getPrototypeOf(parsed)
  return prototype === Object.prototype || prototype === null ? parsed as Row : null
}

export async function assertSteeringReconciliationSupersessionEvents(client: Client, scope: SteeringReconciliationScope,
  bindings: readonly Readonly<{ relation: TaskGraphSupersessionRelation; receiptEventId?: string; receiptSequence?: bigint }>[]): Promise<Map<string, VerifiedSupersession>> {
  const replacements = new Map<string, VerifiedSupersession>()
  if (!bindings.length) return replacements
  const eventIds = bindings.flatMap(binding => [binding.relation.cancellationEvent.id, binding.relation.planEvent.id])
  if (new Set(eventIds).size !== eventIds.length || bindings.some(binding => binding.receiptEventId !== undefined
    ? !steeringReconciliationId(binding.receiptEventId) || binding.receiptSequence === undefined || binding.receiptSequence <= 0n
    : binding.receiptSequence !== undefined)
    || bindings.some(binding => binding.receiptEventId !== undefined && eventIds.includes(binding.receiptEventId))) {
    throw new Error("steering_reconciliation_supersession_event_invalid")
  }
  const result = await client.query<Row>(`SELECT event."id", event."itemId", event."taskId", event."type", event."actor", event."correlationId", event."causationId", event."sequence", event."idempotencyKey", event."payload",
      EXISTS (SELECT 1 FROM "agent_outbox" AS outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id") AS "hasOutbox"
    FROM "agent_events" AS event WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."id" = ANY($3::text[])
    ORDER BY "sequence", "id" LIMIT ${eventIds.length + 1}`, [scope.sessionId, scope.turnId, eventIds])
  if (result.rows.length !== eventIds.length) throw new Error("steering_reconciliation_supersession_event_invalid")
  const byId = new Map(result.rows.map(row => [String(row.id), row]))
  for (const binding of bindings) {
    const relation = binding.relation, cancel = byId.get(relation.cancellationEvent.id), plan = byId.get(relation.planEvent.id)
    const cancelSequence = cancel ? steeringReconciliationSequence(cancel.sequence) : null
    const planSequence = plan ? steeringReconciliationSequence(plan.sequence) : null
    const receiptSequence = binding.receiptSequence
    const cancelledSnapshot = cancel && validCancellationEvent(cancel, scope, relation)
    const replacement = plan && cancelledSnapshot && validPlanEvent(plan, scope, relation, cancelledSnapshot)
    if (!cancel || !plan || cancelSequence?.toString() !== relation.cancellationEvent.sequence
      || planSequence?.toString() !== relation.planEvent.sequence || cancelSequence === null || planSequence === null || cancelSequence >= planSequence
      || receiptSequence !== undefined && planSequence >= receiptSequence
      || !cancelledSnapshot || !replacement || replacements.has(relation.agentPlanCall.callId)) {
      throw new Error("steering_reconciliation_supersession_event_invalid")
    }
    const source = cancelledSnapshot.nodes.find(node => node.key === relation.source.nodeKey && node.taskId === relation.source.taskId)
    if (!source) throw new Error("steering_reconciliation_supersession_event_invalid")
    replacements.set(relation.agentPlanCall.callId, { source, replacement })
  }
  return replacements
}

function validCancellationEvent(row: Row, scope: SteeringReconciliationScope, relation: TaskGraphSupersessionRelation): ReturnType<typeof parseTaskGraphSnapshot> | null {
  const payload = object(row.payload), event = parseTaskGraphEvent(payload?.event), item = object(payload?.item)
  const key = taskGraphLifecycleKey(scope.rootTaskId, relation.source.nodeKey, 0, "task.cancelled")
  if (!(row.hasOutbox === true && row.itemId === taskGraphItemId(scope.rootTaskId) && row.taskId === relation.source.taskId && row.type === "item.delta"
    && row.actor === "system" && row.correlationId === scope.turnId && row.causationId === relation.agentPlanCall.stepId
    && row.idempotencyKey === key && payload?.kind === "lifecycle" && payload.revision === relation.cancellationRevision
    && event?.type === "task.cancelled" && event.nodeKey === relation.source.nodeKey
    && event.expectedRevision === relation.observedRevision && event.idempotencyKey === key
    && item?.id === taskGraphItemId(scope.rootTaskId) && item.sessionId === scope.sessionId && item.turnId === scope.turnId
    && item.taskId === scope.rootTaskId && item.type === "task_graph" && item.revision === relation.cancellationRevision)) return null
  try {
    const snapshot = parseTaskGraphSnapshot(item?.content)
    const source = snapshot.nodes.find(node => node.key === relation.source.nodeKey)
    return source?.taskId === relation.source.taskId && !snapshot.nodes.some(node => node.key === relation.replacement.nodeKey
      || node.taskId === relation.replacement.taskId) ? snapshot : null
  } catch { return null }
}

function validPlanEvent(row: Row, scope: SteeringReconciliationScope, relation: TaskGraphSupersessionRelation,
  before: ReturnType<typeof parseTaskGraphSnapshot>): StoredTaskGraphNode | null {
  const payload = object(row.payload), item = object(payload?.item)
  let snapshot: ReturnType<typeof parseTaskGraphSnapshot>
  try { snapshot = parseTaskGraphSnapshot(item?.content) } catch { return null }
  const replacement = snapshot.nodes.find(node => node.key === relation.replacement.nodeKey)
  const source = before.nodes.find(node => node.key === relation.source.nodeKey && node.taskId === relation.source.taskId)
  const unchanged = before.nodes.filter(node => node !== source)
  const unchangedInFinal = snapshot.nodes.filter(node => node.key !== relation.replacement.nodeKey)
  const exactDelta = Boolean(source && unchanged.length === unchangedInFinal.length
    && unchanged.every(oldNode => {
      const current = snapshot.nodes.find(node => node.key === oldNode.key)
      return current?.taskId === oldNode.taskId && canonicalTaskGraphJson(current) === canonicalTaskGraphJson(oldNode)
    }) && replacement && sameReplacementEnvelope(source, replacement, snapshot.nodes))
  const valid = Boolean(row.hasOutbox === true && row.itemId === taskGraphItemId(scope.rootTaskId) && row.taskId === scope.rootTaskId && row.type === "item.delta"
    && row.actor === "orchestrator" && row.correlationId === scope.turnId && row.causationId === relation.agentPlanCall.stepId
    && row.idempotencyKey === taskGraphSupersessionProposalKey(scope.rootTaskId, relation.observedRevision)
    && row.idempotencyKey === relation.planEvent.idempotencyKey
    && payload?.kind === "proposal" && payload.observedRevision === relation.observedRevision && payload.operationKey === relation.operationKey
    && payload.fingerprint === relation.replacementFingerprint && payload.revision === relation.resultingRevision
    && validSupersessionScheduleReceipt(payload?.receipt, relation) && item?.id === taskGraphItemId(scope.rootTaskId)
    && item.sessionId === scope.sessionId && item.turnId === scope.turnId && item.taskId === scope.rootTaskId
    && item.type === "task_graph" && item.revision === relation.resultingRevision && payload.content !== undefined
    && canonicalTaskGraphJson(payload.content) === canonicalTaskGraphJson(item.content)
    && replacement?.taskId === relation.replacement.taskId
    && !snapshot.nodes.some(node => node.key === relation.source.nodeKey || node.taskId === relation.source.taskId)
    && exactDelta)
  return valid ? replacement ?? null : null
}

function validSupersessionScheduleReceipt(value: unknown, relation: TaskGraphSupersessionRelation): boolean {
  const receipt = object(value), node = Array.isArray(receipt?.nodes) && receipt.nodes.length === 1 ? object(receipt.nodes[0]) : null
  const ready = receipt?.readyTaskIds
  return Boolean(receipt && exactAllowed(receipt, ["status", "revision", "nodes", "readyTaskIds"], []) && receipt.status === "accepted"
    && receipt.revision === relation.resultingRevision && node && exactAllowed(node, ["key", "taskId", "status"], [])
    && node.key === relation.replacement.nodeKey && node.taskId === relation.replacement.taskId
    && (node.status === "queued" ? Array.isArray(ready) && ready.length === 1 && ready[0] === node.taskId
      : node.status === "waiting" && Array.isArray(ready) && ready.length === 0))
}

const PROPOSAL_NODE_KEYS = ["dependsOn", "goal", "key", "successCriteria", "templateId"] as const
export function normalizedProposalNode(inputValue: unknown, rootTaskId: string): Row | null {
  const input = object(inputValue)
  if (!input || !exactAllowed(input, PROPOSAL_NODE_KEYS, ["repairOf", "verification"])) return null
  const proposal: Row = Object.fromEntries([...PROPOSAL_NODE_KEYS.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]])])
  for (const key of ["verification"] as const) if (Object.hasOwn(input, key)) proposal[key] = input[key]
  if (Object.hasOwn(input, "repairOf")) {
    const repair = object(input.repairOf)
    if (!repair || !exactAllowed(repair, ["criterionIds", "nodeKey", "taskId"], ["graphRootTaskId"])
      || repair.graphRootTaskId !== undefined && repair.graphRootTaskId !== rootTaskId) return null
    proposal.repairOf = { ...repair, graphRootTaskId: rootTaskId }
  }
  return proposal
}

export function sameProposalNode(proposal: Row, stored: StoredTaskGraphNode): boolean {
  const storedRow = object(stored)
  if (!storedRow || !exactAllowed(storedRow, PROPOSAL_NODE_KEYS, ["depth", "repairOf", "registeredScoutEnvelope", "taskId", "verification", "verificationDisposition"])) return false
  const finalProposal = Object.fromEntries([...PROPOSAL_NODE_KEYS.filter(key => Object.hasOwn(storedRow, key)).map(key => [key, storedRow[key]])])
  for (const key of ["verification", "repairOf"] as const) if (Object.hasOwn(storedRow, key)) finalProposal[key] = storedRow[key]
  return canonicalTaskGraphJson(proposal) === canonicalTaskGraphJson(finalProposal)
}

function exactAllowed(value: Row, required: readonly string[], optional: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value), allowed = new Set([...required, ...optional]), descriptors = Object.getOwnPropertyDescriptors(value)
  return keys.length === Object.keys(value).length && keys.every(key => typeof key === "string" && allowed.has(key)
    && Boolean(descriptors[key]?.enumerable && "value" in descriptors[key]!)) && required.every(key => Object.hasOwn(value, key))
}

function sameReplacementEnvelope(source: unknown, replacement: unknown, graphNodes: readonly StoredTaskGraphNode[]): boolean {
  return taskGraphSupersessionEnvelopeMatches(source, replacement, true, graphNodes)
}
