import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { createTurnScheduledPrepareChoiceContent, isTurnQuestionUsage, parseTurnScheduledPrepareChoiceItem, TurnQuestionStoreError,
  type TurnQuestionIntentEnvelope, type TurnQuestionRecovery, type TurnQuestionScheduledChoiceReadInput, type TurnQuestionScheduledChoiceRecovery, type TurnQuestionStore, type TurnQuestionUsageInput, type TurnQuestionWaitInput, type TurnQuestionWaitReceipt } from "./turn-question-contract.js"
import { admitQuestionWork, assertQuestionOwner, assertQuestionUsage, completedQuestionResult, lockQuestionStep, persistedUsage, questionConflict, questionId, questionItemId, withQuestionTransaction, type TurnQuestionPool, type TurnQuestionQueryClient, type TurnQuestionStepRow } from "./turn-question-store-guards.js"
import { appendQuestionStartedEvents, appendScheduledChoiceWaitEvents, loadScheduledChoiceBinding, OrphanPauseUsageRecoveredError, recoverPausedOrphanUsage } from "./turn-question-store-events.js"
import { toRepositoryJson } from "./turn-engine-types.js"
import { cancelPausedQuestion, recoverPausedPartialQuestion } from "./turn-question-store-cancellation.js"
import { appendTurnQuestionPlanningObservation, prepareTurnQuestionPlanningObservation } from "./turn-question-planning-store.js"
import { readTurnQuestionPlanningWait } from "./turn-question-planning-history.js"
import { readScheduledGateChoice, waitForScheduledGateChoice } from "./turn-question-gate-choice-store.js"
import { readPendingQuestion, recoverIncompleteQuestionCall } from "./turn-question-store-recovery.js"
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

async function waitForScheduledChoice(pool: TurnQuestionPool, input: TurnQuestionWaitInput): Promise<TurnQuestionWaitReceipt> {
  assertQuestionOwner(input.owner)
  if (!input.expectedWaitId?.trim() || !Number.isFinite(input.now.getTime())) throw new TurnQuestionStoreError("question_not_current", "Scheduled choice wait scope is invalid")
  const usage = input.usage
  return withQuestionTransaction(pool, input.owner, async (client, turn) => {
    const stored = await loadScheduledChoiceBinding(client, { owner: input.owner })
    if (stored.waitId !== input.expectedWaitId || stored.candidateFinishReason !== input.finishReason || usage === undefined || !isTurnQuestionUsage(usage) || !same(stored.candidateUsage, usage)) throw questionConflict("Worker-derived scheduled wait receipt")
    const id = stored.waitId, itemId = questionItemId(id)
    const found = await client.query<Row>(`SELECT "id", "stepId", "taskId", "type", "status", "content" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 FOR UPDATE`, [itemId, input.owner.sessionId, input.owner.turnId])
    const row = found.rows[0]
    if (row) {
      const answer = parseTurnScheduledPrepareChoiceItem(row.content, row.status, stored.binding)
      if (found.rows.length !== 1 || row.stepId !== stored.stepId || row.taskId !== input.owner.taskId || row.type !== "question" || answer === undefined) throw questionConflict(`scheduled choice item ${itemId}`)
      await usageFromStep(client, input.owner, stored.stepId, ["waiting_for_user"])
      if (answer === null && (turn.status !== "waiting_for_user" || row.status !== "started")
        || answer !== null && (turn.status !== "in_progress" || row.status !== "completed")) throw questionConflict(`scheduled choice wait ${id} state`)
      return waitReceipt(answer === null ? "waiting_for_user" : "answered", "replayed", { ...input, stepId: stored.stepId, toolCallId: null }, id, Number(turn.revision))
    }
    if (turn.status !== "in_progress" || stored.stepStatus !== "streaming" || !input.finishReason?.trim() || input.finishReason.length > 128) throw new TurnQuestionStoreError("question_usage_unavailable", "Scheduled choice needs the exact final model usage")
    const inputTokens = usage?.inputTokens ?? 0, outputTokens = usage?.outputTokens ?? 0, estimatedCostUsd = usage?.estimatedCostUsd ?? 0
    const step = await lockQuestionStep(client, input.owner, stored.stepId)
    if (step.status !== "streaming" || step.finishReason !== null && (step.finishReason !== input.finishReason
      || numeric(step.inputTokens) !== inputTokens || numeric(step.outputTokens) !== outputTokens
      || numeric(step.estimatedCostUsd) !== estimatedCostUsd)) throw questionConflict(`scheduled final step ${stored.stepId} state`)
    await admitQuestionWork(client, input.owner)
    await client.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "content", "startedAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, 'question', 'started', 'commentary', $6::jsonb, $7, $7)`,
    [itemId, input.owner.sessionId, input.owner.turnId, stored.stepId, input.owner.taskId, json(createTurnScheduledPrepareChoiceContent(id, stored.binding)), input.now])
    const closed = await client.query(`UPDATE "agent_steps" SET "status" = 'waiting_for_user', "finishReason" = $1, "errorCode" = NULL, "inputTokens" = $2, "outputTokens" = $3, "estimatedCostUsd" = $4, "completedAt" = $5 WHERE "id" = $6 AND "sessionId" = $7 AND "turnId" = $8 AND "taskId" = $9 AND "attempt" = 1 AND "status" = 'streaming'`,
    [input.finishReason, inputTokens, outputTokens, estimatedCostUsd, input.now, stored.stepId, input.owner.sessionId, input.owner.turnId, input.owner.taskId])
    if (closed.rowCount !== 1) throw questionConflict(`scheduled final step ${stored.stepId} close`)
    const updated = await client.query<{ revision: number | string }>(`UPDATE "agent_turns" SET "status" = 'waiting_for_user', "revision" = "revision" + 1, "completedAt" = NULL, "updatedAt" = $1 WHERE "id" = $2 AND "sessionId" = $3 AND "userId" = $4 AND "leaseOwnerId" = $5 AND "leaseVersion" = $6 AND "leaseExpiresAt" > CURRENT_TIMESTAMP AND "status" = 'in_progress' RETURNING "revision"`,
    [input.now, input.owner.turnId, input.owner.sessionId, input.owner.userId, input.owner.ownerId, input.owner.leaseVersion])
    if (updated.rowCount !== 1 || !updated.rows[0]) throw questionConflict(`Turn ${input.owner.turnId} scheduled choice wait`)
    await appendScheduledChoiceWaitEvents(client, { owner: input.owner, stepId: stored.stepId, itemId, waitId: id })
    return waitReceipt("waiting_for_user", "created", { ...input, stepId: stored.stepId, toolCallId: null }, id, Number(updated.rows[0].revision))
  })
}

async function readScheduledPrepareChoice(pool: TurnQuestionPool, input: TurnQuestionScheduledChoiceReadInput): Promise<TurnQuestionScheduledChoiceRecovery> {
  assertQuestionOwner(input.owner)
  if (!Number.isFinite(input.now.getTime())) throw new TurnQuestionStoreError("question_not_current", "Scheduled choice recovery time is invalid")
  return withQuestionTransaction(pool, input.owner, async (client, turn) => {
    const stored = await loadScheduledChoiceBinding(client, { owner: input.owner, expectedReceipt: input.receipt }), itemId = questionItemId(stored.waitId)
    const found = await client.query<Row>(`SELECT "id", "stepId", "taskId", "type", "status", "content" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 FOR SHARE`, [itemId, input.owner.sessionId, input.owner.turnId])
    if (!found.rows.length) return { status: "none" }
    const row = found.rows[0], answer = parseTurnScheduledPrepareChoiceItem(row?.content, row?.status, stored.binding)
    if (found.rows.length !== 1 || row?.stepId !== stored.stepId || row.taskId !== input.owner.taskId || row.type !== "question" || answer === undefined) throw questionConflict(`scheduled choice answer ${itemId}`)
    const stepStatuses = answer === null ? ["waiting_for_user"] : ["waiting_for_user", "streaming"]
    await usageFromStep(client, input.owner, stored.stepId, stepStatuses)
    if (answer === null && (turn.status !== "waiting_for_user" || row.status !== "started")) throw questionConflict(`scheduled choice ${stored.waitId} waiting state`)
    if (answer !== null && (turn.status !== "in_progress" || row.status !== "completed")) throw questionConflict(`scheduled choice ${stored.waitId} answer state`)
    return answer === null ? { status: "waiting", waitId: stored.waitId, itemId, binding: stored.binding }
      : { status: "answered", waitId: stored.waitId, itemId, answer, binding: stored.binding }
  })
}

export function createPgTurnQuestionStore(pool: TurnQuestionPool): TurnQuestionStore {
  return {
    cancelPausedQuestion: input => cancelPausedQuestion(pool, input),
    readScheduledPrepareChoice: input => readScheduledPrepareChoice(pool, input),
    readScheduledGateChoice: input => readScheduledGateChoice(pool, input),
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
      const toolCallId = input.toolCallId
      const hasGateBinding = input.gateChoiceBinding !== undefined || input.gateChoiceQuestion !== undefined
      if (toolCallId === null) return hasGateBinding ? waitForScheduledGateChoice(pool, input) : waitForScheduledChoice(pool, input)
      if (hasGateBinding) throw questionConflict("Gate binding on native tool question")
      if (!input.stepId.trim() || !toolCallId.trim() || !Number.isFinite(input.now.getTime())) throw new TurnQuestionStoreError("question_not_current", "Question call scope is invalid")
      const questionInput = { ...input, toolCallId }
      return withQuestionTransaction(pool, input.owner, async (client, turn) => {
        const receipt = await completedQuestionResult(client, input.owner, input.stepId, toolCallId)
        const id = questionId(input.owner, input.stepId, toolCallId)
        const existing = await readQuestionItem(client, questionInput, id, receipt.intent)
        const planningOwner = { userId: input.owner.userId, sessionId: input.owner.sessionId, turnId: input.owner.turnId, rootTaskId: input.owner.rootTaskId }
        const planningWait = { stepId: input.stepId, toolCallId, waitId: id, questionItemId: questionItemId(id) }
        if (existing) await readTurnQuestionPlanningWait(client, planningOwner, planningWait)
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
        const planningObservation = turn.status === "in_progress"
          ? await prepareTurnQuestionPlanningObservation(client, { owner: input.owner, ...planningWait }) : null
        const { step, usage } = await usageFromStep(client, input.owner, input.stepId)
        if (turn.status !== "in_progress" || step.status !== "streaming") throw new TurnQuestionStoreError("question_not_current", "Prepared question is no longer active")
        await admitQuestionWork(client, input.owner)
        const itemId = questionItemId(id)
        await client.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "content", "startedAt", "updatedAt")
          VALUES ($1, $2, $3, $4, $5, 'question', 'started', 'commentary', $6::jsonb, $7, $7)`,
        [itemId, input.owner.sessionId, input.owner.turnId, input.stepId, input.owner.taskId, json(waitContent(id, toolCallId, receipt.intent)), input.now])
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
        await appendQuestionStartedEvents(client, { owner: input.owner, stepId: input.stepId, itemId, questionId: id, toolCallId, toolCallCount: Number(calls.rows[0]?.count ?? 0) })
        if (planningObservation) await appendTurnQuestionPlanningObservation(client, planningObservation, input.owner.userId)
        return waitReceipt("waiting_for_user", "created", questionInput, id, Number(updated.rows[0].revision))
      })
    },
    async readPendingQuestion(input): Promise<TurnQuestionRecovery> {
      assertQuestionOwner(input.owner)
      if (!Number.isFinite(input.now.getTime())) throw new TurnQuestionStoreError("question_not_current", "Question recovery time is invalid")
      const read = () => withQuestionTransaction(pool, input.owner, async (client, turn) => readPendingQuestion(client, input.owner, turn.status, input.now))
      try {
        const pending = await read()
        if (pending.status === "none" && await recoverPausedOrphanUsage(pool, input.owner, input.now)) {
          throw new OrphanPauseUsageRecoveredError()
        }
        return pending
      }
      catch (error: unknown) {
        if (!(error instanceof TurnQuestionStoreError) || error.code !== "question_receipt_missing") throw error
        if (await recoverPausedPartialQuestion(pool, input.owner, input.now)) throw new OrphanPauseUsageRecoveredError()
        const replayable = await recoverIncompleteQuestionCall(pool, input.owner, input.now)
        if (replayable) return replayable
        throw error
      }
    },
  }
}
