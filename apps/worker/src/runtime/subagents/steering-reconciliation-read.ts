import type pg from "pg"
import { parseCognitiveAgendaReceipt } from "../turns/cognitive-agenda-receipt.js"
import { steeringReconciliationId, steeringReconciliationRevision, steeringReconciliationSequence,
  validSteeringReconciliationScope,
  type SteeringReconciliationPendingInput, type SteeringReconciliationScope, type SteeringReconciliationState } from "./steering-reconciliation-contract.js"
import { lockTaskGraphScope } from "./task-graph-pg-state.js"
import { taskGraphItemId } from "./task-graph-snapshot.js"
import { readSteeringReconciliationHistory } from "./steering-reconciliation-history.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type Input = SteeringReconciliationPendingInput & Readonly<{ clientMessageId: string; cancelledAt: Date | null }>
type Step = Readonly<{ id: string; ordinal: number; attempt: number; status: string; cursor: bigint; ids: readonly string[] }>
type Candidate = Input & Readonly<{ consumer: Step | null }>
const STEP_STATUSES = new Set(["streaming", "waiting_for_tool", "waiting_for_approval", "waiting_for_user", "completed", "failed", "interrupted"])
function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const prototype = Object.getPrototypeOf(parsed)
  return prototype === Object.prototype || prototype === null ? parsed as Row : null
}
function date(value: unknown): value is Date { return value instanceof Date && Number.isFinite(value.getTime()) }
function ids(value: unknown): string[] | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!Array.isArray(parsed) || parsed.length > 256 || new Set(parsed).size !== parsed.length || !parsed.every(steeringReconciliationId)) return null
  return parsed
}
function step(row: Row | undefined): Step | null {
  if (!row || !steeringReconciliationId(row.id) || !Number.isSafeInteger(row.ordinal) || Number(row.ordinal) < 0
    || !Number.isSafeInteger(row.attempt) || Number(row.attempt) < 1 || typeof row.status !== "string" || !STEP_STATUSES.has(row.status)) return null
  const cursor = steeringReconciliationSequence(row.inputThroughSequence), consumed = ids(row.consumedInputIds)
  return cursor === null || consumed === null ? null : { id: row.id, ordinal: Number(row.ordinal), attempt: Number(row.attempt), status: row.status, cursor, ids: consumed }
}
function compareInput(left: Input, right: Input): number { return left.acceptedSequence < right.acceptedSequence ? -1 : left.acceptedSequence > right.acceptedSequence ? 1 : left.id.localeCompare(right.id) }
function compareStep(left: Step, right: Step): number { return left.ordinal - right.ordinal || left.attempt - right.attempt }
function originalClientMessageId(turnInput: unknown): string | null | undefined {
  const envelope = object(turnInput), nested = object(envelope?.input), source = nested && Object.keys(nested).length > 0 ? nested : envelope
  if (!source || !Object.hasOwn(source, "clientMessageId")) return undefined
  return steeringReconciliationId(source.clientMessageId) ? source.clientMessageId : null
}
function acceptedEvent(row: Row, turnId: string): { readonly source: "user" | "automation" | "system" } | null {
  const payload = object(row.acceptedPayload)
  if (!payload || Object.keys(payload).sort().join(",") !== "clientMessageId,delivery,disposition,inputId,source"
    || row.acceptedType !== "input.accepted" || row.acceptedTaskId !== null || row.acceptedEventSequence === null
    || row.acceptedCorrelationId !== turnId || !steeringReconciliationId(row.acceptedItemId)
    || row.acceptedItemType !== "user_message" || row.acceptedItemTaskId !== null || row.acceptedItemStatus !== "completed"
    || payload.inputId !== row.id || payload.clientMessageId !== row.clientMessageId || payload.delivery !== row.delivery
    || typeof payload.disposition !== "string" || !payload.disposition.trim()
    || payload.source !== "user" && payload.source !== "automation" && payload.source !== "system") return null
  const item = object(row.acceptedItemContent)
  if (!item || Object.keys(item).sort().join(",") !== "clientMessageId,disposition,parts,source" || !Array.isArray(item.parts)
    || item.clientMessageId !== payload.clientMessageId || item.source !== payload.source || item.disposition !== payload.disposition) return null
  const source = payload.source as "user" | "automation" | "system"
  if (row.acceptedActor !== (source === "user" ? "user" : "system")) return null
  return { source }
}
async function readInputs(client: Client, scope: SteeringReconciliationScope, hint?: string | null): Promise<{ rootId: string | null; candidates: Candidate[] }> {
  const turn = await client.query<Row>(`SELECT turn."input" FROM "agent_turns" AS turn JOIN "agent_sessions" AS session
    ON session."id" = turn."sessionId" AND session."userId" = turn."userId" WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND turn."rootTaskId" = $4`,
  [scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId])
  if (turn.rows.length !== 1) throw new Error("steering_reconciliation_turn_fenced")
  const allRows = await client.query<Row>(`SELECT "id", "clientMessageId", "delivery", "status", "acceptedSequence", "consumedByStepId", "consumedAt", "cancelledAt"
    FROM "agent_inputs" WHERE "sessionId" = $1 AND "targetTurnId" = $2 AND "userId" = $3 ORDER BY "acceptedSequence", "id"`, [scope.sessionId, scope.turnId, scope.userId])
  const all: Input[] = allRows.rows.map(row => {
    const acceptedSequence = steeringReconciliationSequence(row.acceptedSequence)
    if (!steeringReconciliationId(row.id) || !steeringReconciliationId(row.clientMessageId) || acceptedSequence === null
      || !["steer", "follow_up"].includes(String(row.delivery)) || !["accepted", "queued", "consumed", "cancelled", "rejected"].includes(String(row.status))
      || !(row.consumedByStepId === null || steeringReconciliationId(row.consumedByStepId))
      || !(row.consumedAt === null || date(row.consumedAt)) || !(row.cancelledAt === null || date(row.cancelledAt))) throw new Error("steering_reconciliation_input_invalid")
    return { id: row.id as string, clientMessageId: row.clientMessageId as string, acceptedSequence,
      status: row.status as Input["status"], consumedByStepId: row.consumedByStepId as string | null,
      consumingOrdinal: null, cancelledAt: row.cancelledAt as Date | null }
  })
  const bound = originalClientMessageId(turn.rows[0]?.input)
  let rootId: string | null = null
  if (bound === null) throw new Error("steering_reconciliation_original_input_invalid")
  if (bound !== undefined) {
    const matches = all.filter(input => input.clientMessageId === bound)
    if (matches.length !== 1) throw new Error("steering_reconciliation_original_input_invalid")
    rootId = matches[0]!.id
  } else if (all.length > 0) {
    if (all.length > 1 && all[0]!.acceptedSequence === all[1]!.acceptedSequence) throw new Error("steering_reconciliation_original_input_ambiguous")
    rootId = all[0]!.id
  }
  if (hint !== undefined && hint !== null && hint !== rootId) throw new Error("steering_reconciliation_original_input_mismatch")
  const result = await client.query<Row>(`SELECT input."id", input."clientMessageId", input."delivery", input."status", input."acceptedSequence", input."consumedByStepId", input."consumedAt", input."cancelledAt",
      event."type" AS "acceptedType", event."actor" AS "acceptedActor", event."taskId" AS "acceptedTaskId", event."correlationId" AS "acceptedCorrelationId", event."itemId" AS "acceptedItemId", event."sequence" AS "acceptedEventSequence", event."payload" AS "acceptedPayload",
      accepted_item."type" AS "acceptedItemType", accepted_item."taskId" AS "acceptedItemTaskId", accepted_item."status" AS "acceptedItemStatus", accepted_item."content" AS "acceptedItemContent"
    FROM "agent_inputs" AS input LEFT JOIN "agent_events" AS event ON event."sessionId" = input."sessionId" AND event."turnId" = input."targetTurnId" AND event."sequence" = input."acceptedSequence"
    LEFT JOIN "agent_items" AS accepted_item ON accepted_item."id" = event."itemId" AND accepted_item."sessionId" = input."sessionId" AND accepted_item."turnId" = input."targetTurnId"
    WHERE input."sessionId" = $1 AND input."targetTurnId" = $2 AND input."userId" = $3 AND input."delivery" = 'steer' AND input."status" IN ('accepted', 'queued', 'consumed') ORDER BY input."acceptedSequence", input."id"`, [scope.sessionId, scope.turnId, scope.userId])
  const active: Input[] = []
  for (const row of result.rows) {
    const input = all.find(candidate => candidate.id === row.id)
    if (!input) throw new Error("steering_reconciliation_input_invalid")
    if (input.id === rootId) continue
    const accepted = acceptedEvent(row, scope.turnId)
    if (!accepted || row.acceptedActor === null || row.acceptedEventSequence === null
      || String(row.acceptedEventSequence) !== input.acceptedSequence.toString()) throw new Error("steering_reconciliation_acceptance_invalid")
    if (input.status === "consumed") {
      if (!input.consumedByStepId || !date(row.consumedAt) || row.cancelledAt !== null) throw new Error("steering_reconciliation_consumption_invalid")
    } else if (input.consumedByStepId !== null || row.consumedAt !== null || row.cancelledAt !== null) throw new Error("steering_reconciliation_consumption_invalid")
    if (accepted.source === "user") active.push(input)
  }
  const consumerIds = active.map(input => input.consumedByStepId).filter((id): id is string => id !== null)
  const steps = consumerIds.length ? await client.query<Row>(`SELECT "id", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds"
    FROM "agent_steps" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "id" = ANY($4::text[])`,
  [scope.sessionId, scope.turnId, scope.rootTaskId, [...new Set(consumerIds)]]) : { rows: [] as Row[] }
  if (steps.rows.length !== new Set(consumerIds).size) throw new Error("steering_reconciliation_consuming_step_missing")
  const sourceById = new Map<string, Step>()
  for (const row of steps.rows) {
    const parsed = step(row)
    if (!parsed || row.taskId !== scope.rootTaskId || parsed.attempt > scope.parentAttemptCount) throw new Error("steering_reconciliation_consuming_step_invalid")
    sourceById.set(parsed.id, parsed)
  }
  const candidates: Candidate[] = active.map(input => {
    if (!input.consumedByStepId) return { ...input, consumer: null }
    const consumer = sourceById.get(input.consumedByStepId)
    if (!consumer || !consumer.ids.includes(input.id) || consumer.cursor < input.acceptedSequence) throw new Error("steering_reconciliation_consumption_invalid")
    return { ...input, consumingOrdinal: consumer.ordinal, consumer }
  }).sort(compareInput)
  return { rootId, candidates }
}

async function readAgenda(client: Client, scope: SteeringReconciliationScope, stepId: string): Promise<number | null> {
  const result = await client.query<Row>(`SELECT event."actor", event."itemId", event."taskId", event."correlationId", event."payload" FROM "agent_events" AS event
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = 'cognitive.agenda' AND event."taskId" = $3 AND event."correlationId" = $4
      AND event."itemId" IS NULL ORDER BY event."sequence" DESC LIMIT 2`, [scope.sessionId, scope.turnId, scope.rootTaskId, stepId])
  if (result.rows.length !== 1 || !["subagent", "orchestrator"].includes(String(result.rows[0]?.actor))) throw new Error("steering_reconciliation_agenda_missing")
  const agenda = parseCognitiveAgendaReceipt(object(result.rows[0]?.payload), { sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId, stepId })
  if (!agenda) throw new Error("steering_reconciliation_agenda_invalid")
  return agenda.planRevision
}

export async function readSteeringReconciliationState(client: Client, scope: SteeringReconciliationScope): Promise<SteeringReconciliationState> {
  if (!validSteeringReconciliationScope(scope)) throw new Error("steering_reconciliation_scope_invalid")
  await lockTaskGraphScope(client, scope, true)
  const inputState = await readInputs(client, scope, scope.rootInputId)
  // Receipt history is separately provenance-checked before comparing it to current inputs.
  const graph = await client.query<Row>(`SELECT item."revision" FROM "agent_items" AS item WHERE item."id" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $4 AND item."type" = 'task_graph'`,
  [taskGraphItemId(scope.rootTaskId), scope.sessionId, scope.turnId, scope.rootTaskId])
  const revision = graph.rows.length ? Number(graph.rows[0]?.revision) : 0
  if (!steeringReconciliationRevision(revision)) throw new Error("steering_reconciliation_graph_invalid")
  const current = inputState.candidates
  const receipts = await readSteeringReconciliationHistory(client, scope, revision)
  const decision = scope.stepId ? await readCurrentDecisionStep(client, scope) : null
  const resolved = new Set<string>()
  for (const stored of receipts) {
    const receipt = stored.receipt
    if (decision && (stored.stepOrdinal > decision.ordinal || stored.stepOrdinal === decision.ordinal && stored.stepAttempt > decision.attempt)) throw new Error("steering_reconciliation_receipt_step_invalid")
    const through = BigInt(receipt.inputCheckpoint.throughSequence)
    const expected = current.filter(input => input.acceptedSequence <= through && !resolved.has(input.id))
    if (expected.some(input => !input.consumer || input.consumer.ordinal > stored.stepOrdinal
      || input.consumer.ordinal === stored.stepOrdinal && input.consumer.attempt > stored.stepAttempt)
      || expected.map(input => input.id).sort().join("\0") !== receipt.steerInputIds.join("\0")) throw new Error("steering_reconciliation_receipt_incomplete")
    expected.forEach(input => resolved.add(input.id))
  }
  const unresolvedInputs = current.filter(input => !resolved.has(input.id)).map(({ id, acceptedSequence, status, consumedByStepId, consumingOrdinal }) => ({ id, acceptedSequence, status, consumedByStepId, consumingOrdinal }))
  if (decision && current.some(input => !resolved.has(input.id) && input.consumer
    && (compareStep(input.consumer, decision) > 0 || input.acceptedSequence > decision.cursor))) throw new Error("steering_reconciliation_cursor_invalid")
  const agendaPlanRevision = decision ? await readAgenda(client, scope, decision.id) : null
  return { originalInputId: inputState.rootId, currentRevision: revision, decisionStepId: decision?.id ?? null,
    decisionStepOrdinal: decision?.ordinal ?? null, decisionStepAttempt: decision?.attempt ?? null,
    decisionInputThroughSequence: decision?.cursor ?? null, agendaPlanRevision,
    unresolvedInputs, resolvedInputIds: [...resolved].sort() }
}

async function readCurrentDecisionStep(client: Client, scope: SteeringReconciliationScope): Promise<Step> {
  const result = await client.query<Row>(`SELECT "id", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds"
    FROM "agent_steps" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 FOR UPDATE`,
  [scope.stepId, scope.sessionId, scope.turnId, scope.rootTaskId])
  const current = step(result.rows[0])
  if (!current || result.rows[0]?.taskId !== scope.rootTaskId || current.status !== "streaming" || current.attempt !== scope.parentAttemptCount) throw new Error("steering_reconciliation_decision_step_invalid")
  return current
}

export async function assertNoUnresolvedSteering(client: Client, scope: SteeringReconciliationScope): Promise<void> {
  const state = await readSteeringReconciliationState(client, scope)
  if (state.unresolvedInputs.length) throw new Error("steering_reconciliation_pending")
}
