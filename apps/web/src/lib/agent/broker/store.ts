import { Prisma, PrismaClient } from "@prisma/client"

import { appendAgentEventWithOutboxInTransaction } from "../session/fact-store"
import { projectQuestionWaitInTransaction } from "./item-projector"
import { waitItemId } from "./item-ids"
import { resolvePendingApprovalInTransaction } from "../approval/decision"
import { ApprovalStoreError } from "../approval/types"
import {
  AgentWaitError,
  invalidAnswer,
  invalidWaitCommand,
  waitExpired,
  waitNotFound,
  waitNotPending,
  waitRevisionMismatch,
  waitScopeMismatch,
} from "./errors"
import type {
  ApprovalDecisionInput,
  QuestionAnswerInput,
  QuestionWaitInput,
  WaitCommandResult,
} from "./types"

type Tx = Prisma.TransactionClient
type JsonRecord = Record<string, unknown>

const WAITING_STATUSES = new Set(["waiting_for_approval", "waiting_for_user"])

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}
}

function commandKey(clientMessageId: string): string {
  return `agent-wait-command:${clientMessageId}`
}

async function lockSession(tx: Tx, sessionId: string, userId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "agent_sessions"
    WHERE "id" = ${sessionId} AND "userId" = ${userId}
    FOR UPDATE
  `)
  if (!rows[0]) throw waitNotFound()
}

async function duplicateResult(tx: Tx, key: string): Promise<WaitCommandResult | null> {
  const event = await tx.agentEvent.findFirst({
    where: { idempotencyKey: key },
    select: { sequence: true, payload: true },
  })
  if (!event) return null
  const payload = record(event.payload)
  const kind = payload.waitKind === "approval" || payload.waitKind === "question" ? payload.waitKind : null
  const waitId = typeof payload.waitId === "string" ? payload.waitId : null
  const itemId = typeof payload.itemId === "string" ? payload.itemId : null
  const turnId = typeof payload.turnId === "string" ? payload.turnId : null
  if (!kind || !waitId || !itemId || !turnId) throw new AgentWaitError("wait_not_pending", "The previous wait command has incomplete state", 409)
  return {
    waitKind: kind,
    waitId,
    itemId,
    turnId,
    toolCallId: typeof payload.toolCallId === "string" ? payload.toolCallId : null,
    disposition: "duplicate",
    status: payload.status === "answered" ? "answered" : payload.status === "rejected" ? "rejected" : "approved",
    nextTurnRevision: typeof payload.nextTurnRevision === "number" ? payload.nextTurnRevision : 0,
    sequence: event.sequence.toString(),
  }
}

async function activeWait(
  tx: Tx,
  input: { sessionId: string; userId: string; itemId: string; expectedTurnId: string; expectedRevision: number },
  kind: "approval" | "question",
) {
  const turn = await tx.agentTurn.findFirst({
    where: { id: input.expectedTurnId, sessionId: input.sessionId, userId: input.userId },
    select: { id: true, status: true, revision: true },
  })
  if (!turn || !WAITING_STATUSES.has(turn.status)) throw waitNotFound()
  if (turn.revision !== input.expectedRevision) throw waitRevisionMismatch(input.expectedRevision, turn.revision)
  const expectedStatus = kind === "approval" ? "waiting_for_approval" : "waiting_for_user"
  if (turn.status !== expectedStatus) throw waitScopeMismatch()
  const item = await tx.agentItem.findFirst({
    where: { id: input.itemId, sessionId: input.sessionId, turnId: turn.id, type: kind === "approval" ? "approval_request" : "question" },
    select: { id: true, status: true, revision: true, content: true },
  })
  if (!item) throw waitNotFound()
  if (item.status !== "started") throw waitNotPending()
  return { turn, item }
}

async function finishWait(
  tx: Tx,
  input: {
    sessionId: string
    userId: string
    waitKind: "approval" | "question"
    waitId: string
    itemId: string
    turnId: string
    itemRevision: number
    turnRevision: number
    toolCallId: string | null
    status: "approved" | "rejected" | "answered"
    itemContent: JsonRecord
    clientMessageId: string
  },
): Promise<WaitCommandResult> {
  const nextTurnRevision = input.turnRevision + 1
  const item = await tx.agentItem.updateMany({
    where: { id: input.itemId, sessionId: input.sessionId, turnId: input.turnId, status: "started", revision: input.itemRevision },
    data: { status: "completed", revision: { increment: 1 }, content: json(input.itemContent), completedAt: new Date() },
  })
  if (item.count !== 1) throw waitNotPending()
  const turn = await tx.agentTurn.updateMany({
    where: { id: input.turnId, sessionId: input.sessionId, userId: input.userId, status: input.waitKind === "approval" ? "waiting_for_approval" : "waiting_for_user", revision: input.turnRevision },
    data: { revision: { increment: 1 } },
  })
  if (turn.count !== 1) throw waitRevisionMismatch(input.turnRevision, input.turnRevision + 1)

  const payload = {
    waitKind: input.waitKind,
    waitId: input.waitId,
    itemId: input.itemId,
    turnId: input.turnId,
    toolCallId: input.toolCallId,
    status: input.status,
    nextTurnRevision,
    answerAvailable: input.status === "answered",
  }
  const accepted = await appendAgentEventWithOutboxInTransaction(tx, {
    sessionId: input.sessionId,
    turnId: input.turnId,
    itemId: input.itemId,
    taskId: null,
    type: input.waitKind === "approval" ? "approval.resolved" : "question.answered",
    actor: "user",
    correlationId: input.waitId,
    causationId: input.itemId,
    idempotencyKey: commandKey(input.clientMessageId),
    payload: json(payload),
    outboxTopic: "agent.session.event",
  })
  await appendAgentEventWithOutboxInTransaction(tx, {
    sessionId: input.sessionId,
    turnId: input.turnId,
    itemId: input.itemId,
    taskId: null,
    type: "turn.wakeup",
    actor: "user",
    correlationId: input.turnId,
    causationId: accepted.event.id,
    idempotencyKey: `${commandKey(input.clientMessageId)}:wakeup`,
    payload: json(payload),
    outboxTopic: "agent.turn.wakeup",
  })
  return {
    waitKind: input.waitKind,
    waitId: input.waitId,
    itemId: input.itemId,
    turnId: input.turnId,
    toolCallId: input.toolCallId,
    disposition: "resolved",
    status: input.status,
    nextTurnRevision,
    sequence: accepted.event.sequence.toString(),
  }
}

export async function createQuestionWait(db: PrismaClient, input: QuestionWaitInput) {
  if (!input.questionId.trim() || !input.stage.trim() || !input.question.trim()) throw invalidWaitCommand("Question wait fields are required")
  return db.$transaction(async (tx) => {
    await lockSession(tx, input.sessionId, input.userId)
    return projectQuestionWaitInTransaction(tx, input)
  })
}

export async function decideApproval(db: PrismaClient, input: ApprovalDecisionInput): Promise<WaitCommandResult> {
  return db.$transaction(async (tx) => {
    await lockSession(tx, input.sessionId, input.userId)
    const duplicate = await duplicateResult(tx, commandKey(input.clientMessageId))
    if (duplicate) return duplicate
    const itemId = waitItemId("approval", input.waitId)
    const { turn, item } = await activeWait(tx, { ...input, itemId }, "approval")
    if (item.id !== itemId) throw waitScopeMismatch()
    const now = input.now ?? new Date()
    let approval
    try {
      approval = await resolvePendingApprovalInTransaction(tx, {
        id: input.waitId, userId: input.userId, sessionId: input.sessionId, decision: input.decision, now,
      })
    } catch (error) {
      if (error instanceof ApprovalStoreError) {
        if (error.code === "approval_expired") throw waitExpired()
        if (error.code === "approval_not_found") throw waitNotFound()
        if (error.code === "approval_not_approved" || error.code === "approval_already_consumed") throw waitNotPending()
        throw waitScopeMismatch()
      }
      throw error
    }
    if (approval.turnId !== turn.id) throw waitScopeMismatch()
    const content = record(item.content)
    if (content.approvalId !== approval.id || content.toolCallId !== (approval.toolCallId ?? null) || content.scopeHash !== approval.scopeHash) throw waitScopeMismatch()
    return finishWait(tx, {
      sessionId: input.sessionId, userId: input.userId, waitKind: "approval", waitId: input.waitId, itemId, turnId: turn.id,
      itemRevision: item.revision, turnRevision: turn.revision, toolCallId: approval.toolCallId,
      status: input.decision, itemContent: { ...content, decision: input.decision, responseAvailable: true, respondedAt: now.toISOString() },
      clientMessageId: input.clientMessageId,
    })
  })
}

export async function answerQuestion(db: PrismaClient, input: QuestionAnswerInput): Promise<WaitCommandResult> {
  const answer = input.answer.trim()
  if (!answer || answer.length > 20_000) throw invalidAnswer("Answer must contain between 1 and 20,000 characters")
  return db.$transaction(async (tx) => {
    await lockSession(tx, input.sessionId, input.userId)
    const duplicate = await duplicateResult(tx, commandKey(input.clientMessageId))
    if (duplicate) return duplicate
    const itemId = waitItemId("question", input.waitId)
    const { turn, item } = await activeWait(tx, { ...input, itemId }, "question")
    const content = record(item.content)
    if (content.questionId !== input.waitId) throw waitScopeMismatch()
    const options = Array.isArray(content.options) ? content.options : []
    const values = options.flatMap((option) => {
      const row = record(option)
      return typeof row.value === "string" ? [row.value] : []
    })
    if (values.length > 0 && !values.includes(answer)) throw invalidAnswer("Answer is not one of the offered options")
    const toolCallId = typeof content.toolCallId === "string" ? content.toolCallId : null
    return finishWait(tx, {
      sessionId: input.sessionId, userId: input.userId, waitKind: "question", waitId: input.waitId, itemId, turnId: turn.id,
      itemRevision: item.revision, turnRevision: turn.revision, toolCallId, status: "answered",
      itemContent: { ...content, answer, answerAvailable: true, answeredAt: (input.now ?? new Date()).toISOString() },
      clientMessageId: input.clientMessageId,
    })
  })
}
