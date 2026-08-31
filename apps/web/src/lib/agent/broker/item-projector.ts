import { Prisma } from "@prisma/client"

import { appendAgentEventWithOutboxInTransaction } from "../session/fact-store"
import { waitItemId } from "./item-ids"
import { waitScopeMismatch } from "./errors"
import type { ApprovalWaitProjectionInput, QuestionWaitInput } from "./types"

const ACTIVE_STATUSES = ["queued", "in_progress", "waiting_for_dependency"] as const

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}

export async function projectApprovalWaitInTransaction(
  tx: Prisma.TransactionClient,
  input: ApprovalWaitProjectionInput & { sessionId: string; userId: string },
): Promise<{ itemId: string; turnRevision: number }> {
  const session = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "agent_sessions"
    WHERE "id" = ${input.sessionId} AND "userId" = ${input.userId}
    FOR UPDATE
  `)
  if (!session[0]) throw waitScopeMismatch()
  const turn = await tx.agentTurn.findFirst({
    where: { id: input.turnId, sessionId: input.sessionId, userId: input.userId },
    select: { id: true, status: true, revision: true },
  })
  if (!turn || !ACTIVE_STATUSES.includes(turn.status as typeof ACTIVE_STATUSES[number])) throw waitScopeMismatch()
  if (turn.revision !== input.receiptRevision) throw waitScopeMismatch()

  const itemId = waitItemId("approval", input.approvalId)
  await tx.agentItem.create({
    data: {
      id: itemId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      type: "approval_request",
      status: "started",
      phase: "commentary",
      revision: 0,
      content: json({
        waitKind: "approval",
        approvalId: input.approvalId,
        toolCallId: input.toolCallId,
        action: input.action,
        title: input.title,
        body: input.body,
        impact: input.impact ?? null,
        scopeHash: input.scopeHash,
        receiptRevision: input.receiptRevision,
        expiresAt: input.expiresAt.toISOString(),
        decision: null,
      }),
      startedAt: new Date(),
    },
  })
  const updated = await tx.agentTurn.updateMany({
    where: { id: input.turnId, sessionId: input.sessionId, userId: input.userId, status: turn.status, revision: turn.revision },
    data: { status: "waiting_for_approval", revision: { increment: 1 }, completedAt: null },
  })
  if (updated.count !== 1) throw waitScopeMismatch()
  await appendAgentEventWithOutboxInTransaction(tx, {
    sessionId: input.sessionId,
    turnId: input.turnId,
    itemId,
    taskId: null,
    type: "item.started",
    actor: "orchestrator",
    correlationId: itemId,
    causationId: input.approvalId,
    idempotencyKey: `agent-wait:${itemId}:started`,
    payload: json({ itemId, waitKind: "approval", approvalId: input.approvalId, toolCallId: input.toolCallId }),
    outboxTopic: "agent.session.event",
  })
  return { itemId, turnRevision: turn.revision + 1 }
}

export async function projectQuestionWaitInTransaction(
  tx: Prisma.TransactionClient,
  input: QuestionWaitInput,
): Promise<{ itemId: string; turnRevision: number }> {
  const session = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "agent_sessions"
    WHERE "id" = ${input.sessionId} AND "userId" = ${input.userId}
    FOR UPDATE
  `)
  if (!session[0]) throw waitScopeMismatch()
  const turn = await tx.agentTurn.findFirst({
    where: { id: input.turnId, sessionId: input.sessionId, userId: input.userId },
    select: { id: true, status: true, revision: true },
  })
  if (!turn || !ACTIVE_STATUSES.includes(turn.status as typeof ACTIVE_STATUSES[number])) throw waitScopeMismatch()
  if (turn.revision !== input.expectedTurnRevision) throw waitScopeMismatch()

  const itemId = waitItemId("question", input.questionId)
  await tx.agentItem.create({
    data: {
      id: itemId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      type: "question",
      status: "started",
      phase: "commentary",
      revision: 0,
      content: json({
        waitKind: "question",
        questionId: input.questionId,
        toolCallId: input.toolCallId ?? null,
        stage: input.stage,
        question: input.question,
        options: input.options,
        answer: null,
        answerAvailable: false,
      }),
      startedAt: new Date(),
    },
  })
  const updated = await tx.agentTurn.updateMany({
    where: { id: input.turnId, sessionId: input.sessionId, userId: input.userId, status: turn.status, revision: turn.revision },
    data: { status: "waiting_for_user", revision: { increment: 1 }, completedAt: null },
  })
  if (updated.count !== 1) throw waitScopeMismatch()
  await appendAgentEventWithOutboxInTransaction(tx, {
    sessionId: input.sessionId,
    turnId: input.turnId,
    itemId,
    taskId: null,
    type: "item.started",
    actor: "orchestrator",
    correlationId: itemId,
    causationId: input.questionId,
    idempotencyKey: `agent-wait:${itemId}:started`,
    payload: json({ itemId, waitKind: "question", questionId: input.questionId, toolCallId: input.toolCallId ?? null }),
    outboxTopic: "agent.session.event",
  })
  return { itemId, turnRevision: turn.revision + 1 }
}
