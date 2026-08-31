import { Prisma } from "@prisma/client"

import { appendAgentEventWithOutboxInTransaction } from "../session/fact-store"

type Tx = Prisma.TransactionClient

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Cancels every pending approval/question owned by an interrupted Turn. */
export async function cancelPendingWaitsInTransaction(
  tx: Tx,
  input: { sessionId: string; userId: string; turnId: string; clientMessageId: string; now?: Date },
): Promise<void> {
  const items = await tx.agentItem.findMany({
    where: { sessionId: input.sessionId, turnId: input.turnId, type: { in: ["approval_request", "question"] }, status: "started" },
    select: { id: true, type: true, revision: true, content: true },
  })
  const now = input.now ?? new Date()
  for (const item of items) {
    const content = record(item.content)
    const waitKind = item.type === "approval_request" ? "approval" : "question"
    const waitId = typeof content.approvalId === "string" ? content.approvalId : typeof content.questionId === "string" ? content.questionId : null
    if (!waitId) continue
    const updated = await tx.agentItem.updateMany({
      where: { id: item.id, sessionId: input.sessionId, turnId: input.turnId, status: "started", revision: item.revision },
      data: { status: "interrupted", revision: { increment: 1 }, content: json({ ...content, cancelled: true, cancellationReason: "interrupt" }), completedAt: now },
    })
    if (updated.count !== 1) continue
    if (waitKind === "approval") {
      await tx.agentApproval.updateMany({
        where: { id: waitId, sessionId: input.sessionId, userId: input.userId, turnId: input.turnId, status: "pending" },
        data: { status: "rejected", decidedAt: now },
      })
    }
    await appendAgentEventWithOutboxInTransaction(tx, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      itemId: item.id,
      taskId: null,
      type: waitKind === "approval" ? "approval.resolved" : "question.cancelled",
      actor: "system",
      correlationId: waitId,
      causationId: input.clientMessageId,
      idempotencyKey: `agent-wait:${item.id}:cancelled:${input.clientMessageId}`,
      payload: json({
        waitKind,
        waitId,
        itemId: item.id,
        toolCallId: typeof content.toolCallId === "string" ? content.toolCallId : null,
        outcome: "cancelled",
        reason: "interrupt",
      }),
      outboxTopic: "agent.session.event",
    })
  }
}
