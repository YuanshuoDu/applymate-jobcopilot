import type pg from "pg"
import { parseCognitiveAgendaReceipt } from "../turns/cognitive-agenda-receipt.js"
import { steeringReconciliationId, steeringReconciliationRevision, steeringReconciliationSequence, validSteeringReconciliationScope, STEERING_RECONCILIATION_MAX_UNRESOLVED_INPUTS,
  type SteeringReconciliationPendingInput, type SteeringReconciliationScope, type SteeringReconciliationState } from "./steering-reconciliation-contract.js"
import { lockTaskGraphScope } from "./task-graph-pg-state.js"
import { taskGraphItemId } from "./task-graph-snapshot.js"
import { readSteeringReconciliationHistory } from "./steering-reconciliation-history.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type StoredInput = Readonly<{ id: string; clientMessageId: string; delivery: string; status: string; acceptedSequence: bigint;
  consumedByStepId: string | null; consumedAt: Date | null; cancelledAt: Date | null }>
type Input = SteeringReconciliationPendingInput & Readonly<{ clientMessageId: string; cancelledAt: Date | null }>
type Step = Readonly<{ id: string; ordinal: number; attempt: number; status: string; cursor: bigint; ids: readonly string[] }>
type Candidate = Input & Readonly<{ consumer: Step | null }>
const INPUT_PAGE_SIZE = 64
const STEP_STATUSES = new Set(["streaming", "waiting_for_tool", "waiting_for_approval", "waiting_for_user", "completed", "failed", "interrupted"])

function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const prototype = Object.getPrototypeOf(parsed)
  return prototype === Object.prototype || prototype === null ? parsed as Row : null
}
function date(value: unknown): value is Date { return value instanceof Date && Number.isFinite(value.getTime()) }
function storedInput(row: Row | undefined): StoredInput {
  const acceptedSequence = row ? steeringReconciliationSequence(row.acceptedSequence) : null
  if (!row || !steeringReconciliationId(row.id) || !steeringReconciliationId(row.clientMessageId) || acceptedSequence === null
    || !["steer", "follow_up"].includes(String(row.delivery)) || !["accepted", "queued", "consumed", "cancelled", "rejected"].includes(String(row.status))
    || !(row.consumedByStepId === null || steeringReconciliationId(row.consumedByStepId))
    || !(row.consumedAt === null || date(row.consumedAt)) || !(row.cancelledAt === null || date(row.cancelledAt))) throw new Error("steering_reconciliation_input_invalid")
  return { id: row.id as string, clientMessageId: row.clientMessageId as string, delivery: String(row.delivery), status: String(row.status), acceptedSequence,
    consumedByStepId: row.consumedByStepId as string | null, consumedAt: row.consumedAt as Date | null, cancelledAt: row.cancelledAt as Date | null }
}
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

async function readOriginalInputId(client: Client, scope: SteeringReconciliationScope, hint?: string | null): Promise<string | null> {
  const turn = await client.query<Row>(`SELECT turn."input" FROM "agent_turns" AS turn JOIN "agent_sessions" AS session
    ON session."id" = turn."sessionId" AND session."userId" = turn."userId" WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND turn."rootTaskId" = $4`,
  [scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId])
  if (turn.rows.length !== 1) throw new Error("steering_reconciliation_turn_fenced")
  const bound = originalClientMessageId(turn.rows[0]?.input)
  if (bound === null) throw new Error("steering_reconciliation_original_input_invalid")
  let rootId: string | null = null
  if (bound !== undefined) {
    const matches = await client.query<Row>(`SELECT "id", "clientMessageId", "delivery", "status", "acceptedSequence", "consumedByStepId", "consumedAt", "cancelledAt"
      FROM "agent_inputs" WHERE "sessionId" = $1 AND "targetTurnId" = $2 AND "userId" = $3 AND "clientMessageId" = $4 ORDER BY "id" LIMIT 2`,
    [scope.sessionId, scope.turnId, scope.userId, bound])
    if (matches.rows.length !== 1 || storedInput(matches.rows[0]).clientMessageId !== bound) throw new Error("steering_reconciliation_original_input_invalid")
    rootId = matches.rows[0]!.id as string
  }
  if (bound !== undefined && hint !== undefined && hint !== null && hint !== rootId) throw new Error("steering_reconciliation_original_input_mismatch")
  return rootId
}

async function* readInputCandidates(client: Client, scope: SteeringReconciliationScope, rootId: string | null): AsyncGenerator<Candidate> {
  let afterSequence: bigint | null = null, afterId: string | null = null
  while (true) {
    const result: { rows: Row[] } = await client.query<Row>(`SELECT "id", "clientMessageId", "delivery", "status", "acceptedSequence", "consumedByStepId", "consumedAt", "cancelledAt"
      FROM "agent_inputs" WHERE "sessionId" = $1 AND "targetTurnId" = $2 AND "userId" = $3
        AND ($4::bigint IS NULL OR "acceptedSequence" > $4::bigint OR ("acceptedSequence" = $4::bigint AND "id" > $5::text))
      ORDER BY "acceptedSequence", "id" LIMIT ${INPUT_PAGE_SIZE}`,
    [scope.sessionId, scope.turnId, scope.userId, afterSequence?.toString() ?? null, afterId])
    if (!result.rows.length) return
    const page: StoredInput[] = result.rows.map((row: Row) => storedInput(row)), last: StoredInput = page.at(-1)!
    afterSequence = last.acceptedSequence
    afterId = last.id
    const active: StoredInput[] = page.filter((input: StoredInput) => input.id !== rootId && input.delivery === "steer" && ["accepted", "queued", "consumed"].includes(input.status))
    if (!active.length) continue
    const details: { rows: Row[] } = await client.query<Row>(`SELECT input."id", input."clientMessageId", input."delivery", input."status", input."acceptedSequence", input."consumedByStepId", input."consumedAt", input."cancelledAt",
        event."type" AS "acceptedType", event."actor" AS "acceptedActor", event."taskId" AS "acceptedTaskId", event."correlationId" AS "acceptedCorrelationId", event."itemId" AS "acceptedItemId", event."sequence" AS "acceptedEventSequence", event."payload" AS "acceptedPayload",
        accepted_item."type" AS "acceptedItemType", accepted_item."taskId" AS "acceptedItemTaskId", accepted_item."status" AS "acceptedItemStatus", accepted_item."content" AS "acceptedItemContent"
      FROM "agent_inputs" AS input LEFT JOIN "agent_events" AS event ON event."sessionId" = input."sessionId" AND event."turnId" = input."targetTurnId" AND event."sequence" = input."acceptedSequence"
      LEFT JOIN "agent_items" AS accepted_item ON accepted_item."id" = event."itemId" AND accepted_item."sessionId" = input."sessionId" AND accepted_item."turnId" = input."targetTurnId"
      WHERE input."sessionId" = $1 AND input."targetTurnId" = $2 AND input."userId" = $3 AND input."id" = ANY($4::text[])
        AND input."delivery" = 'steer' AND input."status" IN ('accepted', 'queued', 'consumed')`,
    [scope.sessionId, scope.turnId, scope.userId, active.map(input => input.id)])
    if (details.rows.length !== active.length) throw new Error("steering_reconciliation_input_invalid")
    const pageInputs = new Map<string, StoredInput>(active.map(input => [input.id, input])), acceptedById = new Map<string, { input: Input; consumerId: string | null }>()
    const detailIds = new Set<string>()
    for (const row of details.rows) {
      const stored = pageInputs.get(String(row.id))
      if (!stored || detailIds.has(stored.id) || stored.clientMessageId !== row.clientMessageId || stored.delivery !== row.delivery || stored.status !== row.status
        || stored.acceptedSequence.toString() !== String(row.acceptedSequence) || stored.consumedByStepId !== row.consumedByStepId) throw new Error("steering_reconciliation_input_invalid")
      detailIds.add(stored.id)
      const event = acceptedEvent(row, scope.turnId)
      if (!event || row.acceptedActor === null || row.acceptedEventSequence === null || String(row.acceptedEventSequence) !== stored.acceptedSequence.toString()) throw new Error("steering_reconciliation_acceptance_invalid")
      if (stored.status === "consumed") {
        if (!stored.consumedByStepId || !stored.consumedAt || !date(stored.consumedAt) || stored.cancelledAt !== null) throw new Error("steering_reconciliation_consumption_invalid")
      } else if (stored.consumedByStepId !== null || stored.consumedAt !== null || stored.cancelledAt !== null) throw new Error("steering_reconciliation_consumption_invalid")
      if (event.source === "user") acceptedById.set(stored.id, { input: { id: stored.id, clientMessageId: stored.clientMessageId, acceptedSequence: stored.acceptedSequence,
        status: stored.status as Input["status"], consumedByStepId: stored.consumedByStepId, consumingOrdinal: null, cancelledAt: stored.cancelledAt }, consumerId: stored.consumedByStepId })
    }
    if (detailIds.size !== active.length) throw new Error("steering_reconciliation_input_invalid")
    const consumerIds = active.map(input => acceptedById.get(input.id)?.consumerId).filter((id): id is string => id !== null && id !== undefined)
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
    for (const stored of active) {
      const entry = acceptedById.get(stored.id)
      if (!entry) continue
      if (!entry.consumerId) { yield { ...entry.input, consumer: null }; continue }
      const consumer = sourceById.get(entry.consumerId)
      if (!consumer || !consumer.ids.includes(entry.input.id) || consumer.cursor < entry.input.acceptedSequence) throw new Error("steering_reconciliation_consumption_invalid")
      yield { ...entry.input, consumingOrdinal: consumer.ordinal, consumer }
    }
  }
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
  const rootId = await readOriginalInputId(client, scope, scope.rootInputId)
  const candidates = readInputCandidates(client, scope, rootId)
  const graph = await client.query<Row>(`SELECT item."revision" FROM "agent_items" AS item WHERE item."id" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $4 AND item."type" = 'task_graph'`,
  [taskGraphItemId(scope.rootTaskId), scope.sessionId, scope.turnId, scope.rootTaskId])
  const revision = graph.rows.length ? Number(graph.rows[0]?.revision) : 0
  if (!steeringReconciliationRevision(revision)) throw new Error("steering_reconciliation_graph_invalid")
  const decision = scope.stepId ? await readCurrentDecisionStep(client, scope) : null
  const unresolved = new Map<string, Candidate>()
  let next = await candidates.next(), previousCheckpoint: bigint | null = null
  for await (const stored of readSteeringReconciliationHistory(client, scope, revision)) {
    if (decision && (stored.stepOrdinal > decision.ordinal || stored.stepOrdinal === decision.ordinal && stored.stepAttempt > decision.attempt)) throw new Error("steering_reconciliation_receipt_step_invalid")
    const through = BigInt(stored.receipt.inputCheckpoint.throughSequence)
    if (previousCheckpoint !== null && through <= previousCheckpoint) throw new Error("steering_reconciliation_receipt_history_invalid")
    previousCheckpoint = through
    while (!next.done && next.value.acceptedSequence <= through) {
      unresolved.set(next.value.id, next.value)
      if (unresolved.size > STEERING_RECONCILIATION_MAX_UNRESOLVED_INPUTS) throw new Error("steering_reconciliation_unresolved_overflow")
      next = await candidates.next()
    }
    const expected = [...unresolved.values()].filter(input => input.acceptedSequence <= through)
    if (expected.some(input => !input.consumer || input.consumer.ordinal > stored.stepOrdinal
      || input.consumer.ordinal === stored.stepOrdinal && input.consumer.attempt > stored.stepAttempt)
      || expected.map(input => input.id).sort().join("\0") !== stored.receipt.steerInputIds.join("\0")) throw new Error("steering_reconciliation_receipt_incomplete")
    expected.forEach(input => unresolved.delete(input.id))
  }
  while (!next.done) {
    unresolved.set(next.value.id, next.value)
    if (unresolved.size > STEERING_RECONCILIATION_MAX_UNRESOLVED_INPUTS) throw new Error("steering_reconciliation_unresolved_overflow")
    next = await candidates.next()
  }
  const current = [...unresolved.values()].sort(compareInput)
  if (decision && current.some(input => input.consumer && (compareStep(input.consumer, decision) > 0 || input.acceptedSequence > decision.cursor))) throw new Error("steering_reconciliation_cursor_invalid")
  const agendaPlanRevision = decision ? await readAgenda(client, scope, decision.id) : null
  return { originalInputId: rootId, currentRevision: revision, decisionStepId: decision?.id ?? null,
    decisionStepOrdinal: decision?.ordinal ?? null, decisionStepAttempt: decision?.attempt ?? null,
    decisionInputThroughSequence: decision?.cursor ?? null, agendaPlanRevision,
    unresolvedInputs: current.map(({ id, acceptedSequence, status, consumedByStepId, consumingOrdinal }) => ({ id, acceptedSequence, status, consumedByStepId, consumingOrdinal })) }
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
