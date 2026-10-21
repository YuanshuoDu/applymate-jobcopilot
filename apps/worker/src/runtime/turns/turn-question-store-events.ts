import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { createHash } from "node:crypto"
import { matchesAgentOutboxIdentity, type AgentOutboxIdentity, type AgentOutboxPayload } from "../outbox-identity.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { buildTurnQuestionScheduledChoiceBinding, buildTurnQuestionScheduledChoiceBindingFromAnalyzeEvidence, parseTurnQuestionScheduledChoiceBinding,
  scheduledAnalyzeCheckpointEvidence, TurnQuestionStoreError, turnScheduledPrepareChoiceWaitId,
  isTurnQuestionUsage, type TurnQuestionScheduledChoiceBinding } from "./turn-question-contract.js"
import { toRepositoryJson } from "./turn-engine-types.js"
import { parseModelCompletedReceipt } from "./model-completed-receipt.js"
import { scheduledSnapshotMatches } from "../subagents/scheduled-taskgraph-continuation-receipt.js"
import { SCHEDULED_PIPELINE_CANDIDATE_EVENT, SCHEDULED_PIPELINE_CANDIDATE_SCHEMA } from "../subagents/scheduled-pipeline-candidate-store.js"
import { assertQuestionOwner, questionConflict, questionItemId, withQuestionTransaction, type TurnQuestionPool, type TurnQuestionQueryClient } from "./turn-question-store-guards.js"

type Row = Record<string, unknown>
export type TurnQuestionStartedEventInput = {
  readonly owner: TurnExecutionOwnerFence
  readonly stepId: string
  readonly itemId: string
  readonly questionId: string
  readonly toolCallId: string
  readonly toolCallCount: number
}
type EventInput = { readonly owner: TurnExecutionOwnerFence; readonly id: string; readonly type: string; readonly itemId: string | null
  readonly correlationId: string; readonly causationId: string | null; readonly idempotencyKey: string; readonly payload: RepositoryJsonValue }
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
  try { return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null } catch { return null }
}
type ModelReceipt = { readonly sequence: bigint; readonly payload: Record<string, unknown> }
function modelReceipt(row: Record<string, unknown> | undefined, owner: TurnExecutionOwnerFence, stepId: string, type: string, key: string): ModelReceipt | null {
  if (!row) return null
  const payload = record(row.payload), seq = sequence(row.sequence), keys = type === "model.usage" ? ["provider", "model", "usage", "taskId"] : ["taskId", "provider", "model"]
  const payloadValid = type === "model.completed" ? !!parseModelCompletedReceipt(payload) : !!payload && exact(payload, keys)
  return typeof row.id === "string" && row.id.trim().length > 0 && row.sessionId === owner.sessionId && row.turnId === owner.turnId
    && row.taskId === owner.taskId && row.itemId === null && row.type === type && row.actor === "orchestrator" && row.correlationId === stepId && row.idempotencyKey === key
    && payload && payloadValid && payload.taskId === owner.taskId && typeof payload.provider === "string" && !!payload.provider
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
  const previous = await client.query<{ id: string }>(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 ORDER BY "sequence" DESC LIMIT 1`, [input.owner.sessionId, input.owner.turnId, input.owner.taskId])
  const stepKey = `turn:${input.owner.turnId}:event:step-completed:${input.stepId}`
  await appendOne(client, { owner: input.owner, id: eventId(input, "step"), type: "step.completed", itemId: null, correlationId: input.stepId,
    causationId: previous.rows[0]?.id ?? null, idempotencyKey: stepKey, payload: { stepId: input.stepId, status: "waiting_for_user", toolCallCount: input.toolCallCount, taskId: input.owner.taskId } })
  const questionKey = `agent-wait:${input.itemId}:started`
  await appendOne(client, { owner: input.owner, id: eventId(input, "question"), type: "item.started", itemId: input.itemId,
    correlationId: input.itemId, causationId: input.questionId, idempotencyKey: questionKey, payload: { itemId: input.itemId, waitKind: "question", questionId: input.questionId, toolCallId: input.toolCallId } })
}

export async function loadScheduledChoiceBinding(client: TurnQuestionQueryClient, input: { owner: TurnExecutionOwnerFence; expected?: TurnQuestionScheduledChoiceBinding; expectedReceipt?: unknown }): Promise<{ binding: TurnQuestionScheduledChoiceBinding; waitId: string; stepId: string; stepStatus: string; candidateFinishReason: string; candidateUsage: unknown }> {
  const candidate = await client.query<Row>(`SELECT event."itemId", event."taskId", event."actor", event."correlationId", event."idempotencyKey", event."payload",
      step."taskId" AS "stepTaskId", step."ordinal", step."attempt", step."status" AS "stepStatus", root."attemptCount", root."status" AS "rootStatus"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_steps" AS step ON step."id" = event."correlationId" AND step."sessionId" = event."sessionId" AND step."turnId" = event."turnId"
    JOIN "sub_agent_tasks" AS root ON root."id" = event."taskId" AND root."sessionId" = event."sessionId" AND root."turnId" = event."turnId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."taskId" = $3 AND event."type" = $4
      AND session."userId" = $5 AND root."rootTaskId" = root."id" AND root."parentTaskId" IS NULL
    ORDER BY event."sequence" DESC LIMIT 1 FOR SHARE OF event, step, root`,
  [input.owner.sessionId, input.owner.turnId, input.owner.rootTaskId, SCHEDULED_PIPELINE_CANDIDATE_EVENT, input.owner.userId])
  const row = candidate.rows[0], payload = record(row?.payload), rootAttempt = Number(row?.attemptCount)
  const candidateKeys = ["schemaVersion", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "finalStepId", "finalStepOrdinal", "stepAttempt", "candidateText", "finishReason", "usage"]
  if (candidate.rows.length !== 1 || !payload || Object.keys(payload).sort().join(",") !== [...candidateKeys].sort().join(",")
    || payload.schemaVersion !== SCHEDULED_PIPELINE_CANDIDATE_SCHEMA || row?.itemId !== null || row.taskId !== input.owner.rootTaskId
    || row.actor !== "orchestrator" || row.correlationId !== payload.finalStepId || row.stepTaskId !== input.owner.rootTaskId
    || payload.sessionId !== input.owner.sessionId || payload.turnId !== input.owner.turnId || payload.rootTaskId !== input.owner.rootTaskId
    || !Number.isSafeInteger(rootAttempt) || rootAttempt < 1 || payload.rootAttemptCount !== rootAttempt
    || payload.finalStepOrdinal !== Number(row.ordinal) || !Number.isSafeInteger(payload.finalStepOrdinal) || payload.finalStepOrdinal < 0
    || Number(row.attempt) !== 1 || payload.stepAttempt !== 1 || typeof payload.candidateText !== "string" || !payload.candidateText.trim()
    || typeof payload.finishReason !== "string" || !payload.finishReason.trim() || payload.finishReason.length > 128 || !isTurnQuestionUsage(payload.usage)
    || !["running", "waiting_for_user"].includes(String(row.rootStatus)) || !["streaming", "waiting_for_user", "completed"].includes(String(row.stepStatus))
    || row.idempotencyKey !== `scheduled-candidate:${input.owner.rootTaskId}:${rootAttempt}:${payload.finalStepId}`) throw questionConflict("scheduled candidate binding")
  const live = await client.query<Row>(`SELECT turn."source", turn."executionMode", turn."input", execution."id", execution."attemptCount", execution."status", execution."state"
    FROM "agent_turns" AS turn JOIN "agent_executions" AS execution ON execution."sessionId" = turn."sessionId"
      AND execution."id" = execution."state"->'scheduledTaskGraphContinuation'->'owner'->>'executionId'
    JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
    WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND execution."userId" = $3 AND session."userId" = $3 FOR SHARE OF execution`,
  [input.owner.turnId, input.owner.sessionId, input.owner.userId])
  const execution = live.rows[0], state = record(execution?.state), marker = record(state?.scheduledTaskGraphContinuation), markerOwner = record(marker?.owner)
  if (live.rows.length !== 1 || !execution || !["running", "waiting_for_user"].includes(String(execution.status))) throw questionConflict("scheduled execution binding")
  const evidence = scheduledAnalyzeCheckpointEvidence(state), checkpointDigest = evidence?.checkpointDigest, stableOwner = evidence?.owner
  if (!evidence || !checkpointDigest || !marker || !stableOwner || !markerOwner
    || !scheduledSnapshotMatches({ source: execution.source, executionMode: execution.executionMode, input: execution.input }, evidence.snapshotDigest)
    || stableOwner.userId !== input.owner.userId || stableOwner.sessionId !== input.owner.sessionId
    || stableOwner.turnId !== input.owner.turnId || stableOwner.rootTaskId !== input.owner.rootTaskId
    || stableOwner.rootAttemptCount !== rootAttempt || stableOwner.executionId !== execution.id
    || stableOwner.executionAttemptCount !== Number(execution.attemptCount)) throw questionConflict("scheduled Analyze checkpoint binding")
  const stepId = String(payload.finalStepId), binding = buildTurnQuestionScheduledChoiceBindingFromAnalyzeEvidence({ owner: stableOwner,
    continuationKey: evidence.continuationKey, snapshotDigest: evidence.snapshotDigest, evidenceDigest: evidence.evidenceDigest,
    checkpointDigest, analyzeGraphRevision: evidence.analyzeGraphRevision, finalStepId: stepId, finalStepOrdinal: Number(row.ordinal) })
  const id = turnScheduledPrepareChoiceWaitId(binding)
  const expected = input.expected ? parseTurnQuestionScheduledChoiceBinding(input.expected)
    : input.expectedReceipt === undefined ? undefined : buildTurnQuestionScheduledChoiceBinding({ receipt: input.expectedReceipt,
      finalStepId: stepId, finalStepOrdinal: Number(row.ordinal) })
  if (!binding || !id || (input.expected !== undefined || input.expectedReceipt !== undefined) && (!expected || !sameJson(expected, binding))) {
    throw questionConflict("scheduled choice continuation binding")
  }
  return { binding, waitId: id, stepId, stepStatus: String(row.stepStatus), candidateFinishReason: payload.finishReason, candidateUsage: payload.usage }
}

export async function appendScheduledChoiceWaitEvents(client: TurnQuestionQueryClient, input: { owner: TurnExecutionOwnerFence; stepId: string; itemId: string; waitId: string }): Promise<void> {
  const { owner, stepId, itemId, waitId } = input
  const previous = await client.query<{ id: string }>(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 ORDER BY "sequence" DESC LIMIT 1`, [owner.sessionId, owner.turnId, owner.taskId])
  const digest = createHash("sha256").update(JSON.stringify([owner.turnId, waitId])).digest("hex"), stepEventId = `agent-scheduled-choice-step-${digest}`
  await appendOne(client, { owner, id: stepEventId, type: "step.completed", itemId: null, correlationId: stepId, causationId: previous.rows[0]?.id ?? null,
    idempotencyKey: `turn:${owner.turnId}:event:step-completed:${stepId}`, payload: { stepId, status: "waiting_for_user", taskId: owner.taskId } })
  await appendOne(client, { owner, id: `agent-scheduled-choice-item-${digest}`, type: "item.started", itemId, correlationId: itemId, causationId: stepEventId,
    idempotencyKey: `agent-wait:${itemId}:started`, payload: { itemId, waitKind: "question", questionId: waitId, toolCallId: null } })
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
