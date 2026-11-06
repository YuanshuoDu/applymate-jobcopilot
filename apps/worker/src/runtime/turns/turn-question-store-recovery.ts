import type { TurnUsage } from "../budget.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { hasQuestionPauseEvents } from "./turn-question-store-cancellation.js"
import { toRepositoryJson } from "./turn-engine-types.js"
import { parseTurnQuestionArguments, TurnQuestionStoreError, type TurnQuestionRecovery, type TurnQuestionWaitInput } from "./turn-question-contract.js"
import { assertQuestionOwner, admitQuestionWork, lockQuestionStep, persistedUsage, questionConflict, questionId, questionItemId, questionModelUsage, questionResultIntent, withQuestionTransaction, type TurnQuestionPool, type TurnQuestionQueryClient, type TurnQuestionStepRow } from "./turn-question-store-guards.js"
import { readTurnQuestionPlanningWait } from "./turn-question-planning-history.js"

type Row = Record<string, unknown>
function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Row : null
}
function json(value: unknown): string { return JSON.stringify(value) }
function same(left: unknown, right: unknown): boolean {
  try { return json(toRepositoryJson(left)) === json(toRepositoryJson(right)) } catch { return false }
}
function exactKeys(value: Row, keys: readonly string[]): boolean { return Object.keys(value).sort().join(",") === [...keys].sort().join(",") }
function hasInterruptedUsage(row: Row): boolean {
  const inputTokens = Number(row.inputTokens), outputTokens = Number(row.outputTokens), cost = Number(row.estimatedCostUsd)
  return row.stepStatus === "interrupted" && row.stepErrorCode === "session_pause_requested"
    && typeof row.finishReason === "string" && row.finishReason.trim().length > 0
    && Number.isSafeInteger(inputTokens) && inputTokens >= 0 && Number.isSafeInteger(outputTokens) && outputTokens >= 0
    && Number.isFinite(cost) && cost >= 0
}

async function readQuestionItem(client: TurnQuestionQueryClient, input: TurnQuestionWaitInput, id: string, intent: { question: string; options: readonly { label: string; value: string }[] }): Promise<{ status: "waiting" | "answered" | "closed"; itemId: string } | null> {
  const itemId = questionItemId(id)
  const found = await client.query<Row>(`SELECT "id", "stepId", "taskId", "type", "status", "content" FROM "agent_items"
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 FOR UPDATE`, [itemId, input.owner.sessionId, input.owner.turnId])
  const row = found.rows[0]
  if (!row) return null
  const content = record(row.content)
  if (found.rows.length !== 1 || row.stepId !== input.stepId || row.taskId !== input.owner.taskId || row.type !== "question" || !content
    || content.waitKind !== "question" || content.questionId !== id || content.toolCallId !== input.toolCallId || content.stage !== "user_input"
    || content.question !== intent.question || !same(content.options, intent.options)) throw questionConflict(`question item ${itemId}`)
  if (row.status === "started" && content.answer === null && content.answerAvailable === false) return { status: "waiting", itemId }
  if (row.status === "completed" && content.answerAvailable === true && content.answer !== null && content.answer !== undefined) return { status: "answered", itemId }
  if ((row.status === "failed" || row.status === "interrupted") && content.answer === null && content.answerAvailable === false) return { status: "closed", itemId }
  throw questionConflict(`question item state ${itemId}`)
}
async function usageFromStep(client: TurnQuestionQueryClient, owner: TurnQuestionWaitInput["owner"], stepId: string, statuses: readonly string[] = ["streaming"]): Promise<{ step: TurnQuestionStepRow; usage: TurnUsage }> {
  const step = await lockQuestionStep(client, owner, stepId)
  return { step, usage: persistedUsage(step, statuses) }
}

/** Reads a question's durable status under the caller's owner-fenced transaction. */
export async function readPendingQuestion(
  client: TurnQuestionQueryClient, owner: TurnQuestionWaitInput["owner"], turnStatus: string, now: Date,
): Promise<TurnQuestionRecovery> {
  const calls = await client.query<Row>(`SELECT callItem."stepId", step."ordinal", step."status" AS "stepStatus", step."errorCode" AS "stepErrorCode",
      step."finishReason", step."inputTokens", step."outputTokens", step."estimatedCostUsd", callItem."id" AS "callItemId",
      callItem."status" AS "callStatus", callItem."content" AS "callContent", resultItem."id" AS "resultItemId",
      resultItem."status" AS "resultStatus", resultItem."content" AS "resultContent", COUNT(resultItem."id") OVER (PARTITION BY callItem."id") AS "resultCount"
    FROM "agent_items" AS callItem JOIN "agent_steps" AS step ON step."id" = callItem."stepId" AND step."sessionId" = callItem."sessionId"
      AND step."turnId" = callItem."turnId" AND step."taskId" = callItem."taskId" AND step."attempt" = 1
    LEFT JOIN "agent_items" AS resultItem ON resultItem."sessionId" = callItem."sessionId" AND resultItem."turnId" = callItem."turnId"
      AND resultItem."stepId" = callItem."stepId" AND resultItem."taskId" = callItem."taskId" AND resultItem."type" = 'tool_result'
      AND resultItem."content"->>'toolCallId' = callItem."content"->>'toolCallId'
    WHERE callItem."sessionId" = $1 AND callItem."turnId" = $2 AND callItem."taskId" = $3 AND callItem."type" = 'tool_call'
      AND callItem."content"->>'toolName' = 'agent.ask_user'
    ORDER BY step."ordinal" DESC, callItem."startedAt" DESC, callItem."id" DESC LIMIT 65`, [owner.sessionId, owner.turnId, owner.taskId])
  if (calls.rows.length >= 65) throw questionConflict("question recovery scan bound")
  for (const row of calls.rows) {
    const call = record(row.callContent)
    if (!call || typeof call.toolCallId !== "string" || !call.toolCallId.trim() || typeof row.stepId !== "string") throw new TurnQuestionStoreError("question_receipt_malformed", "Owned ask_user call lineage is malformed")
    const toolCallId = call.toolCallId
    if (row.callStatus === "interrupted" || call.status === "interrupted") {
      const result = row.resultContent == null ? null : record(row.resultContent)
      const count = Number(row.resultCount), parsedArguments = parseTurnQuestionArguments(call.input)
      const resultValid = row.resultItemId == null && row.resultStatus == null && row.resultContent == null
        || typeof row.resultItemId === "string" && row.resultStatus === "interrupted" && result !== null
          && exactKeys(result, ["toolCallId", "output", "status", "errorCode"]) && result.toolCallId === toolCallId
          && result.output === null && result.status === "cancelled" && result.errorCode === null
      if (row.callStatus === "interrupted" && call.status === "cancelled" && call.errorCode === null
        && exactKeys(call, ["toolCallId", "toolName", "toolVersion", "status", "errorCode", "input"])
        && call.toolName === "agent.ask_user" && call.toolVersion === "1" && parsedArguments !== null
        && hasInterruptedUsage(row) && Number.isSafeInteger(count) && count <= 1 && resultValid
        && typeof row.callItemId === "string" && await hasQuestionPauseEvents(client, owner, row.stepId, toolCallId, row.callItemId,
          typeof row.resultItemId === "string" ? row.resultItemId : null)) continue
      throw new TurnQuestionStoreError("question_receipt_malformed", "Interrupted ask_user call does not match the pre-intent pause state")
    }
    if (row.callStatus === "failed" || call.status === "failed") {
      const result = record(row.resultContent)
      if (row.callStatus === "completed" && exactKeys(call, ["toolCallId", "toolName", "toolVersion", "status", "errorCode", "input"])
        && call.toolVersion === "1" && call.status === "failed" && typeof call.errorCode === "string"
        && row.resultStatus === "completed" && typeof row.resultItemId === "string" && result?.toolCallId === toolCallId
        && exactKeys(result, ["toolCallId", "output", "errorCode"]) && result.errorCode === call.errorCode && result.output === null) continue
      throw new TurnQuestionStoreError("question_receipt_malformed", "Failed ask_user call does not have a complete pre-intent result")
    }
    const resultContent = record(row.resultContent)
    if (Number(row.resultCount) !== 1 || row.callStatus !== "completed" || !exactKeys(call, ["toolCallId", "toolName", "toolVersion", "status", "errorCode", "input"])
      || call.toolVersion !== "1" || call.status !== "completed" || call.errorCode !== null || typeof row.resultItemId !== "string" || !row.resultItemId
      || row.resultStatus !== "completed" || !resultContent
      || !(exactKeys(resultContent, ["toolCallId", "output", "errorCode"])
        || exactKeys(resultContent, ["toolCallId", "output", "errorCode", "nativeQuestionAttestation"]))) {
      throw new TurnQuestionStoreError("question_receipt_missing", "Owned ask_user result must be recovered before a model call")
    }
    const intent = questionResultIntent(owner, owner.userId, row.stepId, toolCallId, call.input, resultContent)
    const input: TurnQuestionWaitInput = { owner, stepId: row.stepId, toolCallId, now }
    const id = questionId(owner, row.stepId, toolCallId), itemId = questionItemId(id)
    const item = await readQuestionItem(client, input, id, intent)
    if (!item) {
      const { step } = await usageFromStep(client, owner, row.stepId)
      if (turnStatus !== "in_progress" || step.status !== "streaming") throw new TurnQuestionStoreError("question_usage_unavailable", "Prepared question has no active durable step")
      return { status: "prepared", stepId: row.stepId, toolCallId, waitId: id, itemId }
    }
    await readTurnQuestionPlanningWait(client, { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId },
      { stepId: row.stepId, toolCallId, waitId: id, questionItemId: itemId })
    if (item.status === "waiting") {
      const { step } = await usageFromStep(client, owner, row.stepId, ["waiting_for_user"])
      if (turnStatus !== "waiting_for_user" || step.status !== "waiting_for_user") throw questionConflict(`question wait ${id} state`)
      return { status: "waiting", stepId: row.stepId, toolCallId, waitId: id, itemId, turnId: owner.turnId }
    }
    if (item.status === "answered") {
      const { step } = await usageFromStep(client, owner, row.stepId, ["waiting_for_user"])
      if (turnStatus !== "in_progress") throw questionConflict(`answered question ${id} Turn state`)
      if (!step.finishReason) throw new TurnQuestionStoreError("question_usage_unavailable", "Answered question has no durable model usage")
      return { status: "answered", stepId: row.stepId, toolCallId, waitId: id, itemId, turnId: owner.turnId }
    }
    await usageFromStep(client, owner, row.stepId, ["waiting_for_user", "failed", "interrupted"])
    return { status: "closed", stepId: row.stepId, toolCallId, waitId: id, itemId, turnId: owner.turnId }
  }
  return { status: "none" }
}

/** Restores only the exact owned in-progress call needed for idempotent ask_user replay. */
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
      const result = record(row.resultContent)
      if (!result || row.resultStatus !== "started" || typeof row.resultItemId !== "string" || !exactKeys(result,
        Object.hasOwn(result, "nativeQuestionAttestation") ? ["toolCallId", "output", "errorCode", "nativeQuestionAttestation"] : ["toolCallId", "output", "errorCode"])
        || result.toolCallId !== callId || result.errorCode !== null) return null
      try {
        const recoveredIntent = questionResultIntent(owner, owner.userId, row.stepId, callId, call.input, result)
        if (JSON.stringify(recoveredIntent) !== JSON.stringify(requested)) return null
      } catch { return null }
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
