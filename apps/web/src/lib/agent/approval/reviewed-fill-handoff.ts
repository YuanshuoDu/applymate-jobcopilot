import { Prisma, type PrismaClient } from "@prisma/client"

import { waitItemId } from "../broker/item-ids"
import type { CommandIdentity, CommandResult } from "../control-plane/commands/types"
import type { CommandTransaction } from "../control-plane/commands/transaction"
import type { ExistingCommand } from "../control-plane/commands/existing-command"
import { AgentCommandError } from "../control-plane/commands/errors"
import {
  matchesReviewedSourceTurn,
  readAcceptedReviewedFillSource,
  ReviewedFillSourceBindingError,
} from "./reviewed-fill-source-binding"

const ACTIVE_TURNS = ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] as const
type HandoffClient = Pick<PrismaClient, "agentApproval" | "agentItem" | "agentTurn" | "applicationTask" | "applicationTaskEvent">
type Approval = {
  id: string; userId: string; sessionId: string; turnId: string | null; taskId: string | null; jobId: string | null
  toolCallId: string | null; type: string; status: string; scopeHash: string | null; revision: number
  expiresAt: Date | null; decidedAt: Date | null; payload: unknown
}

export class ReviewedFillHandoffDeferredError extends Error {
  readonly code = "reviewed_fill_handoff_deferred" as const
  constructor() {
    super("The reviewed fill is waiting for the current Session Turn to finish")
    this.name = "ReviewedFillHandoffDeferredError"
  }
}

export async function existingFillCommandResult(
  tx: CommandTransaction, turnId: string, identity: CommandIdentity, sourceTurnId?: string,
  original?: Pick<ExistingCommand, "id" | "acceptedSequence">,
): Promise<CommandResult> {
  const turn = await tx.agentTurn.findFirst({
    where: { id: turnId, sessionId: identity.sessionId, userId: identity.userId }, select: { id: true, input: true },
  })
  if (!turn) throw new AgentCommandError("retry_target_invalid", "The bound application fill Turn is unavailable", 409)
  if (sourceTurnId && !matchesReviewedSourceTurn(turn.input, sourceTurnId)) throw new ReviewedFillSourceBindingError()
  const input = original ?? await tx.agentInput.findFirst({
    where: { sessionId: identity.sessionId, userId: identity.userId, targetTurnId: turnId },
    orderBy: { createdAt: "asc" }, select: { id: true, acceptedSequence: true },
  })
  if (!input) throw new AgentCommandError("retry_target_invalid", "The bound application fill command is unavailable", 409)
  return { inputId: input.id, turnId, disposition: "duplicate", originalDisposition: "started", sequence: input.acceptedSequence.toString() }
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null ? value as Record<string, unknown> : null
}

function present(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function eligibleApproval(row: Approval, input: { userId: string; sessionId: string; applicationTaskId: string; jobId: string }, now: Date): boolean {
  const payload = record(row.payload)
  return row.userId === input.userId && row.sessionId === input.sessionId && row.type === "review_application"
    && row.status === "approved" && row.expiresAt instanceof Date && row.expiresAt > now && validDate(row.decidedAt)
    && present(row.turnId) && present(row.taskId) && row.taskId === input.applicationTaskId
    && present(row.jobId) && row.jobId === input.jobId && present(row.toolCallId) && present(row.scopeHash)
    && payload?.applicationTaskId === row.taskId && payload.jobId === row.jobId
    && !Object.prototype.hasOwnProperty.call(payload, "scheduledGateReview")
}

function waitMatches(contentValue: unknown, row: Approval, approved: boolean, revision: number): boolean {
  const content = record(contentValue)
  return content?.waitKind === "approval" && content.approvalId === row.id
    && content.toolCallId === row.toolCallId && content.action === "review_application"
    && content.scopeHash === row.scopeHash && content.receiptRevision === row.revision
    && row.expiresAt instanceof Date && content.expiresAt === row.expiresAt.toISOString()
    && revision === (approved ? 1 : 0)
    && (approved ? content.decision === "approved" && content.responseAvailable === true
      && validDate(row.decidedAt) && content.respondedAt === row.decidedAt.toISOString()
      : content.decision === null && content.responseAvailable === undefined)
}

/** Proves the selector accompanies the exact active, user-owned canonical approval Wait before CAS. */
export async function assertReviewedFillDecisionWait(
  tx: Prisma.TransactionClient,
  input: { approvalId: string; userId: string; sessionId: string; decision: string; now: Date },
): Promise<void> {
  if (input.decision !== "approved") throw new ReviewedFillSourceBindingError()
  const row = await tx.agentApproval.findFirst({
    where: { id: input.approvalId, userId: input.userId, sessionId: input.sessionId, type: "review_application", status: "pending" },
    select: { id: true, userId: true, sessionId: true, turnId: true, taskId: true, jobId: true, toolCallId: true,
      type: true, status: true, scopeHash: true, revision: true, expiresAt: true, decidedAt: true, payload: true },
  }) as Approval | null
  if (!row || !eligiblePendingApproval(row, input) || !row.taskId || !row.jobId || !row.turnId) {
    throw new ReviewedFillSourceBindingError()
  }
  const task = await tx.applicationTask.findFirst({
    where: { id: row.taskId, userId: input.userId, sessionId: input.sessionId, jobId: row.jobId,
      status: "waiting_for_user", checkpoint: "materials_ready" }, select: { id: true },
  })
  const turn = await tx.agentTurn.findFirst({
    where: { id: row.turnId, userId: input.userId, sessionId: input.sessionId },
    select: { id: true, source: true, status: true, revision: true },
  })
  const item = await tx.agentItem.findFirst({
    where: { id: waitItemId("approval", row.id), sessionId: input.sessionId,
      turnId: row.turnId, type: "approval_request", status: "started" }, select: { id: true, revision: true, content: true },
  })
  if (!task || !turn || turn.source !== "user" || turn.status !== "waiting_for_approval"
    || turn.revision !== row.revision + 1 || !item || !waitMatches(item.content, row, false, item.revision)) {
    throw new ReviewedFillSourceBindingError()
  }
}

function eligiblePendingApproval(row: Approval, input: { userId: string; sessionId: string; now: Date }): boolean {
  const payload = record(row.payload)
  return row.userId === input.userId && row.sessionId === input.sessionId && row.status === "pending"
    && row.type === "review_application" && row.expiresAt instanceof Date && row.expiresAt > input.now && row.decidedAt === null
    && present(row.turnId) && present(row.taskId) && present(row.jobId) && present(row.toolCallId)
    && present(row.scopeHash) && payload?.applicationTaskId === row.taskId && payload.jobId === row.jobId
    && !Object.prototype.hasOwnProperty.call(payload, "scheduledGateReview")
}

/** Revalidates the accepted decision under Session and ApplicationTask locks before starting or acknowledging its fill. */
export async function validateReviewedFillHandoff(
  tx: HandoffClient,
  input: { approvalId: string; userId: string; sessionId: string; applicationTaskId: string; sourceTurnId?: string;
    predecessorTurnId?: string; clientMessageId: string; now?: Date },
): Promise<{ sourceTurnId: string }> {
  const now = input.now ?? new Date()
  const approval = await tx.agentApproval.findFirst({
    where: { id: input.approvalId, userId: input.userId, sessionId: input.sessionId, type: "review_application", status: "approved" },
    select: { id: true, userId: true, sessionId: true, turnId: true, taskId: true, jobId: true, toolCallId: true,
      type: true, status: true, scopeHash: true, revision: true, expiresAt: true, decidedAt: true, payload: true },
  }) as Approval | null
  const jobId = approval?.jobId
  if (!approval || !present(jobId) || !eligibleApproval(approval, { ...input, jobId }, now)) throw new ReviewedFillSourceBindingError()
  if (input.predecessorTurnId && approval.turnId !== input.predecessorTurnId) throw new ReviewedFillSourceBindingError()
  const task = await tx.applicationTask.findFirst({
    where: { id: input.applicationTaskId, userId: input.userId, sessionId: input.sessionId, jobId },
    select: { id: true, status: true, checkpoint: true, fillTurnId: true, fillTurnSessionId: true, fillTurnUserId: true },
  })
  if (!task || task.id !== approval.taskId) throw new ReviewedFillSourceBindingError()
  const binding = await readAcceptedReviewedFillSource(tx, {
    approvalId: approval.id, userId: input.userId, sessionId: input.sessionId,
    applicationTaskId: input.applicationTaskId, jobId,
    ...(input.sourceTurnId ? { requestedSourceTurnId: input.sourceTurnId } : {}),
  })
  if (!binding || (input.sourceTurnId && binding.sourceTurnId !== input.sourceTurnId)) throw new ReviewedFillSourceBindingError()
  const predecessor = await tx.agentTurn.findFirst({
    where: { id: approval.turnId!, userId: input.userId, sessionId: input.sessionId },
    select: { id: true, source: true, status: true, rootTaskId: true },
  })
  const wait = await tx.agentItem.findFirst({
    where: { id: waitItemId("approval", approval.id), sessionId: input.sessionId,
      turnId: approval.turnId!, type: "approval_request", status: "completed" }, select: { content: true, revision: true },
  })
  if (!predecessor || predecessor.source !== "user" || !present(predecessor.rootTaskId)
    || !wait || !waitMatches(wait.content, approval, true, wait.revision)) throw new ReviewedFillSourceBindingError()
  if (predecessor.status !== "completed") {
    if (ACTIVE_TURNS.some(status => status === predecessor.status)) throw new ReviewedFillHandoffDeferredError()
    throw new ReviewedFillSourceBindingError()
  }
  const hasFill = present(task.fillTurnId)
  if (hasFill) {
    const fillTurn = await tx.agentTurn.findFirst({
      where: { id: task.fillTurnId!, userId: input.userId, sessionId: input.sessionId }, select: { input: true },
    })
    if (task.fillTurnSessionId !== input.sessionId || task.fillTurnUserId !== input.userId
      || !["filling", "waiting_for_user", "waiting_for_authorization", "completed"].includes(task.status)
      || !matchesReviewedSourceTurn(fillTurn?.input, binding.sourceTurnId)
      || record(fillTurn?.input)?.clientMessageId !== input.clientMessageId) throw new ReviewedFillSourceBindingError()
    return { sourceTurnId: binding.sourceTurnId }
  } else if (task.status !== "waiting_for_user" || task.checkpoint !== "materials_ready") {
    throw new ReviewedFillSourceBindingError()
  }
  const active = await tx.agentTurn.findMany({
    where: { userId: input.userId, sessionId: input.sessionId, status: { in: [...ACTIVE_TURNS] } }, select: { id: true },
  })
  if (active.length > 0) throw new ReviewedFillHandoffDeferredError()
  return { sourceTurnId: binding.sourceTurnId }
}
