import { parseTurnQuestionArguments, TurnQuestionStoreError, type TurnQuestionPauseInput } from "./turn-question-contract.js"
import { isDeepStrictEqual } from "node:util"
import { appendQuestionPauseEvents } from "./turn-question-store-events.js"
import { assertQuestionOwner, assertQuestionUsage, completedQuestionResult, lockQuestionStep, questionId, questionItemId, questionConflict, withQuestionTransaction, type TurnQuestionPool, type TurnQuestionQueryClient, type TurnQuestionStepRow } from "./turn-question-store-guards.js"

const PAUSE = "session_pause_requested"
type Row = Record<string, unknown>
function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Row : null
}
function exact(row: Row, keys: readonly string[]): boolean { return Object.keys(row).sort().join(",") === [...keys].sort().join(",") }
function same(left: unknown, right: unknown): boolean { return isDeepStrictEqual(left, right) }
function amount(value: unknown): number { const number = Number(value); return Number.isFinite(number) ? number : NaN }
function usageMatches(step: TurnQuestionStepRow, input: TurnQuestionPauseInput): boolean {
  return step.finishReason === input.finishReason && Number(step.inputTokens) === input.usage.inputTokens
    && Number(step.outputTokens) === input.usage.outputTokens && Number(step.estimatedCostUsd) === input.usage.estimatedCostUsd
}
function ensureStepUsage(step: TurnQuestionStepRow, input: TurnQuestionPauseInput, cancelled: boolean): void {
  if (cancelled) {
    if (step.status !== "interrupted" || step.errorCode !== PAUSE || !usageMatches(step, input)) throw questionConflict(`step ${input.stepId} pause replay`)
  } else if (step.status !== "streaming" || (step.errorCode !== null && step.errorCode !== undefined)
    || (step.finishReason === null
      ? amount(step.inputTokens) !== 0 || amount(step.outputTokens) !== 0 || amount(step.estimatedCostUsd) !== 0
      : !usageMatches(step, input))) throw questionConflict(`step ${input.stepId} pause usage`)
}
export async function hasQuestionPauseEvents(client: TurnQuestionQueryClient, owner: TurnQuestionPauseInput["owner"], stepId: string, toolCallId: string, callItemId: string, resultItemId: string | null): Promise<boolean> {
  const digest = questionId(owner, stepId, toolCallId), base = `turn:${owner.turnId}:event:question-pause:${digest}`
  const keys = [`${base}:call`, `${base}:item`, ...(resultItemId ? [`${base}:result`] : []), `${base}:step`]
  const result = await client.query<Row>(`SELECT "id", "itemId", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload"
    FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "idempotencyKey" = ANY($4::text[]) FOR SHARE`,
  [owner.sessionId, owner.turnId, owner.taskId, keys])
  if (result.rows.length !== keys.length) return false
  const events = new Map<string, Row>()
  for (const row of result.rows) {
    if (typeof row.idempotencyKey !== "string" || events.has(row.idempotencyKey)) return false
    events.set(row.idempotencyKey, row)
  }
  if (events.size !== keys.length) return false
  const callId = `agent-question-pause-call-${digest}`, itemId = `agent-question-pause-item-${digest}`
  const call = events.get(`${base}:call`), item = events.get(`${base}:item`), step = events.get(`${base}:step`)
  const event = (row: Row | undefined, id: string, type: string, itemId: string | null, correlationId: string, causationId: string | null, key: string, payload: Row) =>
    Boolean(row && row.id === id && row.type === type && row.itemId === itemId && row.actor === "orchestrator"
      && row.correlationId === correlationId && row.causationId === causationId && row.idempotencyKey === key && same(row.payload, payload))
  if (!call || (call.causationId !== null && typeof call.causationId !== "string")) return false
  if (!event(call, callId, "tool_call.failed", callItemId, toolCallId, call.causationId as string | null, `${base}:call`,
    { toolCallId, toolName: "agent.ask_user", status: "cancelled", errorCode: null, taskId: owner.taskId })
    || !event(item, `agent-question-pause-item-${digest}`, "item.delta", callItemId, callItemId, callId, `${base}:item`,
      { itemId: callItemId, status: "interrupted", content: { toolCallId, toolName: "agent.ask_user", toolVersion: "1", status: "cancelled", errorCode: null } })) return false
  let stepCause = itemId
  if (resultItemId) {
    const resultEventId = `agent-question-pause-result-${digest}`, resultEvent = events.get(`${base}:result`)
    if (!event(resultEvent, resultEventId, "item.delta", resultItemId, resultItemId, itemId, `${base}:result`,
      { itemId: resultItemId, status: "interrupted", content: { toolCallId, output: null, status: "cancelled", errorCode: null } })) return false
    stepCause = resultEventId
  }
  return event(step, `agent-question-pause-step-${digest}`, "step.completed", null, stepId, stepCause, `${base}:step`,
    { stepId, status: "interrupted", errorCode: PAUSE, toolCallCount: 1, taskId: owner.taskId })
}
function validateCall(value: unknown, rowStatus: unknown, input: TurnQuestionPauseInput, expected: ReturnType<typeof parseTurnQuestionArguments>): { readonly content: Row; readonly cancelled: boolean } {
  const content = record(value)
  if (!content || content.toolCallId !== input.toolCallId || content.toolName !== "agent.ask_user" || content.toolVersion !== "1"
    || !same(parseTurnQuestionArguments(content.input), expected)) throw new TurnQuestionStoreError("question_receipt_malformed", "Paused ask_user call lineage is malformed")
  if (rowStatus === "started" && exact(content, ["toolCallId", "toolName", "toolVersion", "input"]) && content.status === undefined) return { content, cancelled: false }
  if (rowStatus === "completed" && exact(content, ["toolCallId", "toolName", "toolVersion", "status", "errorCode", "input"])
    && content.status === "completed" && content.errorCode === null) return { content, cancelled: false }
  if (rowStatus === "interrupted" && exact(content, ["toolCallId", "toolName", "toolVersion", "status", "errorCode", "input"])
    && content.status === "cancelled" && content.errorCode === null) return { content, cancelled: true }
  throw new TurnQuestionStoreError("question_receipt_malformed", "Paused ask_user call is not a known pre-intent state")
}
function validatePartialResult(value: unknown, rowStatus: unknown, input: TurnQuestionPauseInput, expected: ReturnType<typeof parseTurnQuestionArguments>, cancelled: boolean): boolean {
  const content = record(value)
  if (!content || content.toolCallId !== input.toolCallId) throw new TurnQuestionStoreError("question_receipt_malformed", "Paused ask_user result lineage is malformed")
  if (rowStatus === "started" && !cancelled && exact(content, ["toolCallId", "output", "errorCode"])
    && content.errorCode === null && same(content.output, expected)) return false
  if (rowStatus === "interrupted" && cancelled && exact(content, ["toolCallId", "output", "status", "errorCode"])
    && content.output === null && content.status === "cancelled" && content.errorCode === null) return true
  throw new TurnQuestionStoreError("question_receipt_malformed", "Paused ask_user result is not a known pre-intent state")
}

export async function cancelPausedQuestion(pool: TurnQuestionPool, input: TurnQuestionPauseInput): Promise<"cancelled" | "prepared"> {
  assertQuestionOwner(input.owner); assertQuestionUsage(input)
  const expected = parseTurnQuestionArguments(input.callArguments)
  if (!expected) {
    throw new TurnQuestionStoreError("question_receipt_malformed", "Paused ask_user identity is invalid")
  }
  return withQuestionTransaction(pool, input.owner, async (client, turn) => {
    const step = await lockQuestionStep(client, input.owner, input.stepId)
    try {
      const receipt = await completedQuestionResult(client, input.owner, input.stepId, input.toolCallId, input.callArguments)
      if (turn.status === "in_progress" || turn.status === "waiting_for_user") {
        if (!usageMatches(step, input) || !["streaming", "waiting_for_user"].includes(step.status)) throw questionConflict(`prepared step ${input.stepId} usage`)
        return "prepared"
      }
      throw questionConflict(`prepared Turn ${input.owner.turnId} state`)
    } catch (error: unknown) {
      if (!(error instanceof TurnQuestionStoreError) || error.code !== "question_receipt_missing") throw error
    }

    const id = questionId(input.owner, input.stepId, input.toolCallId)
    const question = await client.query<Row>(`SELECT "id" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 FOR UPDATE`,
      [questionItemId(id), input.owner.sessionId, input.owner.turnId])
    if (question.rows.length !== 0) throw questionConflict(`question item ${questionItemId(id)} exists for incomplete call`)
    const callQuery = await client.query<Row>(`SELECT "id", "status", "content" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2
      AND "stepId" = $3 AND "taskId" = $4 AND "type" = 'tool_call' AND "content"->>'toolCallId' = $5 FOR UPDATE`,
    [input.owner.sessionId, input.owner.turnId, input.stepId, input.owner.taskId, input.toolCallId])
    const resultQuery = await client.query<Row>(`SELECT "id", "status", "content" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2
      AND "stepId" = $3 AND "taskId" = $4 AND "type" = 'tool_result' AND "content"->>'toolCallId' = $5 FOR UPDATE`,
    [input.owner.sessionId, input.owner.turnId, input.stepId, input.owner.taskId, input.toolCallId])
    if (callQuery.rows.length > 1 || resultQuery.rows.length > 1) throw questionConflict(`ask_user ${input.toolCallId} duplicate lineage`)
    const callRow = callQuery.rows[0], resultRow = resultQuery.rows[0]
    if (!callRow && resultRow) throw questionConflict(`ask_user ${input.toolCallId} result without call`)
    if ((callRow && (typeof callRow.id !== "string" || !callRow.id)) || (resultRow && (typeof resultRow.id !== "string" || !resultRow.id))) throw questionConflict(`ask_user ${input.toolCallId} item identity`)
    const call = callRow ? validateCall(callRow.content, callRow.status, input, expected) : null
    const alreadyCancelled = Boolean(call?.cancelled)
    ensureStepUsage(step, input, alreadyCancelled)
    const resultCancelled = resultRow ? validatePartialResult(resultRow.content, resultRow.status, input, expected, alreadyCancelled) : false
    if (resultCancelled && !alreadyCancelled) throw questionConflict(`ask_user ${input.toolCallId} result cancellation without call cancellation`)
    if (turn.status !== "in_progress") throw new TurnQuestionStoreError("question_not_current", "Incomplete question cannot be cancelled after Turn wait")
    if (callRow && !alreadyCancelled) {
      const content = { ...call!.content, status: "cancelled", errorCode: null }
      const updated = await client.query(`UPDATE "agent_items" SET "status" = 'interrupted', "content" = $1::jsonb, "revision" = "revision" + 1,
        "completedAt" = $2, "updatedAt" = $2 WHERE "id" = $3 AND "sessionId" = $4 AND "turnId" = $5 AND "taskId" = $6
        AND "type" = 'tool_call' AND "status" = $7`, [JSON.stringify(content), input.now, callRow.id, input.owner.sessionId, input.owner.turnId, input.owner.taskId, callRow.status])
      if (updated.rowCount !== 1) throw questionConflict(`ask_user ${input.toolCallId} cancellation update`)
    }
    if (resultRow && !resultCancelled) {
      const content = { toolCallId: input.toolCallId, output: null, status: "cancelled", errorCode: null }
      const updated = await client.query(`UPDATE "agent_items" SET "status" = 'interrupted', "content" = $1::jsonb, "revision" = "revision" + 1,
        "completedAt" = $2, "updatedAt" = $2 WHERE "id" = $3 AND "sessionId" = $4 AND "turnId" = $5 AND "taskId" = $6
        AND "type" = 'tool_result' AND "status" = 'started'`, [JSON.stringify(content), input.now, resultRow.id, input.owner.sessionId, input.owner.turnId, input.owner.taskId])
      if (updated.rowCount !== 1) throw questionConflict(`ask_user ${input.toolCallId} result cancellation update`)
    }
    if (!alreadyCancelled) {
      const updated = await client.query(`UPDATE "agent_steps" SET "status" = 'interrupted', "finishReason" = $1, "errorCode" = $2,
        "inputTokens" = $3, "outputTokens" = $4, "estimatedCostUsd" = $5, "completedAt" = $6 WHERE "id" = $7 AND "sessionId" = $8
        AND "turnId" = $9 AND "taskId" = $10 AND "attempt" = 1 AND "status" = 'streaming'`,
      [input.finishReason, PAUSE, input.usage.inputTokens, input.usage.outputTokens, input.usage.estimatedCostUsd, input.now, input.stepId, input.owner.sessionId, input.owner.turnId, input.owner.taskId])
      if (updated.rowCount !== 1) throw questionConflict(`step ${input.stepId} cancellation update`)
    }
    await appendQuestionPauseEvents(client, { owner: input.owner, stepId: input.stepId, toolCallId: input.toolCallId,
      callItemId: callRow ? String(callRow.id) : null, resultItemId: resultRow ? String(resultRow.id) : null, digest: id })
    return "cancelled"
  })
}
