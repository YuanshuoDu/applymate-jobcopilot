import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { createHash } from "node:crypto"
import { matchesAgentOutboxIdentity, type AgentOutboxIdentity, type AgentOutboxPayload } from "../outbox-identity.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { toRepositoryJson } from "./turn-engine-types.js"
import { questionConflict, type TurnQuestionQueryClient } from "./turn-question-store-guards.js"

type EventInput = Readonly<{ owner: TurnExecutionOwnerFence; id: string; type: string; itemId: string | null; correlationId: string; causationId: string | null; idempotencyKey: string; payload: RepositoryJsonValue }>
type Row = Record<string, unknown>
function json(value: RepositoryJsonValue): string { return JSON.stringify(value) }
function same(left: unknown, right: unknown): boolean { try { return JSON.stringify(toRepositoryJson(left)) === JSON.stringify(toRepositoryJson(right)) } catch { return false } }
function outbox(input: EventInput, sequence: string): AgentOutboxIdentity {
  const payload: AgentOutboxPayload = { eventId: input.id, sessionId: input.owner.sessionId, turnId: input.owner.turnId, taskId: input.owner.taskId,
    itemId: input.itemId, sequence, type: input.type, actor: "orchestrator", correlationId: input.correlationId,
    causationId: input.causationId, idempotencyKey: input.idempotencyKey, payload: input.payload }
  return { id: `agent-outbox-${input.id}`, topic: "agent.events", aggregateId: input.owner.sessionId, idempotencyKey: `agent-event:${input.id}`, payload }
}
async function appendOne(client: TurnQuestionQueryClient, input: EventInput): Promise<void> {
  const found = await client.query<Row>(`SELECT "id", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload"
    FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2 FOR UPDATE`, [input.owner.sessionId, input.idempotencyKey])
  let sequence: string
  if (found.rows[0]) {
    const row = found.rows[0]
    if (row.id !== input.id || row.turnId !== input.owner.turnId || row.itemId !== input.itemId || row.taskId !== input.owner.taskId
      || row.type !== input.type || row.actor !== "orchestrator" || row.correlationId !== input.correlationId || row.causationId !== input.causationId
      || row.idempotencyKey !== input.idempotencyKey || !same(row.payload, input.payload)) throw questionConflict(`event ${input.idempotencyKey}`)
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
  const saved = await client.query<Row>(`SELECT "id", "topic", "aggregateId", "idempotencyKey", "payload" FROM "agent_outbox" WHERE "idempotencyKey" = $1 FOR UPDATE`, [expected.idempotencyKey])
  if (!matchesAgentOutboxIdentity(saved.rows[0], expected)) throw questionConflict(`outbox ${expected.idempotencyKey}`)
}

export async function appendScheduledGateChoiceWaitEvents(client: TurnQuestionQueryClient, input: Readonly<{
  owner: TurnExecutionOwnerFence; stepId: string; itemId: string; waitId: string
}>): Promise<void> {
  const previous = await client.query<{ id: string }>(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 ORDER BY "sequence" DESC LIMIT 1`,
    [input.owner.sessionId, input.owner.turnId, input.owner.taskId])
  const digest = createHash("sha256").update(JSON.stringify([input.owner.turnId, input.waitId])).digest("hex")
  const stepEventId = `agent-scheduled-gate-choice-step-${digest}`, stepKey = `turn:${input.owner.turnId}:event:step-completed:${input.stepId}`
  await appendOne(client, { owner: input.owner, id: stepEventId, type: "step.completed", itemId: null, correlationId: input.stepId,
    causationId: previous.rows[0]?.id ?? null, idempotencyKey: stepKey,
    payload: { stepId: input.stepId, status: "waiting_for_user", taskId: input.owner.taskId } })
  await appendOne(client, { owner: input.owner, id: `agent-scheduled-gate-choice-item-${digest}`, type: "item.started", itemId: input.itemId,
    correlationId: input.itemId, causationId: stepEventId, idempotencyKey: `agent-wait:${input.itemId}:started`,
    payload: { itemId: input.itemId, waitKind: "question", questionId: input.waitId, toolCallId: null } })
}
