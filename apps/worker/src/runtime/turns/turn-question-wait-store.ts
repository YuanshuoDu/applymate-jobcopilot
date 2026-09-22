import { Buffer } from "node:buffer"
import type pg from "pg"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"

import { matchesAgentOutboxIdentity, type AgentOutboxIdentity, type AgentOutboxPayload } from "../outbox-identity.js"
import type { ExecutionOwnerFence } from "../execution-owner.js"
import { ownerFenceSql } from "./turn-engine-owner-sql.js"
import { canonicalQuestionId, toRepositoryJson, type TurnEngineQuestionOption, type TurnEngineQuestionWait } from "./turn-engine-types.js"

type Pool = Pick<pg.Pool, "connect">
type Client = Pick<pg.PoolClient, "query" | "release">
type Row = Record<string, unknown>
type QuestionOutboxPayload = Omit<AgentOutboxPayload, "taskId"> & { readonly taskId: null }
type QuestionOutboxIdentity = Omit<AgentOutboxIdentity, "payload"> & { readonly payload: QuestionOutboxPayload }

export const QUESTION_MAX_OPTIONS = 16
export const QUESTION_MAX_TEXT_BYTES = 4 * 1024
export const QUESTION_MAX_OPTION_VALUE_BYTES = 512
export const QUESTION_MAX_OPTION_LABEL_BYTES = 1 * 1024

function json(value: RepositoryJsonValue): string { return JSON.stringify(value) }
function conflict(resource: string): Error {
  const error = new Error(`TurnEngine persistence conflict: ${resource}`)
  error.name = "TurnEnginePersistenceConflict"
  return error
}
function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null"
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`
  return "null"
}
function sameJson(left: unknown, right: unknown): boolean {
  try { return stableJson(left) === stableJson(right) } catch { return false }
}
export function isQuestionText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) && Buffer.byteLength(value, "utf8") <= maxBytes
}
export function parseQuestionOptions(value: unknown): readonly TurnEngineQuestionOption[] | null {
  if (!Array.isArray(value) || value.length > QUESTION_MAX_OPTIONS) return null
  const options: TurnEngineQuestionOption[] = []
  for (const option of value) {
    if (!option || typeof option !== "object" || Array.isArray(option)) return null
    const row = option as Record<string, unknown>
    if (Object.keys(row).some(key => key !== "value" && key !== "label") || !Object.hasOwn(row, "value") || !Object.hasOwn(row, "label")
      || !isQuestionText(row.value, QUESTION_MAX_OPTION_VALUE_BYTES) || !isQuestionText(row.label, QUESTION_MAX_OPTION_LABEL_BYTES)
      || options.some(existing => existing.value === row.value)) return null
    options.push({ value: row.value, label: row.label })
  }
  return options
}
function text(value: unknown, name: string, limit: number): string {
  if (!isQuestionText(value, limit)) throw conflict(`${name} identity`)
  return value
}
function validate(input: { owner: ExecutionOwnerFence; stepId: string; question: TurnEngineQuestionWait }): void {
  if (input.owner.kind !== "turn") throw conflict(`child question wait ${input.owner.taskId}`)
  text(input.question.turnId, "turn", 256)
  if (input.question.turnId !== input.owner.turnId) throw conflict("question turn identity")
  text(input.stepId, "step", 256)
  text(input.question.questionId, "question", 256)
  text(input.question.toolCallId, "tool call", 256)
  text(input.question.question, "question text", QUESTION_MAX_TEXT_BYTES)
  text(input.question.planCallId, "plan call", 256)
  text(input.question.localId, "local id", 128)
  if (!Number.isSafeInteger(input.question.goalRevision) || input.question.goalRevision < 1 || !Number.isSafeInteger(input.question.planRevision) || input.question.planRevision < 1) throw conflict("question revision")
  if (input.question.questionId !== canonicalQuestionId(input.question.turnId, input.question.planCallId, input.question.planRevision, input.question.localId)) throw conflict("question identity")
  if (!parseQuestionOptions(input.question.options)) throw conflict("question options")
  const content = questionContent(input.question)
  const encoded = JSON.stringify(content)
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 24 * 1024) throw conflict("question content")
}
function questionContent(question: TurnEngineQuestionWait): RepositoryJsonValue {
  return toRepositoryJson({
    waitKind: "question", questionId: question.questionId, stage: "plan", question: question.question,
    options: question.options, toolCallId: question.toolCallId, pending: true, answerAvailable: false,
  })
}
async function transaction<T>(pool: Pool, owner: ExecutionOwnerFence, work: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect(); let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", owner.userId])
    const result = await work(client)
    await client.query("COMMIT"); committed = true
    return result
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}
async function lockSession(client: Client, owner: ExecutionOwnerFence): Promise<void> {
  const result = await client.query<Row>(`SELECT "id" FROM "agent_sessions"
    WHERE "id" = $1 AND "userId" = $2 AND "status" NOT IN ('aborted', 'archived') FOR UPDATE`, [owner.sessionId, owner.userId])
  if (!result.rows[0]) throw conflict(`session ${owner.sessionId}`)
}
async function lockTurn(client: Client, owner: ExecutionOwnerFence): Promise<{ status: string; revision: number }> {
  const fence = ownerFenceSql(owner, 1, true)
  const result = await client.query<Row>(`SELECT turn."status", turn."revision" FROM "agent_turns" AS turn ${fence.joins}
    WHERE turn."id" = $5 AND turn."sessionId" = $6 AND ${fence.where} FOR UPDATE`, [...fence.values, owner.turnId, owner.sessionId])
  const row = result.rows[0]
  if (!row || typeof row.status !== "string" || !Number.isSafeInteger(Number(row.revision))) throw conflict(`turn ${owner.turnId}`)
  return { status: row.status, revision: Number(row.revision) }
}
async function assertStep(client: Client, owner: ExecutionOwnerFence, stepId: string): Promise<void> {
  const result = await client.query<Row>(`SELECT "id" FROM "agent_steps"
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 AND "attempt" = 1`, [stepId, owner.sessionId, owner.turnId, owner.taskId])
  if (!result.rows[0]) throw conflict(`step ${stepId} lineage`)
}
function eventPayload(owner: ExecutionOwnerFence, itemId: string, eventId: string, sequence: string, idempotencyKey: string, question: TurnEngineQuestionWait): QuestionOutboxPayload {
  const payload = toRepositoryJson({ itemId, waitKind: "question", questionId: question.questionId, toolCallId: question.toolCallId })
  return { eventId, sessionId: owner.sessionId, turnId: owner.turnId, taskId: null, itemId, sequence, type: "item.started", actor: "orchestrator", correlationId: itemId, causationId: question.questionId, idempotencyKey, payload }
}
async function repairOutbox(client: Client, expected: QuestionOutboxIdentity): Promise<void> {
  const inserted = await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
    VALUES ($1, 'agent.session.event', $2, $3, $4::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING`, [expected.id, expected.aggregateId, expected.idempotencyKey, json(expected.payload)])
  if ((inserted.rowCount ?? 0) === 1) return
  const existing = await client.query<Row>(`SELECT "id", "topic", "aggregateId", "idempotencyKey", "payload" FROM "agent_outbox" WHERE "idempotencyKey" = $1 FOR UPDATE`, [expected.idempotencyKey])
  if (!matchesAgentOutboxIdentity(existing.rows[0], expected as unknown as AgentOutboxIdentity)) throw conflict(`question outbox ${expected.idempotencyKey} identity`)
}
async function ensureStartedEvent(client: Client, owner: ExecutionOwnerFence, itemId: string, question: TurnEngineQuestionWait): Promise<void> {
  const eventId = `agent-wait-event:${question.questionId}:started`
  const idempotencyKey = `agent-wait:${itemId}:started`
  const existing = await client.query<Row>(`SELECT "id", "taskId", "turnId", "itemId", "type", "correlationId", "causationId", "sequence", "actor", "payload"
    FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2 FOR UPDATE`, [owner.sessionId, idempotencyKey])
  if (existing.rows[0]) {
    const row = existing.rows[0]
    if (row.taskId !== null || row.turnId !== owner.turnId || row.itemId !== itemId || row.type !== "item.started" || row.correlationId !== itemId || row.causationId !== question.questionId || row.actor !== "orchestrator" || !sameJson(row.payload, { itemId, waitKind: "question", questionId: question.questionId, toolCallId: question.toolCallId })) throw conflict(`question event ${idempotencyKey} identity`)
    await repairOutbox(client, { id: `agent-outbox-${String(row.id)}`, topic: "agent.session.event", aggregateId: owner.sessionId, idempotencyKey: `agent-event:${String(row.id)}`, payload: eventPayload(owner, itemId, String(row.id), String(row.sequence), idempotencyKey, question) })
    return
  }
  const sequenceResult = await client.query<{ eventSequence: bigint | string }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1 WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"`, [owner.sessionId, owner.userId])
  const sequence = sequenceResult.rows[0]?.eventSequence
  if (sequence === undefined) throw conflict(`session ${owner.sessionId} event sequence`)
  const envelope = eventPayload(owner, itemId, eventId, BigInt(sequence).toString(), idempotencyKey, question)
  await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
    VALUES ($1, $2, $3, $4, $5, $6, 'item.started', 'orchestrator', $4, $7, $8, $9::jsonb)`, [eventId, owner.sessionId, owner.turnId, itemId, null, envelope.sequence, question.questionId, idempotencyKey, json(envelope.payload)])
  await repairOutbox(client, { id: `agent-outbox-${eventId}`, topic: "agent.session.event", aggregateId: owner.sessionId, idempotencyKey: `agent-event:${eventId}`, payload: envelope })
}
export async function createPgQuestionWait(pool: Pool, input: { owner: ExecutionOwnerFence; stepId: string; now: Date; question: TurnEngineQuestionWait }): Promise<{ itemId: string; turnRevision: number }> {
  validate(input)
  if (input.owner.kind !== "turn") throw conflict(`child question wait ${input.owner.taskId}`)
  const itemId = `agent-wait:question:${input.question.questionId}`
  return transaction(pool, input.owner, async client => {
    await lockSession(client, input.owner)
    const turn = await lockTurn(client, input.owner)
    const content = questionContent(input.question)
    await assertStep(client, input.owner, input.stepId)
    const existing = await client.query<Row>(`SELECT "id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 FOR UPDATE`, [itemId, input.owner.sessionId, input.owner.turnId])
    const row = existing.rows[0]
    if (row && (row.stepId !== input.stepId || row.taskId !== null || row.type !== "question" || row.status !== "started" || row.phase !== "commentary" || Number(row.revision) !== 0 || !sameJson(row.content, content))) throw conflict(`question item ${itemId} identity`)
    if (!row && turn.status === "waiting_for_user") throw conflict(`question item ${itemId} stale wait`)
    if (!row) {
      await client.query(`INSERT INTO "agent_items"
        ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, 'question', 'started', 'commentary', 0, $6::jsonb, $7, $7)`,
        [itemId, input.owner.sessionId, input.owner.turnId, input.stepId, null, json(content), input.now])
    }
    if (turn.status === "in_progress") {
      const fence = ownerFenceSql(input.owner, 5, false)
      const updated = await client.query(`UPDATE "agent_turns" AS turn SET "status" = 'waiting_for_user', "revision" = "revision" + 1, "completedAt" = NULL, "updatedAt" = $1 ${fence.joins}
        WHERE turn."id" = $2 AND turn."sessionId" = $3 AND turn."revision" = $4 AND ${fence.where}`, [input.now, input.owner.turnId, input.owner.sessionId, turn.revision, ...fence.values])
      if (updated.rowCount !== 1) throw conflict(`turn ${input.owner.turnId} wait state`)
      await ensureStartedEvent(client, input.owner, itemId, input.question)
      return { itemId, turnRevision: turn.revision + 1 }
    }
    await ensureStartedEvent(client, input.owner, itemId, input.question)
    return { itemId, turnRevision: turn.revision }
  })
}
