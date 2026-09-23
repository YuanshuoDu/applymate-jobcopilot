import { Prisma, PrismaClient } from "@prisma/client"

import { classifyLegacyQuestionBridge, type LegacyQuestionBridgeItem } from "../legacy-question-bridge"
import { appendAgentEventWithOutboxInTransaction } from "../session/fact-store"
import { invalidAnswer, waitNotPending, waitRevisionMismatch, waitScopeMismatch, type AgentWaitError } from "./errors"
import { waitItemId } from "./item-ids"

type Tx = Prisma.TransactionClient
type JsonRecord = Record<string, unknown>

const ACTIVE_TURN_STATUSES = ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] as const

export interface LegacyQuestionAnswerInput {
  questionId: string
  userId: string
  answer: string
  now?: Date
  clientMessageId?: string
}

export type LegacyQuestionAnswerResult =
  | { disposition: "bridged" | "duplicate"; questionId: string; sessionId: string; turnId: string; itemId: string; nextTurnRevision: number; sequence: string }
  | { disposition: "legacy_only"; reason: "question_not_found" | "session_unmapped" | "no_active_turn" | "turn_not_waiting" }
  | { disposition: "bridge_pending"; reason: "active_turn_ambiguous" | "canonical_item_missing" | "provenance_missing" }

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}
}

function commandKey(clientMessageId: string): string {
  return `agent-wait-command:${clientMessageId}`
}

function normalizedClientMessageId(input: LegacyQuestionAnswerInput): string {
  const candidate = input.clientMessageId?.trim()
  return candidate || `legacy-question:${input.questionId}`
}

async function lockSession(tx: Tx, sessionId: string, userId: string): Promise<{ id: string; userId: string } | null> {
  const rows = await tx.$queryRaw<Array<{ id: string; userId: string }>>(Prisma.sql`
    SELECT "id", "userId" FROM "agent_sessions"
    WHERE "id" = ${sessionId} AND "userId" = ${userId}
    FOR UPDATE
  `)
  return rows[0] ?? null
}

function invalidAnswerError(message: string): AgentWaitError {
  return invalidAnswer(message)
}

function optionValues(options: unknown): string[] {
  if (!Array.isArray(options)) return []
  return options.flatMap(option => {
    const value = record(option).value
    return typeof value === "string" ? [value] : []
  })
}

async function duplicateResult(tx: Tx, key: string, sessionId: string, questionId: string): Promise<LegacyQuestionAnswerResult | null> {
  const event = await tx.agentEvent.findFirst({ where: { sessionId, idempotencyKey: key }, select: { sequence: true, payload: true } })
  if (!event) return null
  const payload = record(event.payload)
  if (payload.waitKind !== "question" || typeof payload.waitId !== "string" || typeof payload.itemId !== "string" || typeof payload.turnId !== "string" || typeof payload.nextTurnRevision !== "number") {
    throw waitScopeMismatch()
  }
  if (payload.waitId !== questionId || payload.sessionId !== sessionId) throw waitScopeMismatch()
  return {
    disposition: "duplicate",
    questionId: payload.waitId,
    sessionId: typeof payload.sessionId === "string" ? payload.sessionId : "",
    turnId: payload.turnId,
    itemId: payload.itemId,
    nextTurnRevision: payload.nextTurnRevision,
    sequence: event.sequence.toString(),
  }
}

export async function answerLegacyQuestion(
  db: PrismaClient,
  input: LegacyQuestionAnswerInput,
): Promise<LegacyQuestionAnswerResult> {
  const answer = input.answer.trim()
  if (!answer || answer.length > 20_000) throw invalidAnswerError("Answer must contain between 1 and 20,000 characters")
  const clientMessageId = normalizedClientMessageId(input)
  const key = commandKey(clientMessageId)

  return db.$transaction(async (tx) => {
    const initial = await tx.agentRunQuestion.findFirst({
      where: { id: input.questionId, userId: input.userId },
      select: { id: true, userId: true, runId: true, stage: true, question: true, options: true, answer: true },
    })
    if (!initial) return { disposition: "legacy_only", reason: "question_not_found" }
    const session = await lockSession(tx, initial.runId, input.userId)
    if (!session) return { disposition: "legacy_only", reason: "session_unmapped" }
    const question = await tx.agentRunQuestion.findFirst({
      where: { id: input.questionId, userId: input.userId, runId: session.id },
      select: { id: true, userId: true, runId: true, stage: true, question: true, options: true, answer: true },
    })
    if (!question) return { disposition: "legacy_only", reason: "session_unmapped" }

    const duplicate = await duplicateResult(tx, key, session.id, question.id)
    if (duplicate) return duplicate
    if (question.answer !== null) throw waitNotPending()

    const turns = await tx.agentTurn.findMany({
      where: { sessionId: session.id, userId: input.userId, status: { in: [...ACTIVE_TURN_STATUSES] } },
      orderBy: { createdAt: "asc" },
      take: 2,
      select: { id: true, sessionId: true, userId: true, status: true, revision: true },
    })
    if (turns.length === 0) return { disposition: "legacy_only", reason: "no_active_turn" }
    if (turns.length > 1) return { disposition: "bridge_pending", reason: "active_turn_ambiguous" }
    const turn = turns[0]
    if (turn.status !== "waiting_for_user") return { disposition: "legacy_only", reason: "turn_not_waiting" }

    const itemId = waitItemId("question", question.id)
    const item = await tx.agentItem.findFirst({
      where: { id: itemId },
      select: { id: true, sessionId: true, turnId: true, type: true, status: true, revision: true, content: true },
    }) as (LegacyQuestionBridgeItem & { revision: number }) | null
    if (!item) return { disposition: "bridge_pending", reason: "canonical_item_missing" }
    const content = record(item.content)
    const provenance = content.sourceEvent === undefined && content.sourcePayload === undefined
      ? null
      : { sourceEvent: content.sourceEvent, sourcePayload: content.sourcePayload }
    const proof = classifyLegacyQuestionBridge({
      question: { id: question.id, userId: question.userId, runId: question.runId, stage: question.stage, question: question.question, options: question.options },
      userId: input.userId,
      session,
      activeTurns: [turn],
      item,
      provenance,
    })
    if (proof.disposition === "bridge_pending") {
      if (proof.reason === "session_missing") return { disposition: "legacy_only", reason: "session_unmapped" }
      if (proof.reason === "active_turn_missing") return { disposition: "legacy_only", reason: "no_active_turn" }
      if (proof.reason === "active_turn_ambiguous" || proof.reason === "canonical_item_missing" || proof.reason === "provenance_missing") {
        return { disposition: "bridge_pending", reason: proof.reason }
      }
      return { disposition: "legacy_only", reason: "session_unmapped" }
    }
    if (proof.disposition !== "bridged") throw waitScopeMismatch()

    const values = optionValues(question.options)
    if (values.length > 0 && !values.includes(answer)) throw invalidAnswerError("Answer is not one of the offered options")
    const now = input.now ?? new Date()
    const payload = {
      waitKind: "question",
      waitId: question.id,
      sessionId: session.id,
      itemId: proof.itemId,
      turnId: turn.id,
      toolCallId: typeof content.toolCallId === "string" ? content.toolCallId : null,
      status: "answered",
      nextTurnRevision: turn.revision + 1,
      answerAvailable: true,
    }
    const answered = await tx.agentRunQuestion.updateMany({
      where: { id: question.id, userId: input.userId, runId: session.id, answer: null },
      data: { answer, answeredAt: now },
    })
    if (answered.count !== 1) throw waitNotPending()
    const itemUpdated = await tx.agentItem.updateMany({
      where: { id: proof.itemId, sessionId: session.id, turnId: turn.id, type: "question", status: "started", revision: item.revision },
      data: { status: "completed", revision: { increment: 1 }, content: json({ ...content, answer, answerAvailable: true, answeredAt: now.toISOString() }), completedAt: now },
    })
    if (itemUpdated.count !== 1) throw waitNotPending()
    const turnUpdated = await tx.agentTurn.updateMany({
      where: { id: turn.id, sessionId: session.id, userId: input.userId, status: "waiting_for_user", revision: turn.revision },
      data: { revision: { increment: 1 } },
    })
    if (turnUpdated.count !== 1) throw waitRevisionMismatch(turn.revision, turn.revision + 1)

    const accepted = await appendAgentEventWithOutboxInTransaction(tx, {
      sessionId: session.id, turnId: turn.id, itemId: proof.itemId, taskId: null,
      type: "question.answered", actor: "user", correlationId: question.id, causationId: proof.itemId,
      idempotencyKey: key, payload: json(payload), outboxTopic: "agent.session.event",
    })
    await appendAgentEventWithOutboxInTransaction(tx, {
      sessionId: session.id, turnId: turn.id, itemId: proof.itemId, taskId: null,
      type: "turn.wakeup", actor: "user", correlationId: turn.id, causationId: accepted.event.id,
      idempotencyKey: `${key}:wakeup`, payload: json(payload), outboxTopic: "agent.turn.wakeup",
    })
    return { disposition: "bridged", questionId: question.id, sessionId: session.id, turnId: turn.id, itemId: proof.itemId, nextTurnRevision: turn.revision + 1, sequence: accepted.event.sequence.toString() }
  })
}
