import { createHash } from "node:crypto"
import type pg from "pg"
import type { TurnUsage } from "../budget.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { assertSessionWorkAdmission, OPEN_SESSION } from "../session-gate.js"
import { ownerFenceSql } from "./turn-engine-owner-sql.js"
import { parseTurnQuestionArguments, parseTurnQuestionIntentEnvelope, TurnQuestionStoreError, type TurnQuestionIntentEnvelope, type TurnQuestionUsageInput, type TurnQuestionWaitInput } from "./turn-question-contract.js"

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
