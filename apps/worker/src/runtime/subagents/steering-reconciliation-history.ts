import type pg from "pg"
import { parseCognitiveAgendaReceipt } from "../turns/cognitive-agenda-receipt.js"
import { parseSteeringReconciliationReceipt, steeringReconciliationId, steeringReconciliationIdempotencyKey, steeringReconciliationRevision, steeringReconciliationSequence, STEERING_RECONCILIATION_EVENT_TYPE, validSteeringReconciliationScope, validSteeringReconciliationToolCall, type SteeringReconciliationReceipt, type SteeringReconciliationScope } from "./steering-reconciliation-contract.js"
import { loadTaskGraphCancellationSource, taskGraphSupersessionFingerprint } from "./task-graph-pg-supersession.js"
import { callMatches, type SupersessionCallBinding } from "./root-plan-criteria.js"
import type { TaskGraphExecutionScope, TaskGraphReadScope } from "./task-graph-command-port.js"
import { assertTaskGraphBranchRepairHistory } from "./steering-reconciliation-branch-repair-history.js"; import { assertTaskGraphFailedBranchRepairHistory } from "./steering-reconciliation-failed-branch-history.js"; import { assertTaskGraphOperationalFailedBranchHistory } from "./steering-reconciliation-operational-failed-branch-history.js"; import type { TaskGraphOperationalFailureReplacement } from "../planning/task-graph-operational-failure-replacement.js"
import { assertSteeringReconciliationSupersessionEvents, normalizedProposalNode, sameProposalNode, type VerifiedSupersession } from "./steering-reconciliation-history-supersession.js"
type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type HistoryStep = Readonly<{ id: string; ordinal: number; attempt: number; cursor: bigint }>
export type SteeringReconciliationHistoryEntry = Readonly<{ receipt: SteeringReconciliationReceipt; stepOrdinal: number; stepAttempt: number }>
type ParsedReceipt = Readonly<{ receipt: SteeringReconciliationReceipt; sequence: bigint; id: string; idempotencyKey: string }>
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
const callMatchDependencies = { object, validToolCall: validSteeringReconciliationToolCall, normalizedProposalNode,
  fingerprint: taskGraphSupersessionFingerprint, sameProposalNode }
function toolCallQuery(): string {
  return `SELECT event."id" AS "eventId", event."sequence" AS "eventSequence", event."type", event."actor", event."taskId" AS "eventTaskId", event."itemId" AS "eventItemId", event."correlationId", event."idempotencyKey", event."payload",
      item."id" AS "callItemId", item."stepId", item."taskId" AS "itemTaskId", item."type" AS "itemType", item."content" AS "itemContent"
    FROM "agent_events" AS event JOIN "agent_items" AS item ON item."id" = event."itemId" AND item."sessionId" = event."sessionId" AND item."turnId" = event."turnId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = 'tool_call.started' AND event."taskId" = $3
      AND event."correlationId" = $4 AND item."taskId" = $3 AND item."type" = 'tool_call' AND item."stepId" = $5 LIMIT 2`
}
export async function assertSteeringReconciliationCall(client: Client, scope: TaskGraphExecutionScope, callId: string,
  decision: "keep" | "revise", expectedRevision: number, binding?: SupersessionCallBinding,
  operationalFailure?: TaskGraphOperationalFailureReplacement): Promise<bigint | null> {
  if (!validSteeringReconciliationScope(scope) || !steeringReconciliationId(callId) || !steeringReconciliationRevision(expectedRevision)) throw new Error("steering_reconciliation_call_invalid")
  const result = await client.query<Row>(toolCallQuery(), [scope.sessionId, scope.turnId, scope.rootTaskId, callId, scope.stepId])
  const sequence = result.rows.length === 1 ? steeringReconciliationSequence(result.rows[0]!.eventSequence) : null
  const row = result.rows[0]
  const event = row && { type: row.type, actor: row.actor, taskId: row.eventTaskId, itemId: row.eventItemId,
    correlationId: row.correlationId, idempotencyKey: row.idempotencyKey, payload: row.payload }
  const item = row && { id: row.callItemId, stepId: row.stepId, taskId: row.itemTaskId, type: row.itemType, content: row.itemContent }
  let matches = result.rows.length === 1 && (operationalFailure
    ? validSteeringReconciliationToolCall(event!, item!, scope, scope.stepId, decision, expectedRevision, undefined, undefined, operationalFailure)
    : callMatches(row!, scope, scope.stepId, decision, expectedRevision, binding, callMatchDependencies))
  if (!matches && result.rows.length === 1 && binding?.replacementFingerprint && binding.source) {
    const source = await loadTaskGraphCancellationSource(client, scope, { nodeKey: binding.source.nodeKey, taskId: binding.source.taskId,
      expectedRevision, stepId: scope.stepId })
    if (source) matches = callMatches(row!, scope, scope.stepId, decision, expectedRevision,
      { ...binding, source: { ...binding.source, dependsOn: source.dependsOn } }, callMatchDependencies)
  }
  if (result.rows.length !== 1 || !matches
    || binding && (binding.callId !== undefined && binding.callId !== callId || binding.stepId !== undefined && binding.stepId !== scope.stepId
      || binding.operationKey !== undefined && binding.operationKey !== steeringReconciliationIdempotencyKey(scope, callId)
      || sequence === null)) throw new Error("steering_reconciliation_call_invalid")
  return sequence
}
async function assertHistoryCalls(client: Client, scope: SteeringReconciliationScope, entries: readonly ParsedReceipt[], replacements: ReadonlyMap<string, VerifiedSupersession>): Promise<void> {
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
            source: replacements.has(relation.agentPlanCall.callId) ? { ...relation.source,
              dependsOn: replacements.get(relation.agentPlanCall.callId)!.source.dependsOn } : undefined,
            replacementNode: replacements.get(relation.agentPlanCall.callId)?.replacement,
            callId: relation.agentPlanCall.callId, stepId: relation.agentPlanCall.stepId, operationKey: relation.operationKey,
          } : undefined, callMatchDependencies)
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
      if (receipt.supersession && receipt.supersession.operationKey !== row.idempotencyKey
        || receipt.operationalFailure && receipt.operationalFailure.operationKey !== row.idempotencyKey) throw new Error("steering_reconciliation_receipt_invalid")
      return { receipt, sequence, id: row.id, idempotencyKey: row.idempotencyKey }
    })
    afterSequence = parsed.at(-1)!.sequence
    afterId = String(result.rows.at(-1)?.id)
    const replacements = await assertSteeringReconciliationSupersessionEvents(client, scope, parsed.flatMap(entry => entry.receipt.supersession ?
      [{ relation: entry.receipt.supersession, receiptEventId: entry.id, receiptSequence: entry.sequence }] : []))
    await Promise.all(parsed.flatMap(entry => {
      const event = { id: entry.id, sequence: entry.sequence, stepId: entry.receipt.stepId, idempotencyKey: entry.idempotencyKey }
      return entry.receipt.operationalFailure ? [assertTaskGraphOperationalFailedBranchHistory(client, scope, entry.receipt.operationalFailure, event)]
        : entry.receipt.failedBranch ? [assertTaskGraphFailedBranchRepairHistory(client, scope, entry.receipt.failedBranch, event)]
        : entry.receipt.branchRepair ? [assertTaskGraphBranchRepairHistory(client, scope, entry.receipt.branchRepair, event)] : []
    }))
    await assertHistoryCalls(client, scope, parsed.filter(entry => !entry.receipt.branchRepair && !entry.receipt.failedBranch && !entry.receipt.operationalFailure), replacements)
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
