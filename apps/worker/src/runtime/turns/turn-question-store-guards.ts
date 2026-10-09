import { createHash } from "node:crypto"
import type pg from "pg"
import type { TurnUsage } from "../budget.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { assertSessionWorkAdmission, OPEN_SESSION } from "../session-gate.js"
import { ownerFenceSql } from "./turn-engine-owner-sql.js"
import { parseTurnQuestionArguments, parseTurnQuestionIntentEnvelope, TurnQuestionStoreError, type TurnQuestionIntentEnvelope, type TurnQuestionRecovery, type TurnQuestionUsageInput, type TurnQuestionWaitInput } from "./turn-question-contract.js"

export type TurnQuestionPool = Pick<pg.Pool, "connect">
export type TurnQuestionClient = Pick<pg.PoolClient, "query" | "release">
export type TurnQuestionQueryClient = Pick<pg.PoolClient, "query">
export type TurnQuestionTurnRow = { readonly id: string; readonly status: string; readonly revision: number | string }
export type TurnQuestionStepRow = {
  readonly id: string; readonly status: string; readonly taskId: string; readonly attempt: number | string
  readonly finishReason: string | null; readonly errorCode: string | null; readonly inputTokens: number | string; readonly outputTokens: number | string
  readonly estimatedCostUsd: number | string
}
export type CompletedQuestionResult = { readonly callItemId: string; readonly resultItemId: string; readonly intent: TurnQuestionIntentEnvelope }
type Row = Record<string, unknown>

export function questionConflict(resource: string): TurnQuestionStoreError {
  return new TurnQuestionStoreError("question_conflict", `Question persistence conflict: ${resource}`)
}

export function assertQuestionOwner(owner: TurnExecutionOwnerFence): void {
  if (owner.kind !== "turn" || owner.taskId !== owner.rootTaskId || !owner.userId.trim() || !owner.sessionId.trim()
    || !owner.turnId.trim() || !owner.taskId.trim() || !owner.ownerId.trim() || !Number.isSafeInteger(owner.leaseVersion)
    || !(owner.leaseExpiresAt instanceof Date) || !Number.isFinite(owner.leaseExpiresAt.getTime())) {
    throw new TurnQuestionStoreError("question_invalid_owner", "A current native root owner is required")
  }
}

export function assertQuestionUsage(input: TurnQuestionUsageInput): void {
  if (!input.stepId.trim() || !input.toolCallId.trim() || !input.finishReason.trim() || input.finishReason.length > 128
    || !Number.isSafeInteger(input.usage.inputTokens) || input.usage.inputTokens < 0
    || !Number.isSafeInteger(input.usage.outputTokens) || input.usage.outputTokens < 0
    || !Number.isFinite(input.usage.estimatedCostUsd) || input.usage.estimatedCostUsd < 0
    || !(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new TurnQuestionStoreError("question_usage_unavailable", "Durable question usage is invalid")
  }
}

export function questionId(owner: TurnExecutionOwnerFence, stepId: string, toolCallId: string): string {
  return createHash("sha256").update(JSON.stringify([owner.sessionId, owner.turnId, stepId, toolCallId])).digest("hex")
}

export function questionItemId(id: string): string { return `agent-wait:question:${id}` }

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).sort().join(",") === [...keys].sort().join(",") }

/** Shared strict readback for the completed ask_user call/result pair. */
export async function completedQuestionResult(client: TurnQuestionQueryClient, owner: TurnQuestionWaitInput["owner"], stepId: string, toolCallId: string, expectedArguments?: unknown): Promise<CompletedQuestionResult> {
  const calls = await client.query<Record<string, unknown>>(`SELECT "id", "status", "content" FROM "agent_items"
    WHERE "sessionId" = $1 AND "turnId" = $2 AND "stepId" = $3 AND "taskId" = $4 AND "type" = 'tool_call'
      AND "content"->>'toolCallId' = $5`, [owner.sessionId, owner.turnId, stepId, owner.taskId, toolCallId])
  const call = calls.rows[0], content = call && record(call.content)
  if (!call || calls.rows.length !== 1 || typeof call.id !== "string" || !call.id || !content || content.toolCallId !== toolCallId
    || !exactKeys(content, ["toolCallId", "toolName", "toolVersion", "status", "errorCode", "input"])
    || content.toolName !== "agent.ask_user" || content.toolVersion !== "1" || call.status !== "completed" || content.status !== "completed" || content.errorCode !== null) {
    throw new TurnQuestionStoreError("question_receipt_missing", "Completed owned ask_user call receipt is required")
  }
  const requested = parseTurnQuestionArguments(content.input)
  if (!requested) throw new TurnQuestionStoreError("question_receipt_malformed", "Persisted ask_user call arguments are malformed")
  if (expectedArguments !== undefined) {
    const expected = parseTurnQuestionArguments(expectedArguments)
    if (!expected || JSON.stringify(requested) !== JSON.stringify(expected)) throw questionConflict(`tool call ${toolCallId} input identity`)
  }
  const results = await client.query<Record<string, unknown>>(`SELECT "id", "status", "content" FROM "agent_items"
    WHERE "sessionId" = $1 AND "turnId" = $2 AND "stepId" = $3 AND "taskId" = $4 AND "type" = 'tool_result'
      AND "content"->>'toolCallId' = $5`, [owner.sessionId, owner.turnId, stepId, owner.taskId, toolCallId])
  const result = results.rows[0], receipt = result && record(result.content)
  if (!result || results.rows.length !== 1 || typeof result.id !== "string" || !result.id || result.status !== "completed"
    || !receipt || !exactKeys(receipt, ["toolCallId", "output", "errorCode"]) || receipt.toolCallId !== toolCallId || receipt.errorCode !== null) {
    throw new TurnQuestionStoreError("question_receipt_missing", "Completed owned ask_user result receipt is required")
  }
  const intent = parseTurnQuestionIntentEnvelope(receipt.output)
  if (!intent) throw new TurnQuestionStoreError("question_receipt_malformed", "Owned ask_user result receipt is malformed")
  if (JSON.stringify(intent) !== JSON.stringify(requested)) throw questionConflict(`tool call ${toolCallId} intent/result identity`)
  return { callItemId: call.id, resultItemId: result.id, intent }
}

export async function withQuestionTransaction<T>(
  pool: TurnQuestionPool,
  owner: TurnExecutionOwnerFence,
  work: (client: TurnQuestionClient, turn: TurnQuestionTurnRow) => Promise<T>,
): Promise<T> {
  assertQuestionOwner(owner)
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", owner.userId])
    const session = await client.query<Row>(`SELECT session."id" FROM "agent_sessions" AS session
      WHERE session."id" = $1 AND session."userId" = $2 AND ${OPEN_SESSION} FOR UPDATE`, [owner.sessionId, owner.userId])
    if (!session.rows[0]) throw new TurnQuestionStoreError("question_not_current", "Question session is no longer open")
    const fence = ownerFenceSql(owner, 3, true)
    const turn = await client.query<TurnQuestionTurnRow>(`SELECT turn."id", turn."status", turn."revision" FROM "agent_turns" AS turn
      ${fence.joins} WHERE turn."id" = $1 AND turn."sessionId" = $2 AND ${fence.where} FOR UPDATE`,
    [owner.turnId, owner.sessionId, ...fence.values])
    const row = turn.rows[0]
    if (!row || !["in_progress", "waiting_for_user"].includes(row.status)) {
      throw new TurnQuestionStoreError("question_not_current", "Question Turn is no longer owned")
    }
    const result = await work(client, row)
    await client.query("COMMIT"); committed = true
    return result
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

export async function lockQuestionStep(
  client: TurnQuestionQueryClient, owner: TurnExecutionOwnerFence, stepId: string,
): Promise<TurnQuestionStepRow> {
  const row = (await client.query<TurnQuestionStepRow>(`SELECT "id", "status", "taskId", "attempt", "finishReason", "errorCode", "inputTokens", "outputTokens", "estimatedCostUsd"
    FROM "agent_steps" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 AND "attempt" = 1 FOR UPDATE`,
  [stepId, owner.sessionId, owner.turnId, owner.taskId])).rows[0]
  if (!row) throw questionConflict(`step ${stepId} lineage`)
  return row
}

export async function admitQuestionWork(client: TurnQuestionQueryClient, owner: TurnExecutionOwnerFence): Promise<void> {
  await assertSessionWorkAdmission(client, owner)
}

export function persistedUsage(step: TurnQuestionStepRow, allowedStatuses: readonly string[] = ["streaming"]): TurnUsage {
  const inputTokens = Number(step.inputTokens), outputTokens = Number(step.outputTokens), estimatedCostUsd = Number(step.estimatedCostUsd)
  if (!allowedStatuses.includes(step.status) || typeof step.finishReason !== "string" || !step.finishReason.trim()
    || !Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0
    || !Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) {
    throw new TurnQuestionStoreError("question_usage_unavailable", "Question step has no durable model usage")
  }
  return { inputTokens, outputTokens, estimatedCostUsd }
}

function eventSequence(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null
  if (typeof value !== "string" && typeof value !== "number") return null
  const text = String(value)
  if (!/^\d+$/.test(text)) return null
  try { return BigInt(text) } catch { return null }
}

async function questionModelUsage(client: TurnQuestionQueryClient, owner: TurnExecutionOwnerFence, stepId: string): Promise<{
  readonly usage: TurnUsage; readonly startedSequence: bigint
}> {
  const types = ["model.started", "model.completed", "model.usage"] as const
  const keys = types.map(type => `turn:${owner.turnId}:event:${type.replace(".", "-")}:${stepId}`)
  const found = await client.query<Row>(`SELECT "id", "sequence", "sessionId", "turnId", "taskId", "itemId", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload"
    FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND (("correlationId" = $3 AND "type" = ANY($4::text[])) OR "idempotencyKey" = ANY($5::text[]))
    ORDER BY "sequence" FOR SHARE`, [owner.sessionId, owner.turnId, stepId, types, keys])
  const byType = new Map<string, Row>()
  for (const row of found.rows) {
    if (typeof row.type !== "string" || !types.includes(row.type as typeof types[number]) || byType.has(row.type)) throw questionConflict(`model usage event ${stepId}`)
    byType.set(row.type, row)
  }
  const receipts = types.map((type, index) => {
    const row = byType.get(type), payload = row && record(row.payload), sequence = eventSequence(row?.sequence)
    const expected = type === "model.usage" ? ["provider", "model", "usage", "taskId"] : ["taskId", "provider", "model"]
    if (!row || typeof row.id !== "string" || !row.id.trim() || row.sessionId !== owner.sessionId || row.turnId !== owner.turnId
      || row.taskId !== owner.taskId || row.itemId !== null || row.actor !== "orchestrator" || row.correlationId !== stepId
      || row.idempotencyKey !== keys[index] || !payload || !exactKeys(payload, expected) || payload.taskId !== owner.taskId
      || typeof payload.provider !== "string" || !payload.provider || typeof payload.model !== "string" || !payload.model || sequence === null) {
      throw new TurnQuestionStoreError("question_usage_unavailable", "Persisted ask_user call has no exact model receipt chain")
    }
    return { row, payload, sequence }
  })
  const [started, completed, usageEvent] = receipts, usage = record(usageEvent?.payload.usage)
  if (!started || !completed || !usageEvent || completed.row.causationId !== started.row.id || usageEvent.row.causationId !== completed.row.id
    || completed.sequence <= started.sequence || usageEvent.sequence <= completed.sequence
    || completed.payload.provider !== started.payload.provider || completed.payload.model !== started.payload.model
    || usageEvent.payload.provider !== completed.payload.provider || usageEvent.payload.model !== completed.payload.model
    || !usage || !exactKeys(usage, ["inputTokens", "outputTokens", "estimatedCostUsd"])
    || typeof usage.inputTokens !== "number" || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0
    || typeof usage.outputTokens !== "number" || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0
    || typeof usage.estimatedCostUsd !== "number" || !Number.isFinite(usage.estimatedCostUsd) || usage.estimatedCostUsd < 0) {
    throw new TurnQuestionStoreError("question_usage_unavailable", "Persisted ask_user model usage is malformed")
  }
  return { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCostUsd: usage.estimatedCostUsd }, startedSequence: started.sequence }
}

/** Restore only the exact owned in-progress call needed for idempotent ask_user replay. */
export async function recoverIncompleteQuestionCall(pool: TurnQuestionPool, owner: TurnExecutionOwnerFence, now: Date): Promise<TurnQuestionRecovery | null> {
  assertQuestionOwner(owner)
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TurnQuestionStoreError("question_not_current", "Question recovery time is invalid")
  return withQuestionTransaction(pool, owner, async (client, turn) => {
    if (turn.status !== "in_progress") return null
    const found = await client.query<Row>(`SELECT callItem."id" AS "callItemId", callItem."stepId", callItem."status" AS "callStatus", callItem."content" AS "callContent",
        step."status" AS "stepStatus", step."errorCode" AS "stepErrorCode", step."finishReason", step."inputTokens", step."outputTokens", step."estimatedCostUsd",
        resultItem."id" AS "resultItemId", resultItem."status" AS "resultStatus", resultItem."content" AS "resultContent",
        COUNT(resultItem."id") OVER (PARTITION BY callItem."id") AS "resultCount"
      FROM "agent_items" AS callItem JOIN "agent_steps" AS step ON step."id" = callItem."stepId" AND step."sessionId" = callItem."sessionId"
        AND step."turnId" = callItem."turnId" AND step."taskId" = callItem."taskId" AND step."attempt" = 1
      LEFT JOIN "agent_items" AS resultItem ON resultItem."sessionId" = callItem."sessionId" AND resultItem."turnId" = callItem."turnId"
        AND resultItem."stepId" = callItem."stepId" AND resultItem."taskId" = callItem."taskId" AND resultItem."type" = 'tool_result'
        AND resultItem."content"->>'toolCallId' = callItem."content"->>'toolCallId'
      WHERE callItem."sessionId" = $1 AND callItem."turnId" = $2 AND callItem."taskId" = $3 AND callItem."type" = 'tool_call'
        AND callItem."content"->>'toolName' = 'agent.ask_user' ORDER BY step."ordinal" DESC, callItem."startedAt" DESC, callItem."id" DESC LIMIT 65`,
    [owner.sessionId, owner.turnId, owner.taskId])
    if (found.rows.length >= 65) throw questionConflict("question recovery scan bound")
    const partial = found.rows.filter(row => (row.callStatus === "started" || row.callStatus === "completed")
      && (Number(row.resultCount) === 0 || Number(row.resultCount) === 1 && row.resultStatus === "started"))
    if (partial.length > 1) throw questionConflict("multiple incomplete ask_user calls")
    const row = partial[0]
    if (!row || typeof row.callItemId !== "string" || !row.callItemId || typeof row.stepId !== "string") return null
    const call = record(row.callContent), callId = call?.toolCallId, requested = parseTurnQuestionArguments(call?.input)
    if (!call || typeof callId !== "string" || !callId || !requested || call.toolName !== "agent.ask_user" || call.toolVersion !== "1"
      || !(row.callStatus === "started" && exactKeys(call, ["toolCallId", "toolName", "toolVersion", "input"]) && call.status === undefined
        || row.callStatus === "completed" && exactKeys(call, ["toolCallId", "toolName", "toolVersion", "status", "errorCode", "input"]) && call.status === "completed" && call.errorCode === null)
      || row.callStatus === "started" && Number(row.resultCount) !== 0) return null
    if (Number(row.resultCount) === 1) {
      const result = record(row.resultContent), intent = result && parseTurnQuestionIntentEnvelope(result.output)
      if (!result || row.resultStatus !== "started" || typeof row.resultItemId !== "string" || !exactKeys(result, ["toolCallId", "output", "errorCode"])
        || result.toolCallId !== callId || result.errorCode !== null || !intent || JSON.stringify(intent) !== JSON.stringify(requested)) return null
    }
    const step = await lockQuestionStep(client, owner, row.stepId)
    if (row.stepStatus !== "streaming" || step.status !== "streaming" || step.errorCode !== null && step.errorCode !== undefined) return null
    const durable = await questionModelUsage(client, owner, row.stepId)
    const pause = await client.query<Row>(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'session.pause_requested'
      AND "sequence" > $3 ORDER BY "sequence" LIMIT 1 FOR SHARE`, [owner.sessionId, owner.turnId, durable.startedSequence.toString()])
    if (pause.rows.length) return null
    const current = [Number(step.inputTokens), Number(step.outputTokens), Number(step.estimatedCostUsd)]
    const expected = [durable.usage.inputTokens, durable.usage.outputTokens, durable.usage.estimatedCostUsd]
    if (step.finishReason === null ? current.some(value => value !== 0) : step.finishReason !== "tool_calls" || current.some((value, index) => value !== expected[index])) {
      throw questionConflict(`step ${row.stepId} model usage`)
    }
    const id = questionId(owner, row.stepId, callId)
    const question = await client.query<Row>(`SELECT "id" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 FOR UPDATE`,
      [questionItemId(id), owner.sessionId, owner.turnId])
    if (question.rows.length) throw questionConflict(`question item ${questionItemId(id)} exists for incomplete call`)
    await admitQuestionWork(client, owner)
    if (step.finishReason === null) {
      const updated = await client.query(`UPDATE "agent_steps" SET "finishReason" = 'tool_calls', "inputTokens" = $1, "outputTokens" = $2, "estimatedCostUsd" = $3
        WHERE "id" = $4 AND "sessionId" = $5 AND "turnId" = $6 AND "taskId" = $7 AND "attempt" = 1 AND "status" = 'streaming'`,
      [durable.usage.inputTokens, durable.usage.outputTokens, durable.usage.estimatedCostUsd, row.stepId, owner.sessionId, owner.turnId, owner.taskId])
      if (updated.rowCount !== 1) throw questionConflict(`step ${row.stepId} usage recovery`)
    }
    return { status: "replayable", stepId: row.stepId, toolCallId: callId, callItemId: row.callItemId, intent: requested }
  })
}
