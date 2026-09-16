import { Prisma, type PrismaClient } from '@prisma/client'
import { appendAgentEventWithOutboxInTransaction } from '@/lib/agent/session/fact-store'

type GmailConnectionRecoveryInput = {
  existingConnectionUserId: string
  currentUserId: string
  googleLoginUserId: string | null | undefined
  transferRequested?: boolean
}

/**
 * A stale Gmail integration can be recovered from a repaired Google login, or
 * moved after the user explicitly requested transfer before OAuth started.
 */
export function canRecoverStaleGmailConnection({
  existingConnectionUserId,
  currentUserId,
  googleLoginUserId,
  transferRequested = false,
}: GmailConnectionRecoveryInput): boolean {
  return transferRequested || (existingConnectionUserId !== currentUserId && googleLoginUserId === currentUserId)
}

/** Mark an OAuth wait complete and enqueue recovery for its original Turn. */
export async function resumeGmailOAuthWait(db: PrismaClient, input: { userId: string; waitId: string }): Promise<boolean> {
  if (!/^[a-f0-9-]{20,100}$/i.test(input.waitId)) return false
  return db.$transaction(async (tx) => {
    const item = await tx.agentItem.findFirst({
      where: { id: `gmail-oauth:${input.waitId}`, session: { userId: input.userId } },
      select: { id: true, sessionId: true, turnId: true, status: true, content: true },
    })
    if (!item || item.status === 'completed') return false
    const content = item.content && typeof item.content === 'object' && !Array.isArray(item.content) ? item.content as Record<string, unknown> : {}
    if (content.oauth !== true || content.waitId !== input.waitId) return false
    const turn = await tx.agentTurn.findFirst({ where: { id: item.turnId, sessionId: item.sessionId, userId: input.userId }, select: { id: true, revision: true, status: true } })
    if (!turn || turn.status !== 'waiting_for_user') return false
    await tx.agentItem.update({ where: { id: item.id }, data: { status: 'completed', completedAt: new Date(), content: { ...content, answerAvailable: true, reconnected: true } as Prisma.InputJsonValue } })
    const reconnected = await appendAgentEventWithOutboxInTransaction(tx, {
      sessionId: item.sessionId, turnId: item.turnId, itemId: item.id, taskId: null,
      type: 'gmail.oauth_reconnected', actor: 'system', correlationId: input.waitId, causationId: item.id,
      idempotencyKey: `gmail-oauth:${input.waitId}:reconnected`, payload: { waitId: input.waitId, itemId: item.id }, outboxTopic: 'agent.session.event',
    })
    const wakeupPayload = {
      waitKind: 'question' as const,
      waitId: input.waitId,
      itemId: item.id,
      turnId: item.turnId,
      toolCallId: typeof content.toolCallId === 'string' ? content.toolCallId : null,
      status: 'answered' as const,
      nextTurnRevision: turn.revision,
    }
    await appendAgentEventWithOutboxInTransaction(tx, {
      sessionId: item.sessionId, turnId: item.turnId, itemId: item.id, taskId: null,
      type: 'turn.wakeup', actor: 'system', correlationId: item.turnId, causationId: reconnected.event.id,
      idempotencyKey: `gmail-oauth:${input.waitId}:wakeup`, payload: wakeupPayload, outboxTopic: 'agent.turn.wakeup',
    })
    return true
  })
}
