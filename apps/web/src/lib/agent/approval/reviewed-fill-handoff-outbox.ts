import { Prisma, type PrismaClient } from "@prisma/client"
import {
  buildReviewedFillHandoffOutboxData,
  parseReviewedFillHandoffOutboxRow,
  type ReviewedFillHandoffIntent,
} from "@jobcopilot/shared"

import { AgentCommandService } from "../control-plane/commands/agent-command-service"
import { AgentCommandError } from "../control-plane/commands/errors"
import { AutoApplyError } from "@/lib/auto-apply-guards"
import { ReviewedFillHandoffDeferredError } from "./reviewed-fill-handoff"
import { ReviewedFillSourceBindingError, readAcceptedReviewedFillSource } from "./reviewed-fill-source-binding"
import { acknowledgeExistingReviewedFillHandoff, assertReviewedFillLaunchAllowed } from "./reviewed-fill-admission"

type EnqueueClient = Prisma.TransactionClient
type ApprovedRow = {
  id: string; userId: string; sessionId: string; turnId: string | null; taskId: string | null; jobId: string | null
  type: string; status: string; scopeHash: string | null; revision: number; expiresAt: Date | null
  decidedAt: Date | null; payload: unknown
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}

function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
}

function codeOf(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code : undefined
}

/** Called after the exact approval CAS and source-event write, in that same transaction. */
export async function enqueueReviewedFillHandoffInTransaction(
  tx: EnqueueClient,
  input: { approvalId: string; userId: string; sessionId: string; sourceTurnId: string; now: Date },
): Promise<void> {
  const approval = await tx.agentApproval.findFirst({
    where: { id: input.approvalId, userId: input.userId, sessionId: input.sessionId, type: "review_application", status: "approved" },
    select: { id: true, userId: true, sessionId: true, turnId: true, taskId: true, jobId: true, type: true,
      status: true, scopeHash: true, revision: true, expiresAt: true, decidedAt: true, payload: true },
  }) as ApprovedRow | null
  const payload = record(approval?.payload)
  if (!approval || !identity(approval.turnId) || !identity(approval.taskId) || !identity(approval.jobId)
    || approval.expiresAt === null || approval.expiresAt <= input.now || !(approval.decidedAt instanceof Date)
    || approval.decidedAt.getTime() !== input.now.getTime() || payload?.applicationTaskId !== approval.taskId
    || payload.jobId !== approval.jobId || Object.prototype.hasOwnProperty.call(payload, "scheduledGateReview")) {
    throw new ReviewedFillSourceBindingError()
  }
  const accepted = await readAcceptedReviewedFillSource(tx, {
    approvalId: approval.id, userId: approval.userId, sessionId: approval.sessionId,
    applicationTaskId: approval.taskId, jobId: approval.jobId, requestedSourceTurnId: input.sourceTurnId,
  })
  if (!accepted || accepted.sourceTurnId !== input.sourceTurnId) throw new ReviewedFillSourceBindingError()
  const outbox = buildReviewedFillHandoffOutboxData({ userId: approval.userId, sessionId: approval.sessionId,
    applicationTaskId: approval.taskId, approvalId: approval.id, predecessorTurnId: approval.turnId })
  if (!outbox) throw new ReviewedFillSourceBindingError()
  await tx.agentOutbox.create({ data: { ...outbox, payload: outbox.payload as Prisma.InputJsonValue } })
}

export class ReviewedFillHandoffOutboxNotFoundError extends Error {
  constructor() {
    super("Reviewed fill handoff was not found")
    this.name = "ReviewedFillHandoffOutboxNotFoundError"
  }
}

export type ReviewedFillHandoffDispatchStatus = "queued" | "duplicate" | "deferred" | "terminal"

function intentFromRow(row: {
  id: string; topic: string; aggregateId: string; idempotencyKey: string; payload: unknown
}): { id: string; intent: ReviewedFillHandoffIntent } | null {
  const parsed = parseReviewedFillHandoffOutboxRow({
    id: row.id, topic: row.topic, aggregateId: row.aggregateId,
    idempotencyKey: row.idempotencyKey, payload: row.payload,
  })
  return parsed ? { id: parsed.id, intent: parsed.payload } : null
}

/** Consumes only the exact private outbox row; its selected-source event is re-read under command locks. */
export async function processReviewedFillHandoffOutbox(
  db: PrismaClient,
  outboxId: string,
): Promise<ReviewedFillHandoffDispatchStatus> {
  if (!identity(outboxId)) throw new ReviewedFillHandoffOutboxNotFoundError()
  const row = await db.agentOutbox.findUnique({ where: { id: outboxId },
    select: { id: true, topic: true, aggregateId: true, idempotencyKey: true, payload: true, publishedAt: true } })
  if (!row || row.topic !== "agent.reviewed-fill.dispatch") throw new ReviewedFillHandoffOutboxNotFoundError()
  const parsed = intentFromRow(row)
  if (!parsed) return "terminal"
  if (row.publishedAt !== null) return "duplicate"
  try {
    const duplicate = await acknowledgeExistingReviewedFillHandoff(db, parsed.intent, row.idempotencyKey)
    if (duplicate.kind === "duplicate") return "duplicate"
    await assertReviewedFillLaunchAllowed(parsed.intent)
    const result = await new AgentCommandService(db).startApplicationFillForReview({
      userId: parsed.intent.userId, sessionId: parsed.intent.sessionId, applicationTaskId: parsed.intent.applicationTaskId,
      clientMessageId: row.idempotencyKey, reviewedSourceApprovalId: parsed.intent.approvalId,
      reviewedSourcePredecessorTurnId: parsed.intent.predecessorTurnId,
    })
    return result.disposition === "started" ? "queued" : result.disposition === "duplicate" ? "duplicate" : "terminal"
  } catch (error: unknown) {
    const code = codeOf(error)
    if (error instanceof ReviewedFillHandoffDeferredError || code === "reviewed_fill_handoff_deferred"
      || (error instanceof AgentCommandError && error.code === "retry_active_conflict")) return "deferred"
    if (error instanceof ReviewedFillSourceBindingError || error instanceof AgentCommandError || error instanceof AutoApplyError) return "terminal"
    throw error
  }
}
