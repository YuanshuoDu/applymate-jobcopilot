import { createHash } from "node:crypto"

import { Prisma } from "@prisma/client"

import { invalidAnswer, waitNotPending, type AgentWaitError } from "./errors"

type Tx = Prisma.TransactionClient
type JsonRecord = Record<string, unknown>
type TurnRow = { id: string; sessionId: string; userId: string; status: string; revision: number }
type QuestionRow = { id: string; userId: string; runId: string; options: unknown; answer: string | null }
type ExecutionRow = { id: string; status: string; attemptCount: number; workerTaskId: string | null }
type DispatchPayload = { userId: string; sessionId: string; executionId: string; attemptCount: number; questionId: string }
type DispatchIntentRow = { id: string; topic: string; aggregateId: string; idempotencyKey: string; payload: unknown }
export type LegacyDispatchAcceptedResult = { disposition: "legacy_dispatch_accepted"; questionId: string; sessionId: string; turnId?: string; executionId: string; attemptCount: number; outboxId: string; idempotencyKey: string }
type LegacyQuestionDispatchBase = { questionId: string; sessionId: string; turnId?: string; executionId: string; attemptCount: number }
export type LegacyQuestionDispatchResult =
  | (LegacyQuestionDispatchBase & { disposition: "legacy_dispatch_pending"; outboxId: string; idempotencyKey: string })
  | (LegacyQuestionDispatchBase & { disposition: "legacy_already_resuming" | "legacy_dispatch_conflict" })
export type LegacyQuestionResumeResult = LegacyDispatchAcceptedResult | LegacyQuestionDispatchResult
export type LegacyNoTurnQuestionResult = LegacyQuestionResumeResult | { disposition: "legacy_answered"; questionId: string; sessionId: string; answer: string } | { disposition: "legacy_only"; reason: "active_turn_owns_wait" | "question_not_waiting" }

function record(value: unknown): JsonRecord { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {} }
function optionValues(options: unknown): string[] {
  return Array.isArray(options) ? options.flatMap(option => {
    const value = record(option).value
    return typeof value === "string" ? [value] : []
  }) : []
}
function invalidAnswerError(): AgentWaitError { return invalidAnswer("Answer is not one of the offered options") }
export function namespacedQuestionTurnId(questionId: string): string | null { return /^agent-question:([^:]+):legacy:[^:]+$/.exec(questionId)?.[1] ?? null }
function dispatchIntent(input: DispatchPayload): Omit<DispatchIntentRow, "payload"> & { payload: Prisma.InputJsonObject } {
  if (!input.userId || !input.sessionId || !input.executionId || !input.questionId || !Number.isSafeInteger(input.attemptCount) || input.attemptCount < 0) throw new Error("invalid_agent_execution_dispatch")
  const idempotencyKey = `legacy-execution-dispatch:${input.executionId}:${input.attemptCount}:${input.questionId}`
  const digest = createHash("sha256").update(idempotencyKey).digest("hex")
  return {
    id: `legacy-execution-dispatch-${digest}`,
    topic: "agent.execution.dispatch",
    aggregateId: input.sessionId,
    idempotencyKey,
    payload: { userId: input.userId, sessionId: input.sessionId, executionId: input.executionId, attemptCount: input.attemptCount, questionId: input.questionId },
  }
}
function matchesDispatchIntent(row: DispatchIntentRow, expected: ReturnType<typeof dispatchIntent>): boolean {
  const payload = row.payload
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false
  const actual = payload as Record<string, unknown>
  const expectedPayload = expected.payload
  return row.id === expected.id && row.topic === expected.topic && row.aggregateId === expected.aggregateId
    && row.idempotencyKey === expected.idempotencyKey
    && Object.keys(actual).length === 5
    && actual.userId === expectedPayload.userId && actual.sessionId === expectedPayload.sessionId
    && actual.executionId === expectedPayload.executionId && actual.attemptCount === expectedPayload.attemptCount
    && actual.questionId === expectedPayload.questionId
}
async function ensureDispatchIntent(tx: Tx, input: DispatchPayload): Promise<DispatchIntentRow | null> {
  const expected = dispatchIntent(input)
  const row = await tx.agentOutbox.findUnique({ where: { idempotencyKey: expected.idempotencyKey } }) as DispatchIntentRow | null
  if (row) return matchesDispatchIntent(row, expected) ? row : null
  await tx.agentOutbox.create({ data: expected })
  return expected
}
async function createDispatchIntent(tx: Tx, input: DispatchPayload): Promise<ReturnType<typeof dispatchIntent>> {
  const intent = dispatchIntent(input)
  await tx.agentOutbox.create({ data: intent })
  return intent
}
/** Caller must hold the owning Session lock first. Returns only active Turns. */
export async function lockNamespacedQuestionTurn(
  tx: Tx,
  input: { turnId: string; sessionId: string; userId: string },
): Promise<TurnRow | null> {
  const rows = await tx.$queryRaw<TurnRow[]>(Prisma.sql`
    SELECT "id", "sessionId", "userId", "status", "revision" FROM "agent_turns"
    WHERE "id" = ${input.turnId} AND "sessionId" = ${input.sessionId} AND "userId" = ${input.userId}
      AND "status" IN ('queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user')
    FOR UPDATE
  `)
  return rows[0] ?? null
}
export async function answerLegacyQuestionWithoutTurnInTransaction(
  tx: Tx,
  input: { question: QuestionRow; userId: string; sessionId: string; answer: string },
): Promise<LegacyNoTurnQuestionResult> {
  const question = input.question
  const turnId = namespacedQuestionTurnId(question.id)
  if ((question.id.startsWith("agent-question:") && !turnId) || question.userId !== input.userId
    || question.runId !== input.sessionId || turnId) return { disposition: "legacy_only", reason: "question_not_waiting" }
  if (question.answer !== null && question.answer !== input.answer) throw waitNotPending()
  const values = optionValues(question.options)
  if (values.length > 0 && !values.includes(input.answer)) throw invalidAnswerError()
  const activeTurns = await tx.$queryRaw<Array<{ id: string; input: unknown }>>(Prisma.sql`
    SELECT "id", "input" FROM "agent_turns"
    WHERE "sessionId" = ${input.sessionId} AND "userId" = ${input.userId}
      AND "status" IN ('queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user')
    FOR UPDATE
  `)
  const executions = await tx.$queryRaw<ExecutionRow[]>(Prisma.sql`
    SELECT "id", "status", "attemptCount", "workerTaskId" FROM "agent_executions"
    WHERE "sessionId" = ${input.sessionId} AND "userId" = ${input.userId}
    FOR UPDATE
  `)
  const execution = executions[0]
  const hasExactResumeProvenance = activeTurns.some(turn => record(turn.input).legacyResumeQuestionId === question.id)
  if (activeTurns.length > 0 && question.answer === input.answer && !hasExactResumeProvenance) return { disposition: "legacy_answered", questionId: question.id, sessionId: input.sessionId, answer: input.answer }
  if (hasExactResumeProvenance && question.answer === input.answer && execution
    && (execution.status === "running" || (execution.status === "queued" && execution.workerTaskId !== null))) return { disposition: "legacy_already_resuming", questionId: question.id, sessionId: input.sessionId, executionId: execution.id, attemptCount: execution.attemptCount }
  if (activeTurns.length > 0) return { disposition: "legacy_only", reason: "active_turn_owns_wait" }
  const acceptQuestion = async () => {
    if (question.answer !== null) return
    const updated = await tx.agentRunQuestion.updateMany({
      where: { id: question.id, userId: input.userId, runId: input.sessionId, answer: null },
      data: { answer: input.answer, answeredAt: new Date() },
    })
    if (updated.count !== 1) throw waitNotPending()
  }
  if (!execution || !["waiting_for_user", "queued", "running"].includes(execution.status)) {
    await acceptQuestion()
    return { disposition: "legacy_answered", questionId: question.id, sessionId: input.sessionId, answer: input.answer }
  }
  const result = { questionId: question.id, sessionId: input.sessionId, executionId: execution.id, attemptCount: execution.attemptCount }
  if (execution.status === "queued" || execution.status === "running") {
    if (question.answer !== input.answer) return { disposition: "legacy_only", reason: "question_not_waiting" }
    if (execution.status === "queued" && execution.workerTaskId === null) {
      const intent = await ensureDispatchIntent(tx, {
        userId: input.userId, sessionId: input.sessionId, executionId: execution.id,
        attemptCount: execution.attemptCount, questionId: question.id,
      })
      if (!intent) return { disposition: "legacy_dispatch_conflict", ...result }
      return { disposition: "legacy_dispatch_pending", ...result, outboxId: intent.id, idempotencyKey: intent.idempotencyKey }
    }
    if (question.answer !== input.answer) return { disposition: "legacy_only", reason: "question_not_waiting" }
    return { disposition: "legacy_already_resuming", ...result }
  }
  await acceptQuestion()
  const claimed = await tx.agentExecution.updateMany({
    where: {
      id: execution.id, userId: input.userId, sessionId: input.sessionId,
      status: "waiting_for_user", attemptCount: execution.attemptCount, workerTaskId: execution.workerTaskId,
    },
    data: { status: "queued", workerTaskId: null, error: null, completedAt: null },
  })
  if (claimed.count !== 1) throw waitNotPending()
  const intent = await createDispatchIntent(tx, {
    userId: input.userId, sessionId: input.sessionId, executionId: execution.id, attemptCount: execution.attemptCount, questionId: question.id,
  })
  return { disposition: "legacy_dispatch_accepted", ...result, outboxId: intent.id, idempotencyKey: intent.idempotencyKey }
}

/** Caller holds Session then this exact waiting Turn; there is no AgentItem in legacy dual-write-off mode. */
export async function answerLegacyResumableQuestionInTransaction(
  tx: Tx,
  input: { question: QuestionRow; turn: TurnRow; answer: string },
): Promise<LegacyQuestionResumeResult | null> {
  const question = input.question
  if (question.userId !== input.turn.userId || question.runId !== input.turn.sessionId
    || namespacedQuestionTurnId(question.id) !== input.turn.id
    || !["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"].includes(input.turn.status)) return null
  if (question.answer !== null && question.answer !== input.answer) throw waitNotPending()
  const values = optionValues(question.options)
  if (values.length > 0 && !values.includes(input.answer)) throw invalidAnswerError()

  const executions = await tx.$queryRaw<ExecutionRow[]>(Prisma.sql`
    SELECT "id", "status", "attemptCount", "workerTaskId" FROM "agent_executions"
    WHERE "sessionId" = ${question.runId} AND "userId" = ${question.userId}
    FOR UPDATE
  `)
  const execution = executions[0]
  if (!execution) return null

  const result = { questionId: question.id, sessionId: question.runId, turnId: input.turn.id, executionId: execution.id, attemptCount: execution.attemptCount }
  // A persisted answer must not replay or pause work on an active Turn.
  if (input.turn.status === "in_progress" && question.answer !== null) return { ...result, disposition: "legacy_already_resuming" }
  if (input.turn.status === "in_progress" && ["running", "waiting_for_user"].includes(execution.status)) {
    // Older runners committed the visible question before separately pausing
    // the Turn/execution. Answering that exact Turn repairs all lifecycle rows
    // and creates its dispatch intent atomically, fencing any late old runner.
    const answered = await tx.agentRunQuestion.updateMany({
      where: { id: question.id, userId: question.userId, runId: question.runId, answer: null },
      data: { answer: input.answer, answeredAt: new Date() },
    })
    if (answered.count !== 1) throw waitNotPending()
    const turnPaused = await tx.agentTurn.updateMany({
      where: { id: input.turn.id, sessionId: input.turn.sessionId, userId: input.turn.userId, status: "in_progress", revision: input.turn.revision },
      data: { status: "waiting_for_user", completedAt: null, revision: { increment: 1 } },
    })
    if (turnPaused.count !== 1) throw waitNotPending()
    const sessionPaused = await tx.agentSession.updateMany({
      where: { id: question.runId, userId: question.userId, status: { notIn: ["aborted", "archived"] } },
      data: { status: "waiting_for_user", completedAt: null },
    })
    if (sessionPaused.count !== 1) throw waitNotPending()
    const queued = await tx.agentExecution.updateMany({
      where: {
        id: execution.id, userId: question.userId, sessionId: question.runId,
        status: execution.status, attemptCount: execution.attemptCount, workerTaskId: execution.workerTaskId,
      },
      data: { status: "queued", workerTaskId: null, error: null, completedAt: null },
    })
    if (queued.count !== 1) throw waitNotPending()
    const intent = await createDispatchIntent(tx, {
      userId: question.userId, sessionId: question.runId, executionId: execution.id,
      attemptCount: execution.attemptCount, questionId: question.id,
    })
    return { ...result, disposition: "legacy_dispatch_accepted", outboxId: intent.id, idempotencyKey: intent.idempotencyKey }
  }
  if (execution.status === "queued" || execution.status === "running") {
    if (question.answer !== input.answer) return null
    if (execution.status === "queued" && execution.workerTaskId === null) {
      // Repair pre-outbox attempts under the same owner locks.
      const intent = await ensureDispatchIntent(tx, {
        userId: question.userId, sessionId: question.runId, executionId: execution.id,
        attemptCount: execution.attemptCount, questionId: question.id,
      })
      if (!intent) return { ...result, disposition: "legacy_dispatch_conflict" }
      return {
        ...result,
        disposition: "legacy_dispatch_pending",
        outboxId: intent.id,
        idempotencyKey: intent.idempotencyKey,
      }
    }
    return {
      ...result,
      disposition: "legacy_already_resuming",
    }
  }
  if (execution.status !== "waiting_for_user" || input.turn.status !== "waiting_for_user") return null
  if (question.answer === null) {
    const answered = await tx.agentRunQuestion.updateMany({
      where: { id: question.id, userId: question.userId, runId: question.runId, answer: null },
      data: { answer: input.answer, answeredAt: new Date() },
    })
    if (answered.count !== 1) throw waitNotPending()
  }

  // Only the transaction that changes waiting_for_user -> queued creates the
  // durable dispatch intent. The Worker relay owns queue publication.
  const claimed = await tx.agentExecution.updateMany({
    where: {
      id: execution.id, userId: question.userId, sessionId: question.runId,
      status: "waiting_for_user", attemptCount: execution.attemptCount,
    },
    data: { status: "queued", workerTaskId: null, error: null, completedAt: null },
  })
  if (claimed.count !== 1) throw waitNotPending()
  const intent = await createDispatchIntent(tx, {
    userId: question.userId, sessionId: question.runId, executionId: execution.id, attemptCount: execution.attemptCount, questionId: question.id,
  })
  return { ...result, disposition: "legacy_dispatch_accepted", outboxId: intent.id, idempotencyKey: intent.idempotencyKey }
}
