import type pg from "pg"
import { parseCognitiveAgendaReceipt } from "../turns/cognitive-agenda-receipt.js"
import {
  parseSteeringReconciliationReceipt, steeringReconciliationId, steeringReconciliationIdempotencyKey, steeringReconciliationRevision, steeringReconciliationSequence,
  STEERING_RECONCILIATION_EVENT_TYPE, validSteeringReconciliationScope, validSteeringReconciliationToolCall,
  type SteeringReconciliationReceipt, type SteeringReconciliationScope,
} from "./steering-reconciliation-contract.js"
import type { TaskGraphExecutionScope, TaskGraphReadScope } from "./task-graph-command-port.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type HistoryStep = Readonly<{ id: string; ordinal: number; attempt: number; cursor: bigint }>
export type SteeringReconciliationHistoryEntry = Readonly<{ receipt: SteeringReconciliationReceipt; stepOrdinal: number; stepAttempt: number }>
type ParsedReceipt = Readonly<{ receipt: SteeringReconciliationReceipt; sequence: bigint; idempotencyKey: string }>
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
async function toolCalls(client: Client, scope: SteeringReconciliationScope, stepIds: readonly string[]): Promise<Row[]> {
  if (!stepIds.length) return []
  const result = await client.query<Row>(`SELECT event."type", event."actor", event."taskId" AS "eventTaskId", event."itemId" AS "eventItemId", event."correlationId", event."idempotencyKey", event."payload",
      item."id" AS "callItemId", item."stepId", item."taskId" AS "itemTaskId", item."type" AS "itemType", item."content" AS "itemContent"
    FROM "agent_events" AS event JOIN "agent_items" AS item ON item."id" = event."itemId" AND item."sessionId" = event."sessionId" AND item."turnId" = event."turnId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = 'tool_call.started' AND event."taskId" = $3
      AND item."taskId" = $3 AND item."type" = 'tool_call' AND item."stepId" = ANY($4::text[])`, [scope.sessionId, scope.turnId, scope.rootTaskId, stepIds])
  if (result.rows.length > 512) throw new Error("steering_reconciliation_call_history_overflow")
  return result.rows
}
function callMatches(row: Row, scope: SteeringReconciliationScope, stepId: string, decision: "keep" | "revise", revision: number): boolean {
  return validSteeringReconciliationToolCall({ type: row.type, actor: row.actor, taskId: row.eventTaskId, itemId: row.eventItemId,
    correlationId: row.correlationId, idempotencyKey: row.idempotencyKey, payload: row.payload },
  { id: row.callItemId, stepId: row.stepId, taskId: row.itemTaskId, type: row.itemType, content: row.itemContent }, scope, stepId, decision, revision)
}
export async function assertSteeringReconciliationCall(client: Client, scope: TaskGraphExecutionScope, callId: string,
  decision: "keep" | "revise", expectedRevision: number): Promise<void> {
  if (!validSteeringReconciliationScope(scope) || !steeringReconciliationId(callId) || !steeringReconciliationRevision(expectedRevision)) throw new Error("steering_reconciliation_call_invalid")
  const rows = await toolCalls(client, scope, [scope.stepId])
  if (rows.filter(row => row.correlationId === callId && callMatches(row, scope, scope.stepId, decision, expectedRevision)).length !== 1) throw new Error("steering_reconciliation_call_invalid")
}

export async function readSteeringReconciliationHistory(client: Client, scope: SteeringReconciliationScope,
  currentRevision: number): Promise<readonly SteeringReconciliationHistoryEntry[]> {
  if (!validSteeringReconciliationScope(scope) || !steeringReconciliationRevision(currentRevision)) throw new Error("steering_reconciliation_scope_invalid")
  const result = await client.query<Row>(`SELECT event."id", event."itemId", event."taskId", event."type", event."actor", event."correlationId", event."causationId", event."sequence", event."idempotencyKey", event."payload",
      EXISTS (SELECT 1 FROM "agent_outbox" AS outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id") AS "hasOutbox"
    FROM "agent_events" AS event WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = $3 ORDER BY event."sequence" ASC`,
  [scope.sessionId, scope.turnId, STEERING_RECONCILIATION_EVENT_TYPE])
  if (result.rows.length > 256) throw new Error("steering_reconciliation_history_overflow")
  const expectedScope = ownerScope(scope)
  const parsed: ParsedReceipt[] = result.rows.map(row => {
    const receipt = parseSteeringReconciliationReceipt(object(row.payload), expectedScope)
    if (!receipt || row.itemId !== null || row.taskId !== scope.rootTaskId || row.type !== STEERING_RECONCILIATION_EVENT_TYPE
      || row.actor !== "orchestrator" || row.correlationId !== scope.turnId || row.causationId !== receipt.stepId || row.hasOutbox !== false
      || typeof row.idempotencyKey !== "string" || !/^agent\.plan\.reconciliation:sha256:[a-f0-9]{64}$/.test(row.idempotencyKey)
      || steeringReconciliationSequence(row.sequence) === null) throw new Error("steering_reconciliation_receipt_invalid")
    return { receipt, sequence: BigInt(String(row.sequence)), idempotencyKey: row.idempotencyKey as string }
  })
  const stepIds = [...new Set(parsed.map(entry => entry.receipt.stepId))]
  const calls = await toolCalls(client, scope, stepIds)
  for (const entry of parsed) {
    const matches = calls.filter(row => {
      const callId = row.correlationId
      if (!steeringReconciliationId(callId) || !callMatches(row, scope, entry.receipt.stepId, entry.receipt.decision, entry.receipt.observedRevision)) return false
      return steeringReconciliationIdempotencyKey({ ...scope, stepId: entry.receipt.stepId }, callId) === entry.idempotencyKey
    })
    if (matches.length !== 1) throw new Error("steering_reconciliation_receipt_call_invalid")
  }
  const stepRows = stepIds.length ? await client.query<Row>(`SELECT "id", "taskId", "ordinal", "attempt", "status", "inputThroughSequence" FROM "agent_steps"
    WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "id" = ANY($4::text[])`, [scope.sessionId, scope.turnId, scope.rootTaskId, stepIds]) : { rows: [] as Row[] }
  if (stepRows.rows.length !== stepIds.length) throw new Error("steering_reconciliation_receipt_step_missing")
  const steps = new Map<string, HistoryStep>()
  for (const row of stepRows.rows) {
    const parsedStep = historyStep(row)
    if (!parsedStep || row.taskId !== scope.rootTaskId || parsedStep.attempt > scope.parentAttemptCount) throw new Error("steering_reconciliation_receipt_step_invalid")
    steps.set(parsedStep.id, parsedStep)
  }
  const agendaRows = stepIds.length ? await client.query<Row>(`SELECT event."actor", event."itemId", event."taskId", event."correlationId", event."payload" FROM "agent_events" AS event
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = 'cognitive.agenda' AND event."taskId" = $3
      AND event."itemId" IS NULL AND event."correlationId" = ANY($4::text[]) ORDER BY event."sequence"`, [scope.sessionId, scope.turnId, scope.rootTaskId, stepIds]) : { rows: [] as Row[] }
  const agendas = new Map<string, number>()
  for (const row of agendaRows.rows) {
    const id = String(row.correlationId), agenda = parseCognitiveAgendaReceipt(object(row.payload), { sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId, stepId: id })
    if (!agenda || row.itemId !== null || row.taskId !== scope.rootTaskId || !["subagent", "orchestrator"].includes(String(row.actor)) || agendas.has(id)) throw new Error("steering_reconciliation_agenda_invalid")
    agendas.set(id, agenda.planRevision ?? -1)
  }
  if (agendas.size !== stepIds.length) throw new Error("steering_reconciliation_agenda_missing")
  let previous = -1n
  const entries = parsed.map(entry => {
    const step = steps.get(entry.receipt.stepId)
    if (!step || agendas.get(step.id) !== entry.receipt.observedRevision || step.cursor.toString() !== entry.receipt.inputCheckpoint.throughSequence
      || entry.receipt.resultingRevision > currentRevision || entry.sequence <= previous) throw new Error("steering_reconciliation_receipt_history_invalid")
    previous = entry.sequence
    return { receipt: entry.receipt, stepOrdinal: step.ordinal, stepAttempt: step.attempt }
  })
  return entries
}
