import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { parseTurnQuestionArguments, parseTurnQuestionIntentEnvelope, TurnQuestionStoreError, type TurnQuestionIntentEnvelope, type TurnQuestionRecovery, type TurnQuestionStore, type TurnQuestionUsageInput, type TurnQuestionWaitInput, type TurnQuestionWaitReceipt } from "./turn-question-contract.js"
import { admitQuestionWork, assertQuestionOwner, assertQuestionUsage, completedQuestionResult, lockQuestionStep, persistedUsage, questionConflict, questionId, questionItemId, withQuestionTransaction, type TurnQuestionPool, type TurnQuestionQueryClient, type TurnQuestionStepRow } from "./turn-question-store-guards.js"
import { appendQuestionStartedEvents } from "./turn-question-store-events.js"
import { toRepositoryJson } from "./turn-engine-types.js"
import { cancelPausedQuestion, hasQuestionPauseEvents } from "./turn-question-store-cancellation.js"

type Row = Record<string, unknown>
function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null ? value as Row : null
}
function json(value: unknown): string { return JSON.stringify(value) }
function same(left: unknown, right: unknown): boolean {
  try { return json(toRepositoryJson(left)) === json(toRepositoryJson(right)) } catch { return false }
}
function numeric(value: unknown): number { const result = Number(value); return Number.isFinite(result) ? result : NaN }
function exactKeys(value: Row, keys: readonly string[]): boolean { return Object.keys(value).sort().join(",") === [...keys].sort().join(",") }
function hasInterruptedUsage(row: Row): boolean {
  const inputTokens = Number(row.inputTokens), outputTokens = Number(row.outputTokens), cost = Number(row.estimatedCostUsd)
  return row.stepStatus === "interrupted" && row.stepErrorCode === "session_pause_requested"
    && typeof row.finishReason === "string" && row.finishReason.trim().length > 0
    && Number.isSafeInteger(inputTokens) && inputTokens >= 0 && Number.isSafeInteger(outputTokens) && outputTokens >= 0
    && Number.isFinite(cost) && cost >= 0
}
function waitContent(id: string, callId: string, intent: TurnQuestionIntentEnvelope): RepositoryJsonValue {
  return { waitKind: "question", questionId: id, toolCallId: callId, stage: "user_input", question: intent.question,
    options: toRepositoryJson(intent.options), answer: null, answerAvailable: false }
}
function validUsage(input: TurnQuestionUsageInput): void { assertQuestionOwner(input.owner); assertQuestionUsage(input) }

async function readQuestionItem(client: TurnQuestionQueryClient, input: TurnQuestionWaitInput, id: string, intent: TurnQuestionIntentEnvelope): Promise<{ status: "waiting" | "answered" | "closed"; itemId: string } | null> {
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

function waitReceipt(status: TurnQuestionWaitReceipt["status"], disposition: TurnQuestionWaitReceipt["disposition"], input: TurnQuestionWaitInput, id: string, revision: number): TurnQuestionWaitReceipt {
  return { status, disposition, waitId: id, itemId: questionItemId(id), turnId: input.owner.turnId, toolCallId: input.toolCallId, nextTurnRevision: revision }
}

async function usageFromStep(client: TurnQuestionQueryClient, owner: TurnQuestionWaitInput["owner"], stepId: string, statuses: readonly string[] = ["streaming"]): Promise<{ step: TurnQuestionStepRow; usage: ReturnType<typeof persistedUsage> }> {
  const step = await lockQuestionStep(client, owner, stepId)
  const usage = persistedUsage(step, statuses)
  return { step, usage }
}

export function createPgTurnQuestionStore(pool: TurnQuestionPool): TurnQuestionStore {
  return {
    cancelPausedQuestion: input => cancelPausedQuestion(pool, input),
    async stageQuestionUsage(input: TurnQuestionUsageInput): Promise<void> {
      validUsage(input)
      await withQuestionTransaction(pool, input.owner, async (client, turn) => {
        if (turn.status !== "in_progress") throw new TurnQuestionStoreError("question_not_current", "Question Turn is not active")
        await admitQuestionWork(client, input.owner)
        const step = await lockQuestionStep(client, input.owner, input.stepId)
        if (step.status !== "streaming") throw questionConflict(`step ${input.stepId} state`)
        const call = await client.query<Row>(`SELECT "status", "content" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2
          AND "stepId" = $3 AND "taskId" = $4 AND "type" = 'tool_call' AND "content"->>'toolCallId' = $5 FOR UPDATE`,
        [input.owner.sessionId, input.owner.turnId, input.stepId, input.owner.taskId, input.toolCallId])
        const callContent = call.rows[0] && record(call.rows[0].content)
        if (call.rows.length !== 1 || !callContent || callContent.toolName !== "agent.ask_user" || call.rows[0]?.status !== "started") {
          throw questionConflict(`tool call ${input.toolCallId} lineage`)
        }
        if (step.finishReason !== null) {
          if (step.finishReason !== input.finishReason || numeric(step.inputTokens) !== input.usage.inputTokens
            || numeric(step.outputTokens) !== input.usage.outputTokens || numeric(step.estimatedCostUsd) !== input.usage.estimatedCostUsd) throw questionConflict(`step ${input.stepId} usage replay`)
          return
        }
        const updated = await client.query(`UPDATE "agent_steps" SET "finishReason" = $1, "inputTokens" = $2, "outputTokens" = $3,
          "estimatedCostUsd" = $4 WHERE "id" = $5 AND "sessionId" = $6 AND "turnId" = $7 AND "taskId" = $8 AND "attempt" = 1 AND "status" = 'streaming'`,
        [input.finishReason, input.usage.inputTokens, input.usage.outputTokens, input.usage.estimatedCostUsd, input.stepId, input.owner.sessionId, input.owner.turnId, input.owner.taskId])
        if (updated.rowCount !== 1) throw questionConflict(`step ${input.stepId} usage update`)
      })
    },
    async waitForQuestion(input: TurnQuestionWaitInput): Promise<TurnQuestionWaitReceipt> {
      assertQuestionOwner(input.owner)
      if (!input.stepId.trim() || !input.toolCallId.trim() || !Number.isFinite(input.now.getTime())) throw new TurnQuestionStoreError("question_not_current", "Question call scope is invalid")
      return withQuestionTransaction(pool, input.owner, async (client, turn) => {
        const receipt = await completedQuestionResult(client, input.owner, input.stepId, input.toolCallId)
        const id = questionId(input.owner, input.stepId, input.toolCallId)
        const existing = await readQuestionItem(client, input, id, receipt.intent)
        if (existing?.status === "closed") {
          await usageFromStep(client, input.owner, input.stepId, ["waiting_for_user", "failed", "interrupted"])
          throw new TurnQuestionStoreError("question_not_current", "Question was closed before recovery")
        }
        if (existing?.status === "waiting") {
          const { step } = await usageFromStep(client, input.owner, input.stepId, ["waiting_for_user"])
          if (turn.status !== "waiting_for_user" || step.status !== "waiting_for_user") throw questionConflict(`question wait ${id} state`)
          return waitReceipt("waiting_for_user", "replayed", input, id, Number(turn.revision))
        }
        if (existing?.status === "answered") {
          await usageFromStep(client, input.owner, input.stepId, ["waiting_for_user"])
          if (turn.status !== "in_progress") throw questionConflict(`answered question ${id} Turn state`)
          return waitReceipt("answered", "replayed", input, id, Number(turn.revision))
        }
        const { step, usage } = await usageFromStep(client, input.owner, input.stepId)
        if (turn.status !== "in_progress" || step.status !== "streaming") throw new TurnQuestionStoreError("question_not_current", "Prepared question is no longer active")
        await admitQuestionWork(client, input.owner)
        const itemId = questionItemId(id)
        await client.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "content", "startedAt", "updatedAt")
          VALUES ($1, $2, $3, $4, $5, 'question', 'started', 'commentary', $6::jsonb, $7, $7)`,
        [itemId, input.owner.sessionId, input.owner.turnId, input.stepId, input.owner.taskId, json(waitContent(id, input.toolCallId, receipt.intent)), input.now])
        const closed = await client.query(`UPDATE "agent_steps" SET "status" = 'waiting_for_user', "finishReason" = $1, "inputTokens" = $2,
          "outputTokens" = $3, "estimatedCostUsd" = $4, "completedAt" = $5 WHERE "id" = $6 AND "sessionId" = $7 AND "turnId" = $8 AND "taskId" = $9 AND "attempt" = 1 AND "status" = 'streaming'`,
        [step.finishReason, usage.inputTokens, usage.outputTokens, usage.estimatedCostUsd, input.now, input.stepId, input.owner.sessionId, input.owner.turnId, input.owner.taskId])
        if (closed.rowCount !== 1) throw questionConflict(`step ${input.stepId} close`)
        const updated = await client.query<{ revision: number | string }>(`UPDATE "agent_turns" SET "status" = 'waiting_for_user', "revision" = "revision" + 1,
          "completedAt" = NULL, "updatedAt" = $1 WHERE "id" = $2 AND "sessionId" = $3 AND "userId" = $4 AND "leaseOwnerId" = $5
          AND "leaseVersion" = $6 AND "leaseExpiresAt" > CURRENT_TIMESTAMP AND "status" = 'in_progress' RETURNING "revision"`,
        [input.now, input.owner.turnId, input.owner.sessionId, input.owner.userId, input.owner.ownerId, input.owner.leaseVersion])
        if (updated.rowCount !== 1 || !updated.rows[0]) throw questionConflict(`Turn ${input.owner.turnId} wait state`)
        const calls = await client.query<{ count: string | number }>(`SELECT COUNT(*) AS "count" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "stepId" = $3 AND "taskId" = $4 AND "type" = 'tool_call'`,
          [input.owner.sessionId, input.owner.turnId, input.stepId, input.owner.taskId])
        await appendQuestionStartedEvents(client, { owner: input.owner, stepId: input.stepId, itemId, questionId: id, toolCallId: input.toolCallId, toolCallCount: Number(calls.rows[0]?.count ?? 0) })
        return waitReceipt("waiting_for_user", "created", input, id, Number(updated.rows[0].revision))
      })
    },
    async readPendingQuestion(input): Promise<TurnQuestionRecovery> {
      assertQuestionOwner(input.owner)
      if (!Number.isFinite(input.now.getTime())) throw new TurnQuestionStoreError("question_not_current", "Question recovery time is invalid")
      return withQuestionTransaction(pool, input.owner, async (client, turn) => readPending(client, input.owner, turn.status, input.now))
    },
  }
}

async function readPending(client: TurnQuestionQueryClient, owner: TurnQuestionWaitInput["owner"], turnStatus: string, now: Date): Promise<TurnQuestionRecovery> {
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
      || row.resultStatus !== "completed" || !resultContent || !exactKeys(resultContent, ["toolCallId", "output", "errorCode"])) {
      throw new TurnQuestionStoreError("question_receipt_missing", "Owned ask_user result must be recovered before a model call")
    }
    const content = resultContent, intent = parseTurnQuestionIntentEnvelope(content.output)
    const requested = parseTurnQuestionArguments(call.input)
    if (content.toolCallId !== toolCallId || content.errorCode !== null || !intent || !requested) throw new TurnQuestionStoreError("question_receipt_malformed", "Owned ask_user result receipt is malformed")
    if (!same(intent, requested)) throw questionConflict(`tool call ${toolCallId} intent/result identity`)
    const input: TurnQuestionWaitInput = { owner, stepId: row.stepId, toolCallId, now }
    const id = questionId(owner, row.stepId, toolCallId), itemId = questionItemId(id)
    const item = await readQuestionItem(client, input, id, intent)
    if (!item) {
      const { step } = await usageFromStep(client, owner, row.stepId)
      if (turnStatus !== "in_progress" || step.status !== "streaming") throw new TurnQuestionStoreError("question_usage_unavailable", "Prepared question has no active durable step")
      return { status: "prepared", stepId: row.stepId, toolCallId, waitId: id, itemId }
    }
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
