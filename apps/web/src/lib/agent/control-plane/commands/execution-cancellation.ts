import type { InputContentPart } from "@jobcopilot/agent-protocol"
import { Prisma } from "@prisma/client"

import { cancelPendingWaitsInTransaction } from "../../broker/interrupt"
import { activeTurnChanged, executionChanged, sessionNotFound } from "./errors"
import {
  acceptInputFacts,
  findActiveTurn,
  findExistingCommand,
  lockOwnedSession,
  type ActiveTurn,
  type CommandTransaction,
} from "./transaction"
import type { InterruptCommand, InterruptResult } from "./types"

export type CancelExecutionCommand = { executionId: string; userId: string; sessionId?: string | null }

const CANCELLABLE_EXECUTION_STATUSES = ["queued", "running", "waiting_for_user", "paused"] as const

function executionInterruptMessageId(executionId: string, turnId: string): string {
  return `agent-execution-cancel:${executionId}:${turnId}`
}

/**
 * Mark the active task tree for the exact cancelled Turn. Running children
 * keep their leases and fencing fields; their heartbeat/finish path observes
 * the durable marker and converges them to interrupted.
 */
async function interruptActiveSubagentTree(
  tx: CommandTransaction,
  scope: { userId: string; sessionId: string; turnId: string; requestedAt: Date },
): Promise<number> {
  return tx.$executeRaw(Prisma.sql`
    UPDATE "sub_agent_tasks" AS task
    SET "interruptRequestedAt" = COALESCE(task."interruptRequestedAt", ${scope.requestedAt}),
        "status" = CASE
          WHEN task."status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN 'interrupted'
          ELSE task."status"
        END,
        "nextAttemptAt" = CASE
          WHEN task."status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN NULL
          ELSE task."nextAttemptAt"
        END,
        "completedAt" = CASE
          WHEN task."status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN ${scope.requestedAt}
          ELSE task."completedAt"
        END,
        "updatedAt" = ${scope.requestedAt}
    WHERE task."sessionId" = ${scope.sessionId}
      AND task."turnId" = ${scope.turnId}
      AND task."status" IN ('queued', 'running', 'retrying', 'waiting', 'waiting_for_user')
      AND EXISTS (
        SELECT 1 FROM "agent_sessions" AS session
        WHERE session."id" = task."sessionId" AND session."userId" = ${scope.userId}
      )
      AND EXISTS (
        SELECT 1 FROM "agent_turns" AS turn
        WHERE turn."id" = task."turnId"
          AND turn."sessionId" = task."sessionId"
          AND turn."userId" = ${scope.userId}
      )
  `)
}

export async function interruptActiveTurn(
  tx: CommandTransaction,
  command: InterruptCommand,
  active: ActiveTurn,
): Promise<InterruptResult> {
  const requestedAt = new Date()
  const interrupted = await tx.agentTurn.updateMany({
    where: { id: active.id, sessionId: command.sessionId, userId: command.userId, status: { in: ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] }, revision: active.revision },
    data: { status: "interrupted", revision: { increment: 1 }, completedAt: requestedAt },
  })
  if (interrupted.count !== 1) throw activeTurnChanged(command.expectedTurnId, active.id)

  await interruptActiveSubagentTree(tx, {
    userId: command.userId,
    sessionId: command.sessionId,
    turnId: active.id,
    requestedAt,
  })

  await cancelPendingWaitsInTransaction(tx, {
    sessionId: command.sessionId,
    userId: command.userId,
    turnId: active.id,
    clientMessageId: command.clientMessageId,
  })

  const content: InputContentPart[] = [{ type: "text", text: "Interrupt requested" }]
  const facts = await acceptInputFacts(tx, command, content, active, "steer", "interrupted", false)
  return { ...facts, disposition: "interrupted" }
}

export async function cancelExecutionInTransaction(
  tx: CommandTransaction,
  command: CancelExecutionCommand,
): Promise<boolean> {
  const execution = await tx.agentExecution.findFirst({
    where: {
      id: command.executionId,
      userId: command.userId,
      ...(command.sessionId ? { sessionId: command.sessionId } : {}),
    },
    select: { id: true, sessionId: true, status: true },
  })
  if (!execution) return false
  await lockOwnedSession(tx, execution.sessionId, command.userId)

  if (execution.status !== "cancelled" && !CANCELLABLE_EXECUTION_STATUSES.includes(execution.status as (typeof CANCELLABLE_EXECUTION_STATUSES)[number])) {
    return false
  }

  const session = await tx.agentSession.findFirst({
    where: { id: execution.sessionId, userId: command.userId },
    select: { source: true },
  })
  if (!session) throw sessionNotFound(execution.sessionId)

  const active = await findActiveTurn(tx, execution.sessionId, command.userId)
  const shouldInterrupt = session.source === "automation" && active?.source === "automation"
  const interruptCommand: InterruptCommand | null = shouldInterrupt && active
    ? {
        sessionId: execution.sessionId,
        userId: command.userId,
        clientMessageId: executionInterruptMessageId(execution.id, active.id),
        source: "automation",
        expectedTurnId: active.id,
        expectedRevision: active.revision,
      }
    : null
  const existing = interruptCommand
    ? await findExistingCommand(tx, execution.sessionId, interruptCommand.clientMessageId)
    : null

  if (execution.status !== "cancelled") {
    const updated = await tx.agentExecution.updateMany({
      where: {
        id: execution.id,
        userId: command.userId,
        sessionId: execution.sessionId,
        status: { in: [...CANCELLABLE_EXECUTION_STATUSES] },
      },
      data: {
        status: "cancelled",
        checkpoint: "cancelled",
        cancelledAt: new Date(),
        completedAt: new Date(),
      },
    })
    if (updated.count !== 1) {
      const current = await tx.agentExecution.findFirst({
        where: { id: execution.id, userId: command.userId, sessionId: execution.sessionId },
        select: { status: true },
      })
      if (current?.status !== "cancelled") throw executionChanged(execution.id)
    }
  }

  if (interruptCommand && !existing && active) await interruptActiveTurn(tx, interruptCommand, active)

  const sessionUpdated = await tx.agentSession.updateMany({
    where: { id: execution.sessionId, userId: command.userId },
    data: { status: "aborted", completedAt: new Date(), memorySummary: "Agent execution cancelled by user." },
  })
  if (sessionUpdated.count !== 1) throw sessionNotFound(execution.sessionId)
  return true
}
