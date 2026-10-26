import type pg from "pg"
import {
  parseSteeringReconciliationReceipt, steeringReconciliationIdempotencyKey, steeringReconciliationRevision,
  steeringReconciliationId, steeringReconciliationSequence, STEERING_RECONCILIATION_EVENT_TYPE,
  type PreparedSteeringReconciliation, type SteeringReconciliationOperation, type SteeringReconciliationReceipt,
} from "./steering-reconciliation-contract.js"
import { branchRepairReceipt, failedBranchRepairReceipt, matchSteeringReconciliationOperationReceipt, operationalFailureReceipt, relationReceipt } from "./steering-reconciliation-operation-receipt.js"
import { assertNoUnresolvedSteering, readSteeringReconciliationState } from "./steering-reconciliation-read.js"
import { assertSteeringReconciliationCall } from "./steering-reconciliation-history.js"
import { assertSteeringReconciliationSupersessionEvents } from "./steering-reconciliation-history-supersession.js"
import { assertTaskGraphBranchRepairCall, assertTaskGraphBranchRepairHistory, assertTaskGraphBranchRepairToolCall } from "./steering-reconciliation-branch-repair-history.js"
import { assertTaskGraphFailedBranchRepairHistory } from "./steering-reconciliation-failed-branch-history.js"
import { appendTaskGraphReceiptWithIdentity } from "./task-graph-pg-events.js"
import type { GraphEventScope } from "./task-graph-pg-state.js"
import { parseTaskGraphSupersessionRelation, type TaskGraphSupersessionRelation } from "./task-graph-pg-supersession.js"
import { parseTaskGraphBranchRepairRelation, type TaskGraphBranchRepairRelation } from "./task-graph-pg-branch-repair-relation.js"
import { parseTaskGraphFailedBranchRepairRelation, type TaskGraphFailedBranchRepairRelation } from "./task-graph-pg-failed-branch-relation.js"
import { parseTaskGraphOperationalFailedBranchRelation, type TaskGraphOperationalFailedBranchRelation } from "./task-graph-pg-operational-failed-branch-relation.js"
import { assertTaskGraphOperationalFailedBranchHistory } from "./steering-reconciliation-operational-failed-branch-history.js"
import type { TaskGraphScheduleReceipt } from "./task-graph-command-port.js"

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
  const branchCall = operation.replaceBranch
    ? await assertTaskGraphBranchRepairToolCall(client, scope, callId, expectedRevision, operation.replaceBranch) : null
  if (!operation.replaceBranch) await assertSteeringReconciliationCall(client, scope, callId, decision, expectedRevision,
    operation.replaceUnstartedNodeKey === undefined ? undefined : { replaceUnstartedNodeKey: operation.replaceUnstartedNodeKey, callId, stepId: scope.stepId, operationKey: key },
    operation.replaceOperationalFailure)
  if (state.decisionStepId !== scope.stepId || state.agendaPlanRevision !== expectedRevision) throw new Error("steering_reconciliation_agenda_revision_conflict")
  const prior = await existingReceipt(client, operation, key)
  if (prior) {
    const receipt = matchSteeringReconciliationOperationReceipt(prior, operation, key, branchCall?.fingerprint)
    if (state.currentRevision < receipt.resultingRevision || state.decisionInputThroughSequence?.toString() !== receipt.inputCheckpoint.throughSequence) throw new Error("steering_reconciliation_idempotency_conflict")
    if (receipt.supersession) await validateSupersession(client, scope, receipt.supersession, prior)
    if (receipt.operationalFailure) {
      const sequence = steeringReconciliationSequence(prior.sequence)
      if (!sequence || !steeringReconciliationId(prior.id)) throw new Error("steering_reconciliation_idempotency_conflict")
      await assertTaskGraphOperationalFailedBranchHistory(client, scope, receipt.operationalFailure,
        { id: prior.id, sequence, stepId: receipt.stepId, idempotencyKey: key })
    }
    return prepared(operation, receipt, key)
  }
  if (state.currentRevision !== expectedRevision) throw new Error("steering_reconciliation_revision_conflict")
  if (state.unresolvedInputs.length === 0 && !operation.replaceBranch && !operation.replaceOperationalFailure) return null
  if (state.decisionInputThroughSequence === null || state.unresolvedInputs.some(input => input.status !== "consumed" || !input.consumedByStepId
    || input.acceptedSequence > state.decisionInputThroughSequence!)) throw new Error("steering_reconciliation_unconsumed_input")
  const value = receiptFor(operation, state.unresolvedInputs.map(input => input.id), state.decisionInputThroughSequence)
  if (value.steerInputIds.length && !parseSteeringReconciliationReceipt(value, scope)) throw new Error("steering_reconciliation_receipt_invalid")
  return prepared(operation, value, key)
}

/** Resolves immutable branch-operation replay before callers load the current graph. */
export async function findSteeringReconciliationReplay(client: Client, operation: SteeringReconciliationOperation,
  requestFingerprint: string): Promise<TaskGraphScheduleReceipt | null> {
  const { scope } = operation, key = steeringReconciliationIdempotencyKey(scope, operation.callId)
  if (!key || Boolean(operation.replaceBranch) === Boolean(operation.replaceOperationalFailure)
    || operation.replaceUnstartedNodeKey !== undefined || !/^[0-9a-f]{64}$/.test(requestFingerprint)) {
    throw new Error("steering_reconciliation_operation_invalid")
  }
  const prior = await existingReceipt(client, operation, key)
  if (!prior) return null
  const receipt = matchSteeringReconciliationOperationReceipt(prior, operation, key, requestFingerprint)
  const sequence = steeringReconciliationSequence(prior.sequence)
  if (!sequence || !steeringReconciliationId(prior.id)) throw new Error("steering_reconciliation_idempotency_conflict")
  const receiptEvent = { id: prior.id, sequence, stepId: receipt.stepId, idempotencyKey: key }
  let schedule: TaskGraphScheduleReceipt
  if (receipt.branchRepair) schedule = await assertTaskGraphBranchRepairHistory(client, scope, receipt.branchRepair, receiptEvent)
  else if (receipt.failedBranch) schedule = await assertTaskGraphFailedBranchRepairHistory(client, scope, receipt.failedBranch, receiptEvent)
  else if (receipt.operationalFailure) schedule = await assertTaskGraphOperationalFailedBranchHistory(client, scope, receipt.operationalFailure, receiptEvent)
  else throw new Error("steering_reconciliation_idempotency_conflict")
  return { ...schedule, status: "duplicate" }
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
  actualResultingRevision: number, requestedSupersession?: TaskGraphSupersessionRelation,
  requestedBranchRepair?: TaskGraphBranchRepairRelation, requestedFailedBranchRepair?: TaskGraphFailedBranchRepairRelation,
  requestedOperationalFailure?: TaskGraphOperationalFailedBranchRelation): Promise<void> {
  const { scope } = value
  const key = steeringReconciliationIdempotencyKey(scope, value.callId)
  const relation = requestedSupersession ?? value.receipt.supersession
  const branch = requestedBranchRepair ?? value.receipt.branchRepair
  const failedBranch = requestedFailedBranchRepair ?? value.receipt.failedBranch
  const operationalFailure = requestedOperationalFailure ?? value.receipt.operationalFailure
  const parsedRelation = relation ? parseTaskGraphSupersessionRelation(relation) : null
  const parsedBranch = branch ? parseTaskGraphBranchRepairRelation(branch) : null
  const parsedFailedBranch = failedBranch ? parseTaskGraphFailedBranchRepairRelation(failedBranch) : null
  const parsedOperational = operationalFailure ? parseTaskGraphOperationalFailedBranchRelation(operationalFailure) : null
  const receipt = parsedFailedBranch ? value.receipt.failedBranch
    ? (sameReceipt(value.receipt, failedBranchRepairReceipt(value.receipt, parsedFailedBranch)) ? value.receipt : null)
    : failedBranchRepairReceipt(value.receipt, parsedFailedBranch)
    : parsedBranch ? value.receipt.branchRepair
    ? (sameReceipt(value.receipt, branchRepairReceipt(value.receipt, parsedBranch)) ? value.receipt : null)
    : branchRepairReceipt(value.receipt, parsedBranch)
    : parsedRelation ? value.receipt.supersession
    ? (sameReceipt(value.receipt, relationReceipt(value.receipt, parsedRelation)) ? value.receipt : null)
    : relationReceipt(value.receipt, parsedRelation) : parsedOperational ? value.receipt.operationalFailure
    ? (sameReceipt(value.receipt, operationalFailureReceipt(value.receipt, parsedOperational)) ? value.receipt : null)
    : operationalFailureReceipt(value.receipt, parsedOperational) : value.receipt
  if (!key || key !== value.idempotencyKey || Number(Boolean(parsedRelation)) + Number(Boolean(parsedBranch))
    + Number(Boolean(parsedFailedBranch)) + Number(Boolean(parsedOperational)) > 1
    || !steeringReconciliationRevision(actualResultingRevision)
    || !receipt || !parseSteeringReconciliationReceipt(receipt, scope)
    || value.receipt.decision !== value.decision || value.receipt.observedRevision !== value.expectedRevision
    || value.receipt.resultingRevision !== value.resultingRevision || value.inputThroughSequence < 0n
    || value.receipt.inputCheckpoint.throughSequence !== value.inputThroughSequence.toString()
    || value.receipt.steerInputIds.join("\0") !== [...value.steerInputIds].sort().join("\0")
    || parsedRelation && (parsedRelation.operationKey !== key || parsedRelation.agentPlanCall.callId !== value.callId
      || parsedRelation.agentPlanCall.stepId !== scope.stepId || parsedRelation.observedRevision !== value.expectedRevision
      || parsedRelation.resultingRevision !== value.expectedRevision + 2 || value.decision !== "revise"
      || actualResultingRevision !== parsedRelation.resultingRevision
      || value.receipt.supersession && JSON.stringify(value.receipt.supersession) !== JSON.stringify(parsedRelation))
    || parsedBranch && (parsedBranch.operationKey !== key || parsedBranch.graphRootTaskId !== scope.rootTaskId
      || parsedBranch.agentPlanCall.callId !== value.callId || parsedBranch.agentPlanCall.stepId !== scope.stepId
      || parsedBranch.observedRevision !== value.expectedRevision || value.decision !== "revise"
      || actualResultingRevision !== parsedBranch.resultingRevision
      || value.receipt.branchRepair && JSON.stringify(value.receipt.branchRepair) !== JSON.stringify(parsedBranch))
    || parsedFailedBranch && (parsedFailedBranch.operationKey !== key || parsedFailedBranch.graphRootTaskId !== scope.rootTaskId
      || parsedFailedBranch.agentPlanCall.callId !== value.callId || parsedFailedBranch.agentPlanCall.stepId !== scope.stepId
      || parsedFailedBranch.observedRevision !== value.expectedRevision || value.decision !== "revise"
      || actualResultingRevision !== parsedFailedBranch.resultingRevision
      || value.receipt.failedBranch && JSON.stringify(value.receipt.failedBranch) !== JSON.stringify(parsedFailedBranch))
    || parsedOperational && (parsedOperational.operationKey !== key || parsedOperational.graphRootTaskId !== scope.rootTaskId
      || parsedOperational.agentPlanCall.callId !== value.callId || parsedOperational.agentPlanCall.stepId !== scope.stepId
      || parsedOperational.observedRevision !== value.expectedRevision || value.decision !== "revise"
      || actualResultingRevision !== parsedOperational.resultingRevision
      || value.receipt.operationalFailure && JSON.stringify(value.receipt.operationalFailure) !== JSON.stringify(parsedOperational))) {
    throw new Error("steering_reconciliation_prepared_invalid")
  }
  if (!parsedRelation && !parsedBranch && !parsedFailedBranch && !parsedOperational && actualResultingRevision !== value.resultingRevision) throw new Error("steering_reconciliation_prepared_invalid")
  const operation: SteeringReconciliationOperation = { scope, decision: value.decision, expectedRevision: value.expectedRevision,
    callId: value.callId, ...(parsedRelation ? { replaceUnstartedNodeKey: parsedRelation.source.nodeKey } : {}),
    ...(parsedBranch ? { replaceBranch: parsedBranch.agentPlanCall.replaceBranch } : {}),
    ...(parsedFailedBranch ? { replaceBranch: parsedFailedBranch.agentPlanCall.replaceBranch } : {}),
    ...(parsedOperational ? { replaceOperationalFailure: parsedOperational.agentPlanCall.replaceOperationalFailure } : {}) }
  const state = await readSteeringReconciliationState(client, scope)
  let prior = parsedRelation || parsedBranch || parsedFailedBranch || parsedOperational ? await existingReceipt(client, operation, key!) : null
  if (parsedRelation) await validateSupersession(client, scope, parsedRelation, prior ?? undefined)
  else if (parsedBranch) await assertTaskGraphBranchRepairCall(client, scope, parsedBranch)
  else if (parsedOperational) await assertSteeringReconciliationCall(client, scope, value.callId, "revise", value.expectedRevision,
    undefined, parsedOperational.agentPlanCall.replaceOperationalFailure)
  else if (!parsedFailedBranch) await assertSteeringReconciliationCall(client, scope, value.callId, value.decision, value.expectedRevision)
  if (!parsedRelation && !parsedBranch && !parsedFailedBranch) prior = await existingReceipt(client, operation, key)
  if (prior) {
    const priorReceipt = matchSteeringReconciliationOperationReceipt(prior, operation, key, parsedOperational?.requestFingerprint
      ?? parsedFailedBranch?.requestFingerprint ?? parsedBranch?.replacementFingerprint)
    if (!sameReceipt(priorReceipt, receipt)) throw new Error("steering_reconciliation_idempotency_conflict")
    if (state.currentRevision < priorReceipt.resultingRevision || state.decisionStepId !== scope.stepId
      || state.decisionInputThroughSequence?.toString() !== priorReceipt.inputCheckpoint.throughSequence) throw new Error("steering_reconciliation_idempotency_conflict")
    if (parsedBranch) {
      const sequence = steeringReconciliationSequence(prior.sequence)
      if (!sequence || !steeringReconciliationId(prior.id)) throw new Error("steering_reconciliation_idempotency_conflict")
      await assertTaskGraphBranchRepairHistory(client, scope, parsedBranch,
        { id: prior.id, sequence, stepId: priorReceipt.stepId, idempotencyKey: String(prior.idempotencyKey) })
    }
    if (parsedFailedBranch) {
      const sequence = steeringReconciliationSequence(prior.sequence)
      if (!sequence || !steeringReconciliationId(prior.id)) throw new Error("steering_reconciliation_idempotency_conflict")
      await assertTaskGraphFailedBranchRepairHistory(client, scope, parsedFailedBranch,
        { id: prior.id, sequence, stepId: priorReceipt.stepId, idempotencyKey: String(prior.idempotencyKey) })
    }
    if (parsedOperational) {
      const sequence = steeringReconciliationSequence(prior.sequence)
      if (!sequence || !steeringReconciliationId(prior.id)) throw new Error("steering_reconciliation_idempotency_conflict")
      await assertTaskGraphOperationalFailedBranchHistory(client, scope, parsedOperational,
        { id: prior.id, sequence, stepId: priorReceipt.stepId, idempotencyKey: String(prior.idempotencyKey) })
    }
    return
  }
  const currentRevision = state.currentRevision
  const expected = value.decision === "keep" ? value.expectedRevision : value.expectedRevision + 1
  const resultingRevision = parsedRelation?.resultingRevision ?? parsedBranch?.resultingRevision
    ?? parsedFailedBranch?.resultingRevision ?? parsedOperational?.resultingRevision ?? expected
  if (actualResultingRevision !== resultingRevision || currentRevision !== actualResultingRevision) throw new Error("steering_reconciliation_graph_result_conflict")
  if (!matchesPrepared(state, operation, value)) throw new Error("steering_reconciliation_pending_set_changed")
  const event = await appendTaskGraphReceiptWithIdentity(client, {
    scope: scope as GraphEventScope, itemId: null, taskId: scope.rootTaskId, type: STEERING_RECONCILIATION_EVENT_TYPE,
    idempotencyKey: key, actor: "orchestrator", causationId: scope.stepId, payload: receipt, outbox: false,
  })
  if (parsedBranch || parsedFailedBranch || parsedOperational) {
    const sequence = steeringReconciliationSequence(event.sequence)
    if (!sequence || !steeringReconciliationId(event.id)) throw new Error("steering_reconciliation_branch_repair_event_invalid")
    const receiptEvent = { id: event.id, sequence, stepId: scope.stepId, idempotencyKey: key! }
    if (parsedBranch) await assertTaskGraphBranchRepairHistory(client, scope, parsedBranch, receiptEvent)
    else if (parsedFailedBranch) await assertTaskGraphFailedBranchRepairHistory(client, scope, parsedFailedBranch, receiptEvent)
    else await assertTaskGraphOperationalFailedBranchHistory(client, scope, parsedOperational!, receiptEvent)
  }
}

export { assertNoUnresolvedSteering, readSteeringReconciliationState }
