import { createHash } from "node:crypto"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { appendQuestionEvent } from "./turn-question-store-events.js"
import { assertQuestionOwner, completedQuestionResult, lockQuestionStep, persistedUsage, questionConflict,
  type TurnQuestionQueryClient, type TurnQuestionStepRow } from "./turn-question-store-guards.js"

export const QUESTION_STEERING_REFRESH_ERROR_CODE = "steering_changed_before_question_wait" as const

type Usage = { readonly inputTokens: number; readonly outputTokens: number; readonly estimatedCostUsd: number }
type Row = Record<string, unknown>
type Input = Readonly<{
  owner: TurnExecutionOwnerFence
  stepId: string
  toolCallId: string
  callItemId: string
  resultItemId: string
  usage: Usage
  now: Date
}>

function record(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null
}
function exact(value: Row, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",")
}
function equalUsage(left: Usage, right: Usage): boolean {
  return left.inputTokens === right.inputTokens && left.outputTokens === right.outputTokens
    && left.estimatedCostUsd === right.estimatedCostUsd
}
function json(value: unknown): string { return JSON.stringify(value) }

function validateStep(step: TurnQuestionStepRow, input: Input): void {
  if (input.owner.kind !== "turn" || input.owner.taskId !== input.owner.rootTaskId
    || step.status !== "streaming" || (step.errorCode !== null && step.errorCode !== undefined) || step.finishReason !== "tool_calls"
    || !equalUsage(persistedUsage(step), input.usage)) throw questionConflict(`prepared step ${input.stepId} steering refresh`)
}

/** Retires only the exact prepared ask_user pair when its input checkpoint is stale. */
export async function retirePreparedQuestionForSteering(client: TurnQuestionQueryClient, input: Input): Promise<void> {
  assertQuestionOwner(input.owner)
  const step = await lockQuestionStep(client, input.owner, input.stepId)
  validateStep(step, input)
  const ids = [input.callItemId, input.resultItemId].sort()
  if (new Set(ids).size !== 2) throw questionConflict(`ask_user ${input.toolCallId} duplicate lineage`)
  const locked = await client.query<Row>(`SELECT "id", "stepId", "taskId", "type", "status", "revision", "content"
    FROM "agent_items" WHERE "id" = ANY($1::text[]) AND "sessionId" = $2 AND "turnId" = $3 ORDER BY "id" FOR UPDATE`,
  [ids, input.owner.sessionId, input.owner.turnId])
  if (locked.rows.length !== 2) throw questionConflict(`ask_user ${input.toolCallId} item lineage`)
  const call = locked.rows.find(row => row.id === input.callItemId), result = locked.rows.find(row => row.id === input.resultItemId)
  const callContent = record(call?.content), resultContent = record(result?.content)
  if (!call || !result || call.stepId !== input.stepId || result.stepId !== input.stepId
    || call.taskId !== input.owner.taskId || result.taskId !== input.owner.taskId
    || call.type !== "tool_call" || result.type !== "tool_result" || call.status !== "completed" || result.status !== "completed"
    || !Number.isSafeInteger(Number(call.revision)) || Number(call.revision) < 0
    || !Number.isSafeInteger(Number(result.revision)) || Number(result.revision) < 0
    || !callContent || !exact(callContent, ["toolCallId", "toolName", "toolVersion", "status", "errorCode", "input"])
    || callContent.toolCallId !== input.toolCallId || callContent.toolName !== "agent.ask_user" || callContent.toolVersion !== "1"
    || callContent.status !== "completed" || callContent.errorCode !== null
    || !resultContent || resultContent.toolCallId !== input.toolCallId) {
    throw questionConflict(`ask_user ${input.toolCallId} prepared receipt`)
  }
  const receipt = await completedQuestionResult(client, input.owner, input.stepId, input.toolCallId, callContent.input)
  if (receipt.callItemId !== input.callItemId || receipt.resultItemId !== input.resultItemId) {
    throw questionConflict(`ask_user ${input.toolCallId} prepared receipt identity`)
  }

  const failedCall = { ...callContent, status: "failed", errorCode: QUESTION_STEERING_REFRESH_ERROR_CODE }
  const failedResult = { toolCallId: input.toolCallId, output: null, errorCode: QUESTION_STEERING_REFRESH_ERROR_CODE }
  const callUpdate = await client.query(`UPDATE "agent_items" SET "content" = $1::jsonb, "revision" = "revision" + 1,
    "updatedAt" = $2 WHERE "id" = $3 AND "sessionId" = $4 AND "turnId" = $5 AND "stepId" = $6 AND "taskId" = $7
      AND "type" = 'tool_call' AND "status" = 'completed' AND "revision" = $8`,
  [json(failedCall), input.now, input.callItemId, input.owner.sessionId, input.owner.turnId, input.stepId, input.owner.taskId, call.revision])
  if (callUpdate.rowCount !== 1) throw questionConflict(`ask_user ${input.toolCallId} call refresh`)
  const resultUpdate = await client.query(`UPDATE "agent_items" SET "content" = $1::jsonb, "revision" = "revision" + 1,
    "updatedAt" = $2 WHERE "id" = $3 AND "sessionId" = $4 AND "turnId" = $5 AND "stepId" = $6 AND "taskId" = $7
      AND "type" = 'tool_result' AND "status" = 'completed' AND "revision" = $8`,
  [json(failedResult), input.now, input.resultItemId, input.owner.sessionId, input.owner.turnId, input.stepId, input.owner.taskId, result.revision])
  if (resultUpdate.rowCount !== 1) throw questionConflict(`ask_user ${input.toolCallId} result refresh`)
  const stepUpdate = await client.query(`UPDATE "agent_steps" SET "status" = 'failed', "errorCode" = $1, "completedAt" = $2
    WHERE "id" = $3 AND "sessionId" = $4 AND "turnId" = $5 AND "taskId" = $6 AND "attempt" = 1
      AND "status" = 'streaming' AND "finishReason" = 'tool_calls' AND "inputTokens" = $7 AND "outputTokens" = $8
      AND "estimatedCostUsd" = $9`, [QUESTION_STEERING_REFRESH_ERROR_CODE, input.now, input.stepId, input.owner.sessionId,
    input.owner.turnId, input.owner.taskId, input.usage.inputTokens, input.usage.outputTokens, input.usage.estimatedCostUsd])
  if (stepUpdate.rowCount !== 1) throw questionConflict(`step ${input.stepId} steering refresh`)

  const digest = createHash("sha256").update(JSON.stringify([input.owner.userId, input.owner.sessionId, input.owner.turnId,
    input.owner.taskId, input.stepId, input.toolCallId]), "utf8").digest("hex")
  const base = `turn:${input.owner.turnId}:event:question-steering-refresh:${digest}`
  const callEventId = `agent-question-steering-refresh-call-${digest}`
  const callItemEventId = `agent-question-steering-refresh-call-item-${digest}`
  const resultItemEventId = `agent-question-steering-refresh-result-item-${digest}`
  const stepEventId = `agent-question-steering-refresh-step-${digest}`
  const previous = await client.query<Row>(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
    ORDER BY "sequence" DESC LIMIT 1`, [input.owner.sessionId, input.owner.turnId, input.owner.taskId])
  const previousId = previous.rows[0]?.id
  if (previousId !== undefined && (typeof previousId !== "string" || !previousId.trim())) throw questionConflict(`event ${base} causation`)
  const cause = previousId ?? null
  const common = { owner: input.owner }
  await appendQuestionEvent(client, { ...common, id: callEventId, type: "tool_call.failed", itemId: input.callItemId,
    correlationId: input.toolCallId, causationId: cause, idempotencyKey: `${base}:call`,
    payload: { toolCallId: input.toolCallId, toolName: "agent.ask_user", status: "failed", errorCode: QUESTION_STEERING_REFRESH_ERROR_CODE, taskId: input.owner.taskId } })
  await appendQuestionEvent(client, { ...common, id: callItemEventId, type: "item.completed", itemId: input.callItemId,
    correlationId: input.callItemId, causationId: callEventId, idempotencyKey: `${base}:call-item`,
    payload: { itemId: input.callItemId, status: "completed", content: { toolCallId: input.toolCallId,
      toolName: "agent.ask_user", toolVersion: "1", status: "failed", errorCode: QUESTION_STEERING_REFRESH_ERROR_CODE } } })
  await appendQuestionEvent(client, { ...common, id: resultItemEventId, type: "item.completed", itemId: input.resultItemId,
    correlationId: input.resultItemId, causationId: callItemEventId, idempotencyKey: `${base}:result-item`,
    payload: { itemId: input.resultItemId, status: "completed", content: failedResult } })
  await appendQuestionEvent(client, { ...common, id: stepEventId, type: "step.completed", itemId: null,
    correlationId: input.stepId, causationId: resultItemEventId, idempotencyKey: `${base}:step`,
    payload: { stepId: input.stepId, status: "failed", errorCode: QUESTION_STEERING_REFRESH_ERROR_CODE, toolCallCount: 1, taskId: input.owner.taskId } })
}
