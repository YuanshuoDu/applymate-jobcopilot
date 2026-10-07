import type pg from "pg"
import { parseTurnQuestionIntentEnvelope, TURN_QUESTION_INTENT_SCHEMA } from "./turn-question-contract.js"
import { completedQuestionResult, questionConflict, questionId, questionItemId, type TurnQuestionQueryClient } from "./turn-question-store-guards.js"
import {
  parseTurnQuestionPlanningReceipt, summarizeTurnQuestionPlanningReceipt, turnQuestionPlanningEventKey,
  TURN_QUESTION_PLANNING_EVENT_TYPE, TURN_QUESTION_PLANNING_SCHEMA_VERSION,
  type TurnQuestionPlanningReadOwner, type TurnQuestionPlanningSummary,
  type TurnQuestionPlanningReceipt, type TurnQuestionPlanningWaitRef,
} from "./turn-question-planning-contract.js"
import { COGNITIVE_AGENDA_EVENT_TYPE, parseCognitiveAgendaReceipt } from "./cognitive-agenda-receipt.js"
import { steeringReconciliationId, steeringReconciliationSequence } from "../subagents/steering-reconciliation-contract.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type EventRow = Row & { id: string; idempotencyKey: string; payload: unknown }
function object(value: unknown): Row | null {
  if (typeof value === "string") { try { value = JSON.parse(value) as unknown } catch { return null } }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Row : null
}
function validOwner(owner: TurnQuestionPlanningReadOwner): boolean {
  return [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId].every(value => typeof value === "string" && value.trim() === value && value.length > 0)
}
function validWait(wait: TurnQuestionPlanningWaitRef, owner: TurnQuestionPlanningReadOwner): boolean {
  return typeof wait.stepId === "string" && wait.stepId.trim() === wait.stepId && wait.stepId.length > 0
    && typeof wait.toolCallId === "string" && wait.toolCallId.trim() === wait.toolCallId && wait.toolCallId.length > 0
    && steeringReconciliationId(wait.waitId) && steeringReconciliationId(wait.questionItemId)
}
function matchEvent(row: EventRow, owner: TurnQuestionPlanningReadOwner, wait: TurnQuestionPlanningWaitRef): boolean {
  const receipt = parseTurnQuestionPlanningReceipt(row.payload)
  return wait.waitId === questionId({ sessionId: owner.sessionId, turnId: owner.turnId }, wait.stepId, wait.toolCallId)
    && wait.questionItemId === questionItemId(wait.waitId)
    && row.sessionId === owner.sessionId && row.turnId === owner.turnId && row.taskId === owner.rootTaskId
    && row.itemId === null && row.type === TURN_QUESTION_PLANNING_EVENT_TYPE && row.actor === "orchestrator"
    && row.correlationId === owner.turnId && row.causationId === null
    && row.idempotencyKey === turnQuestionPlanningEventKey(owner.turnId, wait.waitId)
    && Boolean(receipt && receipt.sessionId === owner.sessionId && receipt.turnId === owner.turnId
      && receipt.rootTaskId === owner.rootTaskId && receipt.stepId === wait.stepId && receipt.toolCallId === wait.toolCallId
      && receipt.waitId === wait.waitId && receipt.questionItemId === wait.questionItemId)
}

async function eventRows(client: Queryable, owner: TurnQuestionPlanningReadOwner, waits: readonly TurnQuestionPlanningWaitRef[]): Promise<EventRow[]> {
  if (!waits.length) return []
  const keys = waits.map(wait => turnQuestionPlanningEventKey(owner.turnId, wait.waitId))
  const ids = waits.map(wait => wait.waitId)
  const result = await client.query<EventRow>(`SELECT event."id", event."sessionId", event."turnId", event."itemId", event."taskId", event."sequence", event."type", event."actor", event."correlationId", event."causationId", event."idempotencyKey", event."payload"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId" AND session."userId" = $5
      JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
        AND turn."userId" = $5 AND turn."rootTaskId" = $6
    WHERE event."sessionId" = $1 AND (event."idempotencyKey" = ANY($2::text[])
      OR (event."turnId" = $3 AND event."payload"->>'waitId' = ANY($4::text[])
        AND (event."type" = $7 OR event."payload"->>'schemaVersion' = $8)))`,
  [owner.sessionId, keys, owner.turnId, ids, owner.userId, owner.rootTaskId,
    TURN_QUESTION_PLANNING_EVENT_TYPE, TURN_QUESTION_PLANNING_SCHEMA_VERSION])
  return result.rows
}

async function validateQuestionLineage(client: TurnQuestionQueryClient, owner: TurnQuestionPlanningReadOwner,
  wait: TurnQuestionPlanningWaitRef, receipt: TurnQuestionPlanningReceipt, answeredOnly: boolean): Promise<void> {
  const ownerIdentity = { sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.rootTaskId }
  const call = await completedQuestionResult(client, ownerIdentity, wait.stepId, wait.toolCallId)
  const itemResult = await client.query<Row>(`SELECT item."stepId", item."taskId", item."type", item."status", item."content" FROM "agent_items" AS item
    JOIN "agent_sessions" AS session ON session."id" = item."sessionId" AND session."userId" = $4
    JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
      AND turn."userId" = $4 AND turn."rootTaskId" = $5
    WHERE item."id" = $1 AND item."sessionId" = $2 AND item."turnId" = $3`, [wait.questionItemId, owner.sessionId, owner.turnId, owner.userId, owner.rootTaskId])
  const item = itemResult.rows[0], content = object(item?.content)
  if (itemResult.rows.length !== 1 || !item || item.stepId !== wait.stepId || item.taskId !== owner.rootTaskId || item.type !== "question"
    || !content || Object.keys(content).sort().join(",") !== "answer,answerAvailable,options,question,questionId,stage,toolCallId,waitKind"
    || content.questionId !== wait.waitId || content.toolCallId !== wait.toolCallId || content.waitKind !== "question" || content.stage !== "user_input") {
    throw questionConflict(`planning clarification wait ${wait.waitId}`)
  }
  const waitIntent = parseTurnQuestionIntentEnvelope({ schemaVersion: TURN_QUESTION_INTENT_SCHEMA, kind: "user_question", stage: "user_input",
    question: content.question, options: content.options })
  if (!waitIntent || JSON.stringify(waitIntent) !== JSON.stringify(call.intent)) throw questionConflict(`planning clarification intent ${wait.waitId}`)
  const answered = item.status === "completed" && content.answerAvailable === true && content.answer !== null && content.answer !== undefined
  const unanswered = item.status === "started" && content.answerAvailable === false && content.answer === null
  const closed = (item.status === "failed" || item.status === "interrupted") && content.answerAvailable === false && content.answer === null
  if (answeredOnly ? !answered : !answered && !unanswered && !closed) throw questionConflict(`planning clarification answer ${wait.waitId}`)
  const step = await client.query<Row>(`SELECT step."id", step."taskId", step."attempt", step."inputThroughSequence", step."consumedInputIds"
    FROM "agent_steps" AS step JOIN "agent_sessions" AS session
    ON session."id" = step."sessionId" AND session."userId" = $5
    JOIN "agent_turns" AS turn ON turn."id" = step."turnId" AND turn."sessionId" = step."sessionId"
      AND turn."userId" = $5 AND turn."rootTaskId" = $4
    WHERE step."id" = $1 AND step."sessionId" = $2 AND step."turnId" = $3 AND step."taskId" = $4`,
  [wait.stepId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.userId])
  const stepRow = step.rows[0]
  const cursor = steeringReconciliationSequence(stepRow?.inputThroughSequence)
  const consumed = objectArray(stepRow?.consumedInputIds)
  if (step.rows.length !== 1 || !stepRow || stepRow.taskId !== owner.rootTaskId || !Number.isSafeInteger(Number(stepRow.attempt))
    || Number(stepRow.attempt) < 1 || cursor === null || cursor.toString() !== receipt.inputCheckpoint.throughSequence
    || !consumed || JSON.stringify(consumed) !== JSON.stringify(receipt.inputCheckpoint.consumedInputIds)) {
    throw questionConflict(`planning clarification checkpoint ${wait.stepId}`)
  }
  const agenda = await client.query<Row>(`SELECT event."actor", event."itemId", event."taskId", event."correlationId", event."payload"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId" AND session."userId" = $6
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
      AND turn."userId" = $6 AND turn."rootTaskId" = $7
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = $5
      AND event."taskId" = $3 AND event."correlationId" = $4 AND event."itemId" IS NULL
    ORDER BY event."sequence" DESC LIMIT 2`, [owner.sessionId, owner.turnId, owner.rootTaskId, wait.stepId, COGNITIVE_AGENDA_EVENT_TYPE, owner.userId, owner.rootTaskId])
  const agendaRow = agenda.rows[0]
  const parsedAgenda = agendaRow && ["subagent", "orchestrator"].includes(String(agendaRow.actor)) && agendaRow.itemId === null
    && agendaRow.taskId === owner.rootTaskId && agendaRow.correlationId === wait.stepId
    ? parseCognitiveAgendaReceipt(agendaRow.payload, { sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.rootTaskId, stepId: wait.stepId }) : null
  if (agenda.rows.length !== 1 || !parsedAgenda || parsedAgenda.planRevision !== receipt.observedPlanRevision) {
    throw questionConflict(`planning clarification agenda ${wait.stepId}`)
  }
}

function objectArray(value: unknown): string[] | null {
  let parsed = value
  if (typeof parsed === "string") { try { parsed = JSON.parse(parsed) as unknown } catch { return null } }
  if (!Array.isArray(parsed) || parsed.length > 256 || !parsed.every(steeringReconciliationId)
    || new Set(parsed).size !== parsed.length) return null
  return parsed as string[]
}

async function readOne(client: Queryable, owner: TurnQuestionPlanningReadOwner, wait: TurnQuestionPlanningWaitRef,
  rows: readonly EventRow[], answeredOnly: boolean): Promise<TurnQuestionPlanningSummary | null> {
  const expectedKey = turnQuestionPlanningEventKey(owner.turnId, wait.waitId)
  const matching = rows.filter(row => {
    const payload = object(row.payload)
    return row.idempotencyKey === expectedKey || (row.turnId === owner.turnId && payload?.waitId === wait.waitId
      && (row.type === TURN_QUESTION_PLANNING_EVENT_TYPE || payload.schemaVersion === TURN_QUESTION_PLANNING_SCHEMA_VERSION))
  })
  if (!matching.length) return null
  if (matching.length !== 1 || !matchEvent(matching[0]!, owner, wait)) throw questionConflict(`planning clarification receipt ${wait.waitId}`)
  const event = matching[0]!, receipt = parseTurnQuestionPlanningReceipt(event.payload)
  if (!receipt || typeof event.id !== "string" || !event.id.trim() || steeringReconciliationSequence(event.sequence) === null) {
    throw questionConflict(`planning clarification receipt ${wait.waitId}`)
  }
  await validateQuestionLineage(client as TurnQuestionQueryClient, owner, wait, receipt, answeredOnly)
  const outbox = await client.query(`SELECT "id" FROM "agent_outbox" WHERE "idempotencyKey" = $1`, [`agent-event:${event.id}`])
  if (outbox.rows.length !== 0) throw questionConflict(`private planning clarification outbox ${wait.waitId}`)
  return summarizeTurnQuestionPlanningReceipt(receipt)
}

export async function readTurnQuestionPlanningWait(client: Queryable, owner: TurnQuestionPlanningReadOwner,
  wait: TurnQuestionPlanningWaitRef): Promise<TurnQuestionPlanningSummary | null> {
  if (!validOwner(owner) || !validWait(wait, owner)) throw questionConflict("planning clarification wait scope")
  const rows = await eventRows(client, owner, [wait])
  return readOne(client, owner, wait, rows, false)
}

export async function readTurnQuestionPlanningHistory(client: Queryable, owner: TurnQuestionPlanningReadOwner,
  waits: readonly TurnQuestionPlanningWaitRef[]): Promise<readonly TurnQuestionPlanningSummary[]> {
  if (!validOwner(owner) || !Array.isArray(waits) || waits.length > 64 || !waits.every(wait => validWait(wait, owner))) {
    throw questionConflict("planning clarification history scope")
  }
  if (new Set(waits.map(wait => wait.waitId)).size !== waits.length || new Set(waits.map(wait => wait.questionItemId)).size !== waits.length) {
    throw questionConflict("planning clarification history duplicates")
  }
  if (waits.length) {
    const turn = await client.query(`SELECT "id" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "rootTaskId" = $4`,
      [owner.turnId, owner.sessionId, owner.userId, owner.rootTaskId])
    if (turn.rows.length !== 1) throw questionConflict("planning clarification owner")
  }
  const rows = await eventRows(client, owner, waits), summaries: TurnQuestionPlanningSummary[] = []
  for (const wait of waits) {
    const summary = await readOne(client, owner, wait, rows, true)
    if (summary) summaries.push(summary)
  }
  return summaries
}
