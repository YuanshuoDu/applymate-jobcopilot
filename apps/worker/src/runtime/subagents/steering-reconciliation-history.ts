import type pg from "pg"
import { parseCognitiveAgendaReceipt } from "../turns/cognitive-agenda-receipt.js"
import {
  parseSteeringReconciliationReceipt, steeringReconciliationId, steeringReconciliationIdempotencyKey, steeringReconciliationRevision, steeringReconciliationSequence,
  STEERING_RECONCILIATION_EVENT_TYPE, validSteeringReconciliationScope, validSteeringReconciliationToolCall,
  type SteeringReconciliationReceipt, type SteeringReconciliationScope,
} from "./steering-reconciliation-contract.js"
import { canonicalTaskGraphJson, parseTaskGraphEvent, parseTaskGraphSnapshot, taskGraphItemId, taskGraphLifecycleKey, taskGraphProposalKey, type StoredTaskGraphNode } from "./task-graph-snapshot.js"
import { taskGraphSupersessionFingerprint, taskGraphSupersessionProposalKey, type TaskGraphSupersessionRelation } from "./task-graph-pg-supersession.js"
import type { TaskGraphExecutionScope, TaskGraphReadScope } from "./task-graph-command-port.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type HistoryStep = Readonly<{ id: string; ordinal: number; attempt: number; cursor: bigint }>
export type SteeringReconciliationHistoryEntry = Readonly<{ receipt: SteeringReconciliationReceipt; stepOrdinal: number; stepAttempt: number }>
type ParsedReceipt = Readonly<{ receipt: SteeringReconciliationReceipt; sequence: bigint; id: string; idempotencyKey: string }>
type SupersessionCallBinding = Readonly<{ replaceUnstartedNodeKey: string; replacementFingerprint?: string; source?: TaskGraphSupersessionRelation["source"]; replacementNode?: StoredTaskGraphNode; callId?: string; stepId?: string; operationKey?: string }>
const PAGE_SIZE = 64
const STEP_STATUSES = new Set(["streaming", "waiting_for_tool", "waiting_for_approval", "waiting_for_user", "completed", "failed", "interrupted"])

function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const prototype = Object.getPrototypeOf(parsed)
  return prototype === Object.prototype || prototype === null ? parsed as Row : null
}
function historyStep(row: Row | undefined): HistoryStep | null {
  const cursor = row ? steeringReconciliationSequence(row.inputThroughSequence) : null
  if (!row || !steeringReconciliationId(row.id) || !Number.isSafeInteger(row.ordinal) || Number(row.ordinal) < 0
    || !Number.isSafeInteger(row.attempt) || Number(row.attempt) < 1 || typeof row.status !== "string" || !STEP_STATUSES.has(row.status) || cursor === null) return null
  return { id: row.id, ordinal: Number(row.ordinal), attempt: Number(row.attempt), cursor }
}
function ownerScope(scope: SteeringReconciliationScope): TaskGraphReadScope {
  return { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId,
    turnLeaseOwner: scope.turnLeaseOwner, turnLeaseVersion: scope.turnLeaseVersion, parentLeaseOwner: scope.parentLeaseOwner, parentAttemptCount: scope.parentAttemptCount }
}
function callMatches(row: Row, scope: SteeringReconciliationScope, stepId: string, decision: "keep" | "revise", revision: number,
  binding?: SupersessionCallBinding): boolean {
  const matches = validSteeringReconciliationToolCall({ type: row.type, actor: row.actor, taskId: row.eventTaskId, itemId: row.eventItemId,
    correlationId: row.correlationId, idempotencyKey: row.idempotencyKey, payload: row.payload },
  { id: row.callItemId, stepId: row.stepId, taskId: row.itemTaskId, type: row.itemType, content: row.itemContent }, scope, stepId, decision, revision,
  binding?.replaceUnstartedNodeKey)
  if (!matches || !binding?.replacementFingerprint) return matches
  const content = object(row.itemContent), input = object(content?.input)
  const node = input && Array.isArray(input.nodes) && input.nodes.length === 1 ? normalizedProposalNode(input.nodes[0], scope.rootTaskId) : null
  return Boolean(input && node && binding.source && taskGraphSupersessionFingerprint(binding.source, {
    expectedRevision: revision, replaceUnstartedNodeKey: binding.replaceUnstartedNodeKey, nodes: [node],
  }) === binding.replacementFingerprint && (binding.replacementNode === undefined || sameProposalNode(node, binding.replacementNode)))
}
function toolCallQuery(): string {
  return `SELECT event."id" AS "eventId", event."sequence" AS "eventSequence", event."type", event."actor", event."taskId" AS "eventTaskId", event."itemId" AS "eventItemId", event."correlationId", event."idempotencyKey", event."payload",
      item."id" AS "callItemId", item."stepId", item."taskId" AS "itemTaskId", item."type" AS "itemType", item."content" AS "itemContent"
    FROM "agent_events" AS event JOIN "agent_items" AS item ON item."id" = event."itemId" AND item."sessionId" = event."sessionId" AND item."turnId" = event."turnId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = 'tool_call.started' AND event."taskId" = $3
      AND event."correlationId" = $4 AND item."taskId" = $3 AND item."type" = 'tool_call' AND item."stepId" = $5 LIMIT 2`
}
export async function assertSteeringReconciliationCall(client: Client, scope: TaskGraphExecutionScope, callId: string,
  decision: "keep" | "revise", expectedRevision: number, binding?: SupersessionCallBinding): Promise<bigint | null> {
  if (!validSteeringReconciliationScope(scope) || !steeringReconciliationId(callId) || !steeringReconciliationRevision(expectedRevision)) throw new Error("steering_reconciliation_call_invalid")
  const result = await client.query<Row>(toolCallQuery(), [scope.sessionId, scope.turnId, scope.rootTaskId, callId, scope.stepId])
  const sequence = result.rows.length === 1 ? steeringReconciliationSequence(result.rows[0]!.eventSequence) : null
  if (result.rows.length !== 1 || !callMatches(result.rows[0]!, scope, scope.stepId, decision, expectedRevision, binding)
    || binding && (binding.callId !== undefined && binding.callId !== callId || binding.stepId !== undefined && binding.stepId !== scope.stepId
      || binding.operationKey !== undefined && binding.operationKey !== steeringReconciliationIdempotencyKey(scope, callId)
      || sequence === null)) throw new Error("steering_reconciliation_call_invalid")
  return sequence
}

export async function assertSteeringReconciliationSupersessionEvents(client: Client, scope: SteeringReconciliationScope,
  bindings: readonly Readonly<{ relation: TaskGraphSupersessionRelation; receiptEventId?: string; receiptSequence?: bigint }>[]): Promise<Map<string, StoredTaskGraphNode>> {
  const replacements = new Map<string, StoredTaskGraphNode>()
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
    replacements.set(relation.agentPlanCall.callId, replacement)
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
    }) && replacement && sameReplacementEnvelope(source, replacement))
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
function normalizedProposalNode(inputValue: unknown, rootTaskId: string): Row | null {
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
function sameProposalNode(proposal: Row, stored: StoredTaskGraphNode): boolean {
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

function sameReplacementEnvelope(sourceValue: unknown, replacementValue: unknown): boolean {
  const source = object(sourceValue), replacement = object(replacementValue)
  if (!source || !replacement) return false
  const omitMutable = (node: Row) => Object.fromEntries(Object.entries(node)
    .filter(([key]) => !["key", "taskId", "goal", "successCriteria"].includes(key)))
  return canonicalTaskGraphJson(omitMutable(source)) === canonicalTaskGraphJson(omitMutable(replacement))
}

async function assertHistoryCalls(client: Client, scope: SteeringReconciliationScope, entries: readonly ParsedReceipt[], replacements: ReadonlyMap<string, StoredTaskGraphNode>): Promise<void> {
  const counts = new Map(entries.map(entry => [entry, 0]))
  const byStep = new Map<string, ParsedReceipt[]>()
  for (const entry of entries) byStep.set(entry.receipt.stepId, [...(byStep.get(entry.receipt.stepId) ?? []), entry])
  const stepIds = [...byStep.keys()]
  let afterId: string | null = null
  while (true) {
    const result: { rows: Row[] } = await client.query<Row>(`SELECT event."id" AS "eventId", event."sequence" AS "eventSequence", event."type", event."actor", event."taskId" AS "eventTaskId", event."itemId" AS "eventItemId", event."correlationId", event."idempotencyKey", event."payload",
        item."id" AS "callItemId", item."stepId", item."taskId" AS "itemTaskId", item."type" AS "itemType", item."content" AS "itemContent"
      FROM "agent_events" AS event JOIN "agent_items" AS item ON item."id" = event."itemId" AND item."sessionId" = event."sessionId" AND item."turnId" = event."turnId"
      WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = 'tool_call.started' AND event."taskId" = $3
        AND item."taskId" = $3 AND item."type" = 'tool_call' AND item."stepId" = ANY($4::text[])
        AND ($5::text IS NULL OR event."id" > $5::text) ORDER BY event."id" LIMIT ${PAGE_SIZE}`,
    [scope.sessionId, scope.turnId, scope.rootTaskId, stepIds, afterId])
    if (!result.rows.length) break
    for (const row of result.rows) {
      if (!steeringReconciliationId(row.eventId) || (afterId !== null && String(row.eventId) <= afterId)) throw new Error("steering_reconciliation_receipt_call_invalid")
      afterId = row.eventId
      for (const entry of byStep.get(String(row.stepId)) ?? []) {
        const callId = row.correlationId
        const relation = entry.receipt.supersession
        if (steeringReconciliationId(callId) && (!relation || relation.agentPlanCall.callId === callId)
          && callMatches(row, scope, entry.receipt.stepId, entry.receipt.decision, entry.receipt.observedRevision, relation ? {
            replaceUnstartedNodeKey: relation.agentPlanCall.replaceUnstarted.nodeKey, replacementFingerprint: relation.replacementFingerprint,
          source: relation.source,
            replacementNode: replacements.get(relation.agentPlanCall.callId),
            callId: relation.agentPlanCall.callId, stepId: relation.agentPlanCall.stepId, operationKey: relation.operationKey,
          } : undefined)
          && steeringReconciliationIdempotencyKey({ ...scope, stepId: entry.receipt.stepId }, callId) === entry.idempotencyKey) {
          const callSequence = steeringReconciliationSequence(row.eventSequence)
          if (callSequence === null || callSequence >= entry.sequence || relation && callSequence >= BigInt(relation.cancellationEvent.sequence)) throw new Error("steering_reconciliation_receipt_call_invalid")
          const count = counts.get(entry)! + 1
          if (count > 1) throw new Error("steering_reconciliation_receipt_call_invalid")
          counts.set(entry, count)
        }
      }
    }
  }
  if (entries.some(entry => counts.get(entry) !== 1)) throw new Error("steering_reconciliation_receipt_call_invalid")
}

export async function* readSteeringReconciliationHistory(client: Client, scope: SteeringReconciliationScope,
  currentRevision: number): AsyncGenerator<SteeringReconciliationHistoryEntry> {
  if (!validSteeringReconciliationScope(scope) || !steeringReconciliationRevision(currentRevision)) throw new Error("steering_reconciliation_scope_invalid")
  const expectedScope = ownerScope(scope)
  let afterSequence: bigint | null = null, afterId: string | null = null, previousSequence = -1n
  while (true) {
    const result: { rows: Row[] } = await client.query<Row>(`SELECT event."id", event."itemId", event."taskId", event."type", event."actor", event."correlationId", event."causationId", event."sequence", event."idempotencyKey", event."payload",
        EXISTS (SELECT 1 FROM "agent_outbox" AS outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id") AS "hasOutbox"
      FROM "agent_events" AS event WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = $3
        AND ($4::bigint IS NULL OR event."sequence" > $4::bigint OR (event."sequence" = $4::bigint AND event."id" > $5::text))
      ORDER BY event."sequence" ASC, event."id" ASC LIMIT ${PAGE_SIZE}`,
    [scope.sessionId, scope.turnId, STEERING_RECONCILIATION_EVENT_TYPE, afterSequence?.toString() ?? null, afterId])
    if (!result.rows.length) return
    const parsed: ParsedReceipt[] = result.rows.map((row: Row) => {
      const receipt = parseSteeringReconciliationReceipt(object(row.payload), expectedScope), sequence = steeringReconciliationSequence(row.sequence)
      if (!steeringReconciliationId(row.id) || !receipt || sequence === null || sequence <= previousSequence || row.itemId !== null
        || row.taskId !== scope.rootTaskId || row.type !== STEERING_RECONCILIATION_EVENT_TYPE || row.actor !== "orchestrator"
        || row.correlationId !== scope.turnId || row.causationId !== receipt.stepId || row.hasOutbox !== false
        || typeof row.idempotencyKey !== "string" || !/^agent\.plan\.reconciliation:sha256:[a-f0-9]{64}$/.test(row.idempotencyKey)) throw new Error("steering_reconciliation_receipt_invalid")
      previousSequence = sequence
      if (receipt.supersession && receipt.supersession.operationKey !== row.idempotencyKey) throw new Error("steering_reconciliation_receipt_invalid")
      return { receipt, sequence, id: row.id, idempotencyKey: row.idempotencyKey }
    })
    afterSequence = parsed.at(-1)!.sequence
    afterId = String(result.rows.at(-1)?.id)
    const replacements = await assertSteeringReconciliationSupersessionEvents(client, scope, parsed.flatMap(entry => entry.receipt.supersession
      ? [{ relation: entry.receipt.supersession, receiptEventId: entry.id, receiptSequence: entry.sequence }] : []))
    await assertHistoryCalls(client, scope, parsed, replacements)
    const stepIds = [...new Set(parsed.map(entry => entry.receipt.stepId))]
    const stepRows = await client.query<Row>(`SELECT "id", "taskId", "ordinal", "attempt", "status", "inputThroughSequence" FROM "agent_steps"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "id" = ANY($4::text[])`, [scope.sessionId, scope.turnId, scope.rootTaskId, stepIds])
    if (stepRows.rows.length !== stepIds.length) throw new Error("steering_reconciliation_receipt_step_missing")
    const steps = new Map<string, HistoryStep>()
    for (const row of stepRows.rows) {
      const parsedStep = historyStep(row)
      if (!parsedStep || row.taskId !== scope.rootTaskId || parsedStep.attempt > scope.parentAttemptCount) throw new Error("steering_reconciliation_receipt_step_invalid")
      steps.set(parsedStep.id, parsedStep)
    }
    const agendaRows = await client.query<Row>(`SELECT agenda."actor", agenda."itemId", agenda."taskId", agenda."correlationId", agenda."payload"
      FROM (SELECT event."actor", event."itemId", event."taskId", event."correlationId", event."payload",
          ROW_NUMBER() OVER (PARTITION BY event."correlationId" ORDER BY event."sequence", event."id") AS "historyRank"
        FROM "agent_events" AS event WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = 'cognitive.agenda'
          AND event."taskId" = $3 AND event."itemId" IS NULL AND event."correlationId" = ANY($4::text[])) AS agenda
      WHERE agenda."historyRank" <= 2 ORDER BY agenda."correlationId", agenda."historyRank"`, [scope.sessionId, scope.turnId, scope.rootTaskId, stepIds])
    const agendas = new Map<string, number>()
    for (const row of agendaRows.rows) {
      const id = String(row.correlationId), agenda = parseCognitiveAgendaReceipt(object(row.payload), { sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId, stepId: id })
      if (!agenda || row.itemId !== null || row.taskId !== scope.rootTaskId || !["subagent", "orchestrator"].includes(String(row.actor)) || agendas.has(id)) throw new Error("steering_reconciliation_agenda_invalid")
      agendas.set(id, agenda.planRevision ?? -1)
    }
    if (agendas.size !== stepIds.length) throw new Error("steering_reconciliation_agenda_missing")
    const entries = parsed.map(entry => {
      const step = steps.get(entry.receipt.stepId)
      if (!step || agendas.get(step.id) !== entry.receipt.observedRevision || step.cursor.toString() !== entry.receipt.inputCheckpoint.throughSequence
        || entry.receipt.resultingRevision > currentRevision) throw new Error("steering_reconciliation_receipt_history_invalid")
      return { receipt: entry.receipt, stepOrdinal: step.ordinal, stepAttempt: step.attempt }
    })
    for (const entry of entries) yield entry
  }
}
