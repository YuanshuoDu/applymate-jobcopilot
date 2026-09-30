import { Prisma } from "@prisma/client"

import { appendAgentEventWithOutboxInTransaction } from "../session/fact-store"
import { cancelUnansweredTurnQuestionsInTransaction } from "../orchestrator-question"

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
  // Capture linked tasks before any receipt is rejected or consumed.
  const turnReceipts = await tx.agentApproval.findMany({
    where: {
      sessionId: input.sessionId,
      userId: input.userId,
      turnId: input.turnId,
      type: { in: ["review_application", "submit_application"] },
      status: { in: ["pending", "approved", "consumed"] },
    },
    select: { id: true, taskId: true, payload: true, type: true, status: true, scopeHash: true, revision: true },
  })
  const reviewReceipts = turnReceipts.filter(receipt => receipt.type === "review_application" && ["pending", "approved"].includes(receipt.status))
  const now = input.now ?? new Date()
  await cancelUnansweredTurnQuestionsInTransaction(tx, input)
  const linkedTaskIds = [...new Set(turnReceipts.flatMap(receipt => {
    const applicationTaskId = record(receipt.payload).applicationTaskId
    return typeof applicationTaskId === "string" ? [applicationTaskId] : []
    }))]
  const stoppedTaskIds = new Set<string>()
  if (linkedTaskIds.length > 0) {
    const preSubmit = [
      { status: "waiting_for_user", checkpoint: { in: ["materials_ready", "form_answer_required", "user_takeover"] } },
      { status: "waiting_for_authorization", checkpoint: { in: ["form_filled", "queue_retry"] } },
      { status: "filling", checkpoint: { in: ["form_fill_queued", "browser_active", "submission_authorized"] } },
    ]
    const linkedTasks = await tx.applicationTask.findMany({
      where: {
        id: { in: linkedTaskIds }, userId: input.userId, sessionId: input.sessionId,
        OR: [...preSubmit, { status: "cancelled", checkpoint: "turn_stopped_before_submit" }],
      },
      select: { id: true },
    })
    for (const task of linkedTasks) stoppedTaskIds.add(task.id)
    await tx.applicationTask.updateMany({
      where: {
        id: { in: linkedTaskIds },
        userId: input.userId,
        sessionId: input.sessionId,
        OR: preSubmit,
      },
      data: { status: "cancelled", checkpoint: "turn_stopped_before_submit", completedAt: now },
    })
  }
  const projectedWaitIds = new Set<string>()
  const items = await tx.agentItem.findMany({
    where: { sessionId: input.sessionId, turnId: input.turnId, type: { in: ["approval_request", "question"] }, status: "started" },
    select: { id: true, type: true, revision: true, content: true },
  })
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
    projectedWaitIds.add(waitId)
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

  const unprojectedReviewReceipts = reviewReceipts.filter(receipt => !projectedWaitIds.has(receipt.id))
  await tx.agentApproval.updateMany({
    where: {
      sessionId: input.sessionId,
      userId: input.userId,
      turnId: input.turnId,
      type: "review_application",
      status: { in: ["pending", "approved"] },
    },
    data: { status: "rejected", decidedAt: now },
  })
  for (const receipt of unprojectedReviewReceipts) {
    await appendAgentEventWithOutboxInTransaction(tx, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      itemId: null,
      taskId: receipt.taskId,
      type: "approval.resolved",
      actor: "system",
      correlationId: receipt.id,
      causationId: input.clientMessageId,
      idempotencyKey: `approval:${receipt.id}:interrupted:${input.clientMessageId}`,
      payload: json({ approvalId: receipt.id, action: receipt.type, scopeHash: receipt.scopeHash ?? "legacy", revision: receipt.revision, outcome: "cancelled", reason: "interrupt" }),
      outboxTopic: "agent.session.event",
    })
  }

  const stoppedSubmitReceipts = turnReceipts.filter(receipt => {
    const taskId = record(receipt.payload).applicationTaskId
    return receipt.type === "submit_application" && ["pending", "approved"].includes(receipt.status)
      && typeof taskId === "string" && stoppedTaskIds.has(taskId)
  })
  if (stoppedSubmitReceipts.length > 0) {
    const receiptIds = stoppedSubmitReceipts.map(receipt => receipt.id)
    await tx.agentApproval.updateMany({
      where: {
        id: { in: receiptIds }, sessionId: input.sessionId, userId: input.userId, turnId: input.turnId,
        type: "submit_application", status: { in: ["pending", "approved"] },
      },
      data: { status: "rejected", decidedAt: now },
    })
    for (const receipt of stoppedSubmitReceipts) {
      if (projectedWaitIds.has(receipt.id)) continue
      await appendAgentEventWithOutboxInTransaction(tx, {
        sessionId: input.sessionId, turnId: input.turnId, itemId: null, taskId: receipt.taskId,
        type: "approval.resolved", actor: "system", correlationId: receipt.id, causationId: input.clientMessageId,
        idempotencyKey: `approval:${receipt.id}:interrupted:${input.clientMessageId}`,
        payload: json({ approvalId: receipt.id, action: receipt.type, scopeHash: receipt.scopeHash ?? "legacy", revision: receipt.revision, outcome: "cancelled", reason: "interrupt" }),
        outboxTopic: "agent.session.event",
      })
    }
  }

  const unprojectedReceipts = await tx.agentApproval.findMany({
    where: { sessionId: input.sessionId, userId: input.userId, turnId: input.turnId, status: "pending", type: { notIn: ["review_application", "submit_application"] } },
    select: { id: true, taskId: true, type: true, scopeHash: true, revision: true },
  })
  await tx.agentApproval.updateMany({
    where: { sessionId: input.sessionId, userId: input.userId, turnId: input.turnId, status: "pending", type: { notIn: ["review_application", "submit_application"] } },
    data: { status: "rejected", decidedAt: now },
  })
  for (const receipt of unprojectedReceipts) {
    await appendAgentEventWithOutboxInTransaction(tx, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      itemId: null,
      taskId: receipt.taskId,
      type: "approval.resolved",
      actor: "system",
      correlationId: receipt.id,
      causationId: input.clientMessageId,
      idempotencyKey: `approval:${receipt.id}:interrupted:${input.clientMessageId}`,
      payload: json({ approvalId: receipt.id, action: receipt.type, scopeHash: receipt.scopeHash ?? "legacy", revision: receipt.revision, outcome: "cancelled", reason: "interrupt" }),
      outboxTopic: "agent.session.event",
    })
  }
}
