import type pg from "pg"
import {
  parseSteeringReconciliationReceipt, steeringReconciliationIdempotencyKey, steeringReconciliationRevision,
  steeringReconciliationId, steeringReconciliationSequence, STEERING_RECONCILIATION_EVENT_TYPE,
  STEERING_RECONCILIATION_SUPERSESSION_SCHEMA_VERSION,
  type PreparedSteeringReconciliation, type SteeringReconciliationOperation, type SteeringReconciliationReceipt,
} from "./steering-reconciliation-contract.js"
import { assertNoUnresolvedSteering, readSteeringReconciliationState } from "./steering-reconciliation-read.js"
import { assertSteeringReconciliationCall, assertSteeringReconciliationSupersessionEvents } from "./steering-reconciliation-history.js"
import { appendTaskGraphReceipt } from "./task-graph-pg-events.js"
import type { GraphEventScope } from "./task-graph-pg-state.js"
import { parseTaskGraphSupersessionRelation, type TaskGraphSupersessionRelation } from "./task-graph-pg-supersession.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : null
}
function receiptFor(operation: SteeringReconciliationOperation, inputIds: readonly string[], through: bigint): SteeringReconciliationReceipt {
  const resultingRevision = operation.decision === "keep" ? operation.expectedRevision : operation.expectedRevision + 1
  return { schemaVersion: "agent-harness.v2.plan-reconciliation.v1", sessionId: operation.scope.sessionId,
    turnId: operation.scope.turnId, rootTaskId: operation.scope.rootTaskId, stepId: operation.scope.stepId,
    decision: operation.decision, observedRevision: operation.expectedRevision, resultingRevision,
    steerInputIds: [...inputIds].sort(), inputCheckpoint: { throughSequence: through.toString() } }
}
function operationKeyMatches(row: Row, operation: SteeringReconciliationOperation, key: string): SteeringReconciliationReceipt {
  const receipt = parseSteeringReconciliationReceipt(object(row.payload), operation.scope)
  if (!receipt || row.turnId !== operation.scope.turnId || row.type !== STEERING_RECONCILIATION_EVENT_TYPE || row.itemId !== null || row.taskId !== operation.scope.rootTaskId
    || row.actor !== "orchestrator" || row.correlationId !== operation.scope.turnId || row.causationId !== operation.scope.stepId
    || row.idempotencyKey !== key || row.hasOutbox !== false || receipt.decision !== operation.decision
    || receipt.observedRevision !== operation.expectedRevision
    || operation.replaceUnstartedNodeKey === undefined && receipt.supersession !== undefined
    || operation.replaceUnstartedNodeKey !== undefined && (!receipt.supersession
      || receipt.supersession.operationKey !== key || receipt.supersession.agentPlanCall.callId !== operation.callId
      || receipt.supersession.agentPlanCall.stepId !== operation.scope.stepId
      || receipt.supersession.agentPlanCall.replaceUnstarted.nodeKey !== operation.replaceUnstartedNodeKey)) throw new Error("steering_reconciliation_idempotency_conflict")
  return receipt
}
async function existingReceipt(client: Client, operation: SteeringReconciliationOperation, key: string): Promise<Row | null> {
  const result = await client.query<Row>(`SELECT event."id", event."sequence", event."turnId", event."itemId", event."taskId", event."type", event."actor", event."correlationId", event."causationId",
      event."idempotencyKey", event."payload", EXISTS (SELECT 1 FROM "agent_outbox" AS outbox
        WHERE outbox."idempotencyKey" = 'agent-event:' || event."id") AS "hasOutbox"
    FROM "agent_events" AS event WHERE event."sessionId" = $1 AND event."idempotencyKey" = $2 LIMIT 2`,
  [operation.scope.sessionId, key])
  if (result.rows.length > 1) throw new Error("steering_reconciliation_idempotency_conflict")
  return result.rows[0] ?? null
}
function prepared(operation: SteeringReconciliationOperation, receipt: SteeringReconciliationReceipt, key: string): PreparedSteeringReconciliation {
  return { scope: operation.scope, callId: operation.callId, decision: operation.decision, expectedRevision: operation.expectedRevision,
    resultingRevision: receipt.resultingRevision, steerInputIds: receipt.steerInputIds,
    inputThroughSequence: BigInt(receipt.inputCheckpoint.throughSequence), idempotencyKey: key, receipt }
}

export async function prepareSteeringReconciliation(client: Client, operation: SteeringReconciliationOperation): Promise<PreparedSteeringReconciliation | null> {
  const { scope, expectedRevision, callId, decision } = operation
  const key = steeringReconciliationIdempotencyKey(scope, callId)
  if (!key || !steeringReconciliationRevision(expectedRevision) || decision !== "keep" && decision !== "revise") throw new Error("steering_reconciliation_operation_invalid")
  const state = await readSteeringReconciliationState(client, { ...scope, rootInputId: operation.rootInputId })
  await assertSteeringReconciliationCall(client, scope, callId, decision, expectedRevision, operation.replaceUnstartedNodeKey === undefined ? undefined : {
    replaceUnstartedNodeKey: operation.replaceUnstartedNodeKey, callId, stepId: scope.stepId, operationKey: key,
  })
  if (state.decisionStepId !== scope.stepId || state.agendaPlanRevision !== expectedRevision) throw new Error("steering_reconciliation_agenda_revision_conflict")
  const prior = await existingReceipt(client, operation, key)
  if (prior) {
    const receipt = operationKeyMatches(prior, operation, key)
    if (state.currentRevision < receipt.resultingRevision || state.decisionInputThroughSequence?.toString() !== receipt.inputCheckpoint.throughSequence) throw new Error("steering_reconciliation_idempotency_conflict")
    if (receipt.supersession) await validateSupersession(client, scope, receipt.supersession, prior)
    return prepared(operation, receipt, key)
  }
  if (state.currentRevision !== expectedRevision) throw new Error("steering_reconciliation_revision_conflict")
  if (state.unresolvedInputs.length === 0) return null
  if (state.decisionInputThroughSequence === null || state.unresolvedInputs.some(input => input.status !== "consumed" || !input.consumedByStepId
    || input.acceptedSequence > state.decisionInputThroughSequence!)) throw new Error("steering_reconciliation_unconsumed_input")
  const value = receiptFor(operation, state.unresolvedInputs.map(input => input.id), state.decisionInputThroughSequence)
  if (!parseSteeringReconciliationReceipt(value, scope)) throw new Error("steering_reconciliation_receipt_invalid")
  return prepared(operation, value, key)
}

function matchesPrepared(state: Awaited<ReturnType<typeof readSteeringReconciliationState>>, operation: SteeringReconciliationOperation, value: PreparedSteeringReconciliation): boolean {
  return state.decisionStepId === operation.scope.stepId && state.agendaPlanRevision === operation.expectedRevision
    && state.decisionInputThroughSequence === value.inputThroughSequence
    && state.unresolvedInputs.every(input => input.status === "consumed" && input.consumedByStepId !== null && input.acceptedSequence <= value.inputThroughSequence)
    && [...state.unresolvedInputs.map(input => input.id)].sort().join("\0") === [...value.steerInputIds].join("\0")
}
function sameReceipt(actual: unknown, expected: SteeringReconciliationReceipt): boolean {
  const parsed = parseSteeringReconciliationReceipt(object(actual))
  return Boolean(parsed && JSON.stringify(parsed) === JSON.stringify(expected))
}

function relationReceipt(base: SteeringReconciliationReceipt, relation: TaskGraphSupersessionRelation): SteeringReconciliationReceipt {
  return { ...base, schemaVersion: STEERING_RECONCILIATION_SUPERSESSION_SCHEMA_VERSION,
    resultingRevision: relation.resultingRevision, supersession: relation }
}

async function validateSupersession(client: Client, scope: SteeringReconciliationOperation["scope"], relation: TaskGraphSupersessionRelation,
  receiptEvent?: Row): Promise<void> {
  const receiptSequence = receiptEvent ? steeringReconciliationSequence(receiptEvent.sequence) : null
  if (receiptEvent && (!steeringReconciliationId(receiptEvent.id) || receiptSequence === null)) throw new Error("steering_reconciliation_supersession_event_invalid")
  const sequence = await assertSteeringReconciliationCall(client, scope, relation.agentPlanCall.callId, "revise", relation.observedRevision, {
    replaceUnstartedNodeKey: relation.agentPlanCall.replaceUnstarted.nodeKey, replacementFingerprint: relation.replacementFingerprint,
    source: relation.source,
    callId: relation.agentPlanCall.callId, stepId: relation.agentPlanCall.stepId, operationKey: relation.operationKey,
  })
  if (sequence === null || sequence >= BigInt(relation.cancellationEvent.sequence)) throw new Error("steering_reconciliation_call_invalid")
  await assertSteeringReconciliationSupersessionEvents(client, scope, [{ relation, ...(receiptEvent
    ? { receiptEventId: receiptEvent.id as string, receiptSequence: receiptSequence! } : {}) }])
}

export async function writeSteeringReconciliationReceipt(client: Client, value: PreparedSteeringReconciliation,
  actualResultingRevision: number, requestedSupersession?: TaskGraphSupersessionRelation): Promise<void> {
  const { scope } = value
  const key = steeringReconciliationIdempotencyKey(scope, value.callId)
  const relation = requestedSupersession ?? value.receipt.supersession
  const parsedRelation = relation ? parseTaskGraphSupersessionRelation(relation) : null
  const receipt = parsedRelation ? value.receipt.supersession
    ? (sameReceipt(value.receipt, relationReceipt(value.receipt, parsedRelation)) ? value.receipt : null)
    : relationReceipt(value.receipt, parsedRelation) : value.receipt
  if (!key || key !== value.idempotencyKey || !steeringReconciliationRevision(actualResultingRevision)
    || !receipt || !parseSteeringReconciliationReceipt(receipt, scope)
    || value.receipt.decision !== value.decision || value.receipt.observedRevision !== value.expectedRevision
    || value.receipt.resultingRevision !== value.resultingRevision || value.inputThroughSequence < 0n
    || value.receipt.inputCheckpoint.throughSequence !== value.inputThroughSequence.toString()
    || value.receipt.steerInputIds.join("\0") !== [...value.steerInputIds].sort().join("\0")
    || parsedRelation && (parsedRelation.operationKey !== key || parsedRelation.agentPlanCall.callId !== value.callId
      || parsedRelation.agentPlanCall.stepId !== scope.stepId || parsedRelation.observedRevision !== value.expectedRevision
      || parsedRelation.resultingRevision !== value.expectedRevision + 2 || value.decision !== "revise"
      || actualResultingRevision !== parsedRelation.resultingRevision
      || value.receipt.supersession && JSON.stringify(value.receipt.supersession) !== JSON.stringify(parsedRelation))) {
    throw new Error("steering_reconciliation_prepared_invalid")
  }
  if (!parsedRelation && actualResultingRevision !== value.resultingRevision) throw new Error("steering_reconciliation_prepared_invalid")
  const operation: SteeringReconciliationOperation = { scope, decision: value.decision, expectedRevision: value.expectedRevision,
    callId: value.callId, ...(parsedRelation ? { replaceUnstartedNodeKey: parsedRelation.source.nodeKey } : {}) }
  const state = await readSteeringReconciliationState(client, scope)
  let prior = parsedRelation ? await existingReceipt(client, operation, key!) : null
  if (parsedRelation) await validateSupersession(client, scope, parsedRelation, prior ?? undefined)
  else await assertSteeringReconciliationCall(client, scope, value.callId, value.decision, value.expectedRevision)
  if (!parsedRelation) prior = await existingReceipt(client, operation, key)
  if (prior) {
    const priorReceipt = operationKeyMatches(prior, operation, key)
    if (!sameReceipt(priorReceipt, receipt)) throw new Error("steering_reconciliation_idempotency_conflict")
    if (state.currentRevision < priorReceipt.resultingRevision || state.decisionStepId !== scope.stepId
      || state.decisionInputThroughSequence?.toString() !== priorReceipt.inputCheckpoint.throughSequence) throw new Error("steering_reconciliation_idempotency_conflict")
    return
  }
  const currentRevision = state.currentRevision
  const expected = value.decision === "keep" ? value.expectedRevision : value.expectedRevision + 1
  const resultingRevision = parsedRelation?.resultingRevision ?? expected
  if (actualResultingRevision !== resultingRevision || currentRevision !== actualResultingRevision) throw new Error("steering_reconciliation_graph_result_conflict")
  if (!matchesPrepared(state, operation, value)) throw new Error("steering_reconciliation_pending_set_changed")
  await appendTaskGraphReceipt(client, {
    scope: scope as GraphEventScope, itemId: null, taskId: scope.rootTaskId, type: STEERING_RECONCILIATION_EVENT_TYPE,
    idempotencyKey: key, actor: "orchestrator", causationId: scope.stepId, payload: receipt, outbox: false,
  })
}

export { assertNoUnresolvedSteering, readSteeringReconciliationState }
