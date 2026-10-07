import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { matchesAgentOutboxIdentity, type AgentOutboxIdentity, type AgentOutboxPayload } from "../outbox-identity.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { toRepositoryJson } from "./turn-engine-types.js"
import { questionConflict, type TurnQuestionQueryClient } from "./turn-question-store-guards.js"

type Row = Record<string, unknown>
export type TurnQuestionStartedEventInput = {
  readonly owner: TurnExecutionOwnerFence
  readonly stepId: string
  readonly itemId: string
  readonly questionId: string
  readonly toolCallId: string
  readonly toolCallCount: number
}
type EventInput = {
  readonly owner: TurnExecutionOwnerFence; readonly id: string; readonly type: string; readonly itemId: string | null
  readonly correlationId: string; readonly causationId: string | null; readonly idempotencyKey: string; readonly payload: RepositoryJsonValue
}
function json(value: RepositoryJsonValue): string { return JSON.stringify(value) }
function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(toRepositoryJson(left)) === JSON.stringify(toRepositoryJson(right)) }

function eventId(input: TurnQuestionStartedEventInput, phase: "step" | "question"): string {
  return phase === "step" ? `agent-question-step-event-${input.stepId}` : `agent-question-item-event-${input.questionId}`
}
function outbox(input: EventInput, sequence: string): AgentOutboxIdentity {
  const payload: AgentOutboxPayload = {
    eventId: input.id, sessionId: input.owner.sessionId, turnId: input.owner.turnId, taskId: input.owner.taskId,
    itemId: input.itemId, sequence, type: input.type, actor: "orchestrator", correlationId: input.correlationId,
    causationId: input.causationId, idempotencyKey: input.idempotencyKey, payload: input.payload,
  }
  return { id: `agent-outbox-${input.id}`, topic: "agent.events", aggregateId: input.owner.sessionId, idempotencyKey: `agent-event:${input.id}`, payload }
}

async function appendOne(client: TurnQuestionQueryClient, input: EventInput): Promise<void> {
  const existing = await client.query<Row>(`SELECT "id", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload"
    FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2 FOR UPDATE`, [input.owner.sessionId, input.idempotencyKey])
  let sequence: string
  if (existing.rows[0]) {
    const row = existing.rows[0]
    if (row.id !== input.id || row.turnId !== input.owner.turnId || row.itemId !== input.itemId || row.taskId !== input.owner.taskId
      || row.type !== input.type || row.actor !== "orchestrator" || row.correlationId !== input.correlationId || row.causationId !== input.causationId
      || row.idempotencyKey !== input.idempotencyKey || !sameJson(row.payload, input.payload)) throw questionConflict(`event ${input.idempotencyKey}`)
    sequence = String(row.sequence)
  } else {
    const next = await client.query<{ eventSequence: string | number | bigint }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
      WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"`, [input.owner.sessionId, input.owner.userId])
    if (next.rows[0]?.eventSequence === undefined) throw questionConflict(`event sequence ${input.owner.sessionId}`)
    sequence = String(next.rows[0].eventSequence)
    await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'orchestrator', $8, $9, $10, $11::jsonb)`,
    [input.id, input.owner.sessionId, input.owner.turnId, input.itemId, input.owner.taskId, sequence, input.type, input.correlationId, input.causationId, input.idempotencyKey, json(input.payload)])
  }
  const expected = outbox(input, sequence)
  const inserted = await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
    VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING`, [expected.id, expected.topic, expected.aggregateId, expected.idempotencyKey, json(expected.payload as RepositoryJsonValue)])
  if ((inserted.rowCount ?? 0) === 1) return
  const stored = await client.query<Row>(`SELECT "id", "topic", "aggregateId", "idempotencyKey", "payload" FROM "agent_outbox" WHERE "idempotencyKey" = $1 FOR UPDATE`, [expected.idempotencyKey])
  if (!matchesAgentOutboxIdentity(stored.rows[0], expected)) throw questionConflict(`outbox ${expected.idempotencyKey}`)
}

export async function appendQuestionStartedEvents(client: TurnQuestionQueryClient, input: TurnQuestionStartedEventInput): Promise<void> {
  const previous = await client.query<{ id: string }>(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 ORDER BY "sequence" DESC LIMIT 1`,
    [input.owner.sessionId, input.owner.turnId, input.owner.taskId])
  const stepKey = `turn:${input.owner.turnId}:event:step-completed:${input.stepId}`
  await appendOne(client, {
    owner: input.owner, id: eventId(input, "step"), type: "step.completed", itemId: null,
    correlationId: input.stepId, causationId: previous.rows[0]?.id ?? null, idempotencyKey: stepKey,
    payload: { stepId: input.stepId, status: "waiting_for_user", toolCallCount: input.toolCallCount, taskId: input.owner.taskId },
  })
  const questionKey = `agent-wait:${input.itemId}:started`
  await appendOne(client, {
    owner: input.owner, id: eventId(input, "question"), type: "item.started", itemId: input.itemId,
    correlationId: input.itemId, causationId: input.questionId, idempotencyKey: questionKey,
    payload: { itemId: input.itemId, waitKind: "question", questionId: input.questionId, toolCallId: input.toolCallId },
  })
}

export async function appendQuestionPauseEvents(client: TurnQuestionQueryClient, input: {
  readonly owner: TurnExecutionOwnerFence; readonly stepId: string; readonly toolCallId: string
  readonly callItemId: string | null; readonly resultItemId: string | null; readonly digest: string
}): Promise<void> {
  const base = `turn:${input.owner.turnId}:event:question-pause:${input.digest}`
  const keys = [`${base}:call`, `${base}:item`, `${base}:result`, `${base}:step`]
  const existingCall = input.callItemId ? await client.query<Row>(`SELECT "id", "causationId" FROM "agent_events"
    WHERE "sessionId" = $1 AND "idempotencyKey" = $2 FOR UPDATE`, [input.owner.sessionId, `${base}:call`]) : null
  const previous = await client.query<{ id: string }>(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
    AND NOT ("idempotencyKey" = ANY($4::text[])) ORDER BY "sequence" DESC LIMIT 1`, [input.owner.sessionId, input.owner.turnId, input.owner.taskId, keys])
  const existingCause = existingCall?.rows[0]?.causationId
  if (existingCall?.rows[0] && existingCause !== null && typeof existingCause !== "string") throw questionConflict(`event ${base}:call causation`)
  let cause: string | null = existingCall?.rows[0] ? existingCause as string | null : previous.rows[0]?.id ?? null
  if (input.callItemId) {
    const callId = `agent-question-pause-call-${input.digest}`
    await appendOne(client, { owner: input.owner, id: callId, type: "tool_call.failed", itemId: input.callItemId,
      correlationId: input.toolCallId, causationId: cause, idempotencyKey: `${base}:call`,
      payload: { toolCallId: input.toolCallId, toolName: "agent.ask_user", status: "cancelled", errorCode: null, taskId: input.owner.taskId } })
    const itemId = `agent-question-pause-item-${input.digest}`
    await appendOne(client, { owner: input.owner, id: itemId, type: "item.delta", itemId: input.callItemId,
      correlationId: input.callItemId, causationId: callId, idempotencyKey: `${base}:item`,
      payload: { itemId: input.callItemId, status: "interrupted", content: { toolCallId: input.toolCallId, toolName: "agent.ask_user", toolVersion: "1", status: "cancelled", errorCode: null } } })
    cause = itemId
    if (input.resultItemId) {
      const resultId = `agent-question-pause-result-${input.digest}`
      await appendOne(client, { owner: input.owner, id: resultId, type: "item.delta", itemId: input.resultItemId,
        correlationId: input.resultItemId, causationId: itemId, idempotencyKey: `${base}:result`,
        payload: { itemId: input.resultItemId, status: "interrupted", content: { toolCallId: input.toolCallId, output: null, status: "cancelled", errorCode: null } } })
      cause = resultId
    }
  }
  await appendOne(client, { owner: input.owner, id: `agent-question-pause-step-${input.digest}`, type: "step.completed", itemId: null,
    correlationId: input.stepId, causationId: cause, idempotencyKey: `${base}:step`,
    payload: { stepId: input.stepId, status: "interrupted", errorCode: "session_pause_requested", toolCallCount: 1, taskId: input.owner.taskId } })
}
