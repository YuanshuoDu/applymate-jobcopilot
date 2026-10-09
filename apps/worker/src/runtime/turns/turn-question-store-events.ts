import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { createHash } from "node:crypto"
import { matchesAgentOutboxIdentity, type AgentOutboxIdentity, type AgentOutboxPayload } from "../outbox-identity.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { TurnQuestionStoreError } from "./turn-question-contract.js"
import { toRepositoryJson } from "./turn-engine-types.js"
import { assertQuestionOwner, questionConflict, withQuestionTransaction, type TurnQuestionPool, type TurnQuestionQueryClient } from "./turn-question-store-guards.js"

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
type OrphanStep = Record<string, unknown>
export class OrphanPauseUsageRecoveredError extends Error {
  readonly code = "orphan_pause_usage_recovered_reload_required"
  constructor() { super("Orphan pause usage was durably repaired; reload the Turn state before continuing"); this.name = "OrphanPauseUsageRecoveredError" }
}
function json(value: RepositoryJsonValue): string { return JSON.stringify(value) }
function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(toRepositoryJson(left)) === JSON.stringify(toRepositoryJson(right)) }
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).sort().join(",") === [...keys].sort().join(",") }
function sequence(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null
  try { return BigInt(value) } catch { return null }
}
type ModelReceipt = { readonly sequence: bigint; readonly payload: Record<string, unknown> }
function modelReceipt(row: Record<string, unknown> | undefined, owner: TurnExecutionOwnerFence, stepId: string, type: string, key: string): ModelReceipt | null {
  if (!row) return null
  const payload = record(row.payload), seq = sequence(row.sequence), keys = type === "model.usage" ? ["provider", "model", "usage", "taskId"] : ["taskId", "provider", "model"]
  return typeof row.id === "string" && row.id.trim().length > 0 && row.sessionId === owner.sessionId && row.turnId === owner.turnId
    && row.taskId === owner.taskId && row.itemId === null
    && row.type === type && row.actor === "orchestrator" && row.correlationId === stepId && row.idempotencyKey === key
    && payload && exact(payload, keys) && payload.taskId === owner.taskId && typeof payload.provider === "string" && !!payload.provider
    && typeof payload.model === "string" && !!payload.model && seq !== null ? { sequence: seq, payload } : null
}

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

/** Restore usage only when a durable model result and later user pause fence an empty streaming step. */
export async function recoverPausedOrphanUsage(pool: TurnQuestionPool, owner: TurnExecutionOwnerFence, now: Date): Promise<boolean> {
  assertQuestionOwner(owner)
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TurnQuestionStoreError("question_not_current", "Question recovery time is invalid")
  return withQuestionTransaction(pool, owner, async (client, turn) => {
    if (turn.status !== "in_progress") return false
    const found = await client.query<OrphanStep>(`SELECT step."id", step."status", step."errorCode", step."finishReason", step."inputTokens", step."outputTokens", step."estimatedCostUsd"
      FROM "agent_steps" AS step WHERE step."sessionId" = $1 AND step."turnId" = $2 AND step."taskId" = $3
        AND step."attempt" = 1 AND step."status" = 'streaming' ORDER BY step."ordinal" DESC LIMIT 65 FOR UPDATE`,
    [owner.sessionId, owner.turnId, owner.taskId])
    if (found.rows.length > 1) throw questionConflict("multiple current streaming steps in orphan pause recovery")
    if (found.rows.length === 0) return false
    const candidates: Array<{ step: OrphanStep; usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number }; usageEventId: string; usageSequence: bigint }> = []
    for (const step of found.rows) {
      if (typeof step.id !== "string" || !step.id.trim()) throw questionConflict("orphan pause step identity")
      const startKey = `turn:${owner.turnId}:event:model-started:${step.id}`, completeKey = `turn:${owner.turnId}:event:model-completed:${step.id}`
      const usageKey = `turn:${owner.turnId}:event:model-usage:${step.id}`
      const events = await client.query<Record<string, unknown>>(`SELECT "id", "sequence", "itemId", "taskId", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload", "sessionId", "turnId"
        FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND (("correlationId" = $3 AND "type" IN ('model.started', 'model.completed', 'model.usage'))
          OR "idempotencyKey" = ANY($4::text[])) ORDER BY "sequence" FOR SHARE`, [owner.sessionId, owner.turnId, step.id, [startKey, completeKey, usageKey]])
      const started = events.rows.filter(row => row.type === "model.started" || row.idempotencyKey === startKey)
      const completed = events.rows.filter(row => row.type === "model.completed" || row.idempotencyKey === completeKey)
      const usageRows = events.rows.filter(row => row.type === "model.usage" || row.idempotencyKey === usageKey)
      if (started.length > 1 || completed.length > 1 || usageRows.length > 1) throw questionConflict(`orphan model event ${step.id}`)
      const start = started[0], completion = completed[0], usageEvent = usageRows[0]
      if (!start && !completion && !usageEvent) continue
      const pauseAfter = async (after: bigint): Promise<Record<string, unknown> | null> => {
        const pauses = await client.query<Record<string, unknown>>(`SELECT "id", "sequence", "itemId", "taskId", "actor", "correlationId", "causationId", "idempotencyKey", "payload"
          FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'session.pause_requested' AND "sequence" > $3
          ORDER BY "sequence" LIMIT 1 FOR SHARE`, [owner.sessionId, owner.turnId, after.toString()])
        const pause = pauses.rows[0]
        if (!pause) return null
        const payload = record(pause.payload)
        if (typeof pause.id !== "string" || !pause.id.trim() || sequence(pause.sequence) === null || pause.itemId !== null || pause.taskId !== null
          || pause.actor !== "user" || pause.correlationId !== owner.turnId || pause.causationId !== null
          || typeof pause.idempotencyKey !== "string" || !pause.idempotencyKey.startsWith("agent-session-control:")
          || !payload || !exact(payload, ["turnId", "expectedRevision", "requestedAt"]) || payload.turnId !== owner.turnId
          || !Number.isSafeInteger(payload.expectedRevision) || Number(payload.expectedRevision) < 0
          || typeof payload.requestedAt !== "string" || !Number.isFinite(Date.parse(payload.requestedAt))) throw questionConflict(`orphan pause evidence ${step.id}`)
        return pause
      }
      const rawRecoverySequence = usageEvent ? sequence(usageEvent.sequence)
        : completion ? sequence(completion.sequence) : sequence(start?.sequence)
      if (rawRecoverySequence === null) throw new TurnQuestionStoreError("question_receipt_malformed", "Orphan model event sequence is invalid")
      if (!await pauseAfter(rawRecoverySequence)) continue
      const startReceipt = modelReceipt(start, owner, step.id, "model.started", startKey)
      const completionReceipt = modelReceipt(completion, owner, step.id, "model.completed", completeKey)
      const usageReceipt = modelReceipt(usageEvent, owner, step.id, "model.usage", usageKey)
      if ((start && !startReceipt) || (completion && !completionReceipt) || (usageEvent && !usageReceipt)) {
        throw new TurnQuestionStoreError("question_receipt_malformed", "Orphan model receipt is malformed")
      }
      if (!startReceipt && (completion || usageEvent)) throw new TurnQuestionStoreError("question_receipt_malformed", "Orphan model receipt has no start event")
      if (completionReceipt && (!startReceipt || completion?.causationId !== start?.id || completionReceipt.sequence <= startReceipt.sequence
        || completionReceipt.payload.provider !== startReceipt.payload.provider || completionReceipt.payload.model !== startReceipt.payload.model)) {
        throw new TurnQuestionStoreError("question_receipt_malformed", "Orphan model completion does not follow its start")
      }
      if (usageReceipt && (!completionReceipt || usageEvent?.causationId !== completion?.id || usageReceipt.sequence <= completionReceipt.sequence
        || usageReceipt.payload.provider !== completionReceipt.payload.provider || usageReceipt.payload.model !== completionReceipt.payload.model)) {
        throw new TurnQuestionStoreError("question_receipt_malformed", "Orphan model usage does not follow its completion")
      }
      if (!usageEvent) {
        if (startReceipt) throw new TurnQuestionStoreError("question_usage_unavailable", "Paused model step has no durable usage")
        continue
      }
      const usage = record(usageReceipt?.payload.usage), usageSequence = usageReceipt?.sequence ?? null
      if (!usageReceipt || !usage || !exact(usage, ["inputTokens", "outputTokens", "estimatedCostUsd"])
        || typeof usage.inputTokens !== "number" || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0
        || typeof usage.outputTokens !== "number" || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0
        || typeof usage.estimatedCostUsd !== "number" || !Number.isFinite(usage.estimatedCostUsd) || usage.estimatedCostUsd < 0
        || usageSequence === null) throw new TurnQuestionStoreError("question_usage_unavailable", "Paused model usage receipt is malformed")
      const items = await client.query<Record<string, unknown>>(`SELECT "id", "type" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2
        AND "stepId" = $3 AND "type" IN ('tool_call', 'tool_result') FOR UPDATE`, [owner.sessionId, owner.turnId, step.id])
      if (items.rows.length) throw questionConflict(`orphan model step ${step.id} has tool items`)
      if (step.status !== "streaming" || (step.errorCode !== null && step.errorCode !== undefined) || step.finishReason !== null
        || Number(step.inputTokens) !== 0 || Number(step.outputTokens) !== 0 || Number(step.estimatedCostUsd) !== 0) throw questionConflict(`orphan model step ${step.id} state`)
      candidates.push({ step, usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCostUsd: usage.estimatedCostUsd }, usageEventId: usageEvent!.id as string, usageSequence })
    }
    if (candidates.length > 1) throw questionConflict("multiple orphan paused model steps")
    const candidate = candidates[0]
    if (!candidate) return false
    const stepId = String(candidate.step.id), updated = await client.query(`UPDATE "agent_steps" SET "status" = 'interrupted', "errorCode" = $1,
      "inputTokens" = $2, "outputTokens" = $3, "estimatedCostUsd" = $4, "completedAt" = $5 WHERE "id" = $6 AND "sessionId" = $7
        AND "turnId" = $8 AND "taskId" = $9 AND "attempt" = 1 AND "status" = 'streaming'`,
    ["session_pause_requested", candidate.usage.inputTokens, candidate.usage.outputTokens, candidate.usage.estimatedCostUsd, now, stepId, owner.sessionId, owner.turnId, owner.taskId])
    if (updated.rowCount !== 1) throw questionConflict(`orphan model step ${stepId} interruption`)
    const digest = createHash("sha256").update(JSON.stringify([owner.sessionId, owner.turnId, owner.taskId, stepId, candidate.usageSequence.toString()])).digest("hex")
    await appendOne(client, { owner, id: `agent-question-pause-orphan-step-${digest}`, type: "step.completed", itemId: null,
      correlationId: stepId, causationId: candidate.usageEventId, idempotencyKey: `turn:${owner.turnId}:event:question-pause-orphan:${digest}:step`,
      payload: { stepId, status: "interrupted", errorCode: "session_pause_requested", toolCallCount: 0, taskId: owner.taskId } })
    return true
  })
}
