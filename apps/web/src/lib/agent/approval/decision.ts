import { Prisma } from "@prisma/client"

import { ACTIVE_TURN_STATUSES } from "../control-plane/commands/transaction"
import { assertNotObjectiveApprovalSetMember } from "./objective-approval-set-member-guard"
import { ApprovalStoreError, type ApprovalDecision } from "./types"
import { assertReviewedFillDecisionWait } from "./reviewed-fill-handoff"
import { persistReviewedFillSourceInTransaction } from "./reviewed-fill-source-binding"
import { enqueueReviewedFillHandoffInTransaction } from "./reviewed-fill-handoff-outbox"
import { acquireSourceMaterialFence } from "../source-material-fence"
import { readReviewedApplicationReviewDecision } from "./reviewed-application-review-decision"

type Tx = Prisma.TransactionClient

export interface PendingApprovalDecisionInput {
  id: string
  userId: string
  sessionId: string
  decision: ApprovalDecision
  now: Date
  reviewedSourceTurnId?: string
  reviewedApplicationDecision?: ReviewedApplicationDecisionVerification
}

export type ReviewedApplicationDecisionVerification = Readonly<{
  approvalId: string; turnId: string; decision: ApprovalDecision
  status: "reviewed_approved" | "reviewed_rejected"; sourceTurnId?: string
}>

export async function reviewedApplicationDecisionFields(
  tx: Tx, input: { userId: string; sessionId: string; approvalId: string; turnId: string; decision: ApprovalDecision; now: Date; receiptNonce?: string; requestedSourceTurnId?: string },
): Promise<Pick<PendingApprovalDecisionInput, "reviewedSourceTurnId" | "reviewedApplicationDecision">> {
  const { turnId, ...reviewInput } = input
  const reviewed = await readReviewedApplicationReviewDecision(tx, reviewInput)
  if (reviewed.status === "unavailable") throw new ApprovalStoreError("approval_scope_mismatch", "Reviewed application decision is unavailable")
  if (reviewed.status === "legacy") return input.requestedSourceTurnId === undefined ? {} : { reviewedSourceTurnId: input.requestedSourceTurnId }
  const status = reviewed.status
  const sourceTurnId = status === "reviewed_approved" ? reviewed.sourceTurnId : undefined
  return {
    ...(sourceTurnId ? { reviewedSourceTurnId: sourceTurnId } : {}),
    reviewedApplicationDecision: { approvalId: input.approvalId, turnId: input.turnId, decision: input.decision, status,
      ...(sourceTurnId ? { sourceTurnId } : {}) },
  }
}

export interface ResolvedApprovalRow {
  id: string
  sessionId: string
  taskId: string | null
  userId: string
  turnId: string
  toolCallId: string | null
  type: string
  status: string
  scopeHash: string | null
  revision: number
  expiresAt: Date | null
}

interface ApprovalFreshnessRow {
  id: string
  sessionId: string
  turnId: string
  userId: string
}

/** The canonical reviewed path takes the #1159 fence before owner Session, Turn, then ApplicationTask. */
export async function lockReviewedApprovalOwnersInTransaction(
  tx: Tx, scope: { approvalId: string; userId: string; sessionId: string; turnId: string },
): Promise<boolean> {
  const approval = await tx.agentApproval.findFirst({ where: { id: scope.approvalId, userId: scope.userId, sessionId: scope.sessionId },
    select: { id: true, sessionId: true, userId: true, turnId: true, type: true, taskId: true, toolCallId: true } })
  if (!approval || !await hasReviewedApplicationSignal(tx, approval, approval.turnId ?? scope.turnId)) return false
  await acquireSourceMaterialFence(tx, [scope.userId])
  const session = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "agent_sessions" WHERE "id"=${scope.sessionId} AND "userId"=${scope.userId} FOR UPDATE
  `)
  if (!session[0]) throw new ApprovalStoreError("approval_not_found", "Approval session is no longer available")
  const turn = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "agent_turns" WHERE "id"=${scope.turnId} AND "sessionId"=${scope.sessionId}
      AND "userId"=${scope.userId} FOR UPDATE
  `)
  if (!turn[0]) throw new ApprovalStoreError("approval_scope_mismatch", "Approval turn is no longer available")
  if (approval.taskId) {
    await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "application_tasks" WHERE "id"=${approval.taskId} AND "userId"=${scope.userId}
        AND "sessionId"=${scope.sessionId} FOR UPDATE
    `)
  }
  return true
}

export async function assertApprovalTurnActiveInTransaction(
  tx: Tx,
  scope: { userId: string; sessionId: string; turnId: string },
  inactiveMessage = "Approval turn is no longer active",
): Promise<void> {
  const turn = await tx.agentTurn.findFirst({
    where: { id: scope.turnId, sessionId: scope.sessionId, userId: scope.userId },
    select: { id: true, status: true },
  })
  if (!turn || !ACTIVE_TURN_STATUSES.some((status) => status === turn.status)) {
    throw new ApprovalStoreError("approval_scope_mismatch", inactiveMessage)
  }
}

/**
 * Serializes the decision with session-scoped event writes, then checks the
 * durable request lineage and goal-revision events before the approval mutates.
 * Event sequence is session-global, so a later goal revision is stale
 * even when it belongs to a different Turn in the same session.
 */
export async function assertApprovalFreshnessInTransaction(tx: Tx, row: ApprovalFreshnessRow): Promise<void> {
  const session = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "agent_sessions"
    WHERE "id" = ${row.sessionId}
      AND "status" NOT IN ('aborted', 'archived')
    FOR UPDATE
  `)
  if (!session[0]) throw new ApprovalStoreError("approval_not_found", "Approval session is no longer available")
  await assertApprovalTurnActiveInTransaction(tx, row)

  const state = await tx.$queryRaw<Array<{ hasRequest: boolean; hasGoalRevision: boolean }>>(Prisma.sql`
    WITH request AS (
      SELECT "sequence" FROM "agent_events"
      WHERE "sessionId" = ${row.sessionId}
        AND "turnId" = ${row.turnId}
        AND "type" = 'approval.requested'
        AND "correlationId" = ${row.id}
        AND "idempotencyKey" = ${`approval:${row.id}:requested`}
      ORDER BY "sequence" ASC
      LIMIT 1
    )
    SELECT
      EXISTS (SELECT 1 FROM request) AS "hasRequest",
      EXISTS (
        SELECT 1 FROM "agent_events" AS revision
        JOIN request ON true
        WHERE revision."sessionId" = ${row.sessionId}
          AND revision."type" = 'goal.revision'
          AND revision."sequence" > request."sequence"
      ) AS "hasGoalRevision"
  `)
  const current = state[0]
  if (!current?.hasRequest) throw new ApprovalStoreError("approval_integrity_error", "Approval receipt request event is unavailable")
  if (current.hasGoalRevision) throw new ApprovalStoreError("approval_revision_mismatch", "Approval receipt is stale after a goal revision")
}

/** Shared AH2-019 state transition used by both legacy and broker callers. */
export async function resolvePendingApprovalInTransaction(
  tx: Tx,
  input: PendingApprovalDecisionInput,
): Promise<ResolvedApprovalRow> {
  const row = await tx.agentApproval.findFirst({
    where: { id: input.id, userId: input.userId, sessionId: input.sessionId },
    select: { id: true, sessionId: true, taskId: true, userId: true, turnId: true, toolCallId: true, type: true, status: true, scopeHash: true, revision: true, expiresAt: true, payload: true },
  })
  if (!row) throw new ApprovalStoreError("approval_not_found", "Approval receipt was not found")
  assertNotObjectiveApprovalSetMember(row.payload)
  const turnId = row.turnId
  if (typeof turnId !== "string" || turnId.length === 0) throw new ApprovalStoreError("approval_integrity_error", "Legacy approval records cannot become scoped receipts")
  if (row.status !== "pending") throw new ApprovalStoreError(row.status === "consumed" ? "approval_already_consumed" : "approval_not_approved", "Approval receipt is no longer pending")
  if (row.expiresAt && row.expiresAt <= input.now) throw new ApprovalStoreError("approval_expired", "Approval receipt has expired")
  await assertApprovalFreshnessInTransaction(tx, { id: row.id, sessionId: row.sessionId, turnId, userId: input.userId })
  const reviewedSignal = await hasReviewedApplicationSignal(tx, row, turnId)
  if (reviewedSignal && !validReviewedDecision(input.reviewedApplicationDecision, row, turnId, input)) {
    throw new ApprovalStoreError("approval_scope_mismatch", "Reviewed application decisions require canonical broker verification")
  }
  if (input.reviewedSourceTurnId !== undefined) await assertReviewedFillDecisionWait(tx, {
    approvalId: row.id, userId: row.userId, sessionId: row.sessionId, decision: input.decision, now: input.now,
  })
  const updated = await tx.agentApproval.updateMany({
    where: { id: input.id, userId: input.userId, sessionId: input.sessionId, status: "pending", turnId, revision: row.revision },
    data: { status: input.decision, decidedAt: input.now },
  })
  if (updated.count !== 1) throw new ApprovalStoreError("approval_not_approved", "Approval receipt resolution raced with another decision")
  if (input.reviewedSourceTurnId !== undefined) {
    await persistReviewedFillSourceInTransaction(tx, {
      approvalId: row.id, userId: row.userId, sessionId: row.sessionId,
      decision: input.decision, sourceTurnId: input.reviewedSourceTurnId,
    })
    await enqueueReviewedFillHandoffInTransaction(tx, {
      approvalId: row.id, userId: row.userId, sessionId: row.sessionId,
      sourceTurnId: input.reviewedSourceTurnId, now: input.now,
    })
  }
  return {
    id: row.id, sessionId: row.sessionId, taskId: row.taskId, userId: row.userId, turnId,
    toolCallId: row.toolCallId, type: row.type, status: row.status, scopeHash: row.scopeHash,
    revision: row.revision, expiresAt: row.expiresAt,
  }
}

async function hasReviewedApplicationSignal(
  tx: Tx, row: { id: string; sessionId: string; userId: string; taskId?: string | null; toolCallId?: string | null }, turnId: string,
): Promise<boolean> {
  if (row.id.startsWith("reviewed-application-review:") || row.toolCallId?.startsWith("review_application:") === true) return true
  const [turn, events] = await Promise.all([
    tx.agentTurn.findFirst({ where: { id: turnId, sessionId: row.sessionId, userId: row.userId }, select: { input: true } }),
    row.taskId ? tx.applicationTaskEvent.findMany({ where: { taskId: row.taskId, type: "reviewed_application_review_issued",
      OR: [{ data: { path: ["reviewTurnId"], equals: turnId } }, { data: { path: ["approvalId"], equals: row.id } }] },
      take: 2, select: { id: true } }) : Promise.resolve([]),
  ])
  const input = jsonRecord(turn?.input), intent = jsonRecord(input?.intent)
  return intent?.kind === "reviewed_application_review" || events.length > 0
}

function validReviewedDecision(
  value: ReviewedApplicationDecisionVerification | undefined, row: { id: string }, turnId: string,
  input: PendingApprovalDecisionInput,
): boolean {
  if (!value || value.approvalId !== row.id || value.turnId !== turnId || value.decision !== input.decision) return false
  return input.decision === "approved"
    ? value.status === "reviewed_approved" && typeof value.sourceTurnId === "string" && value.sourceTurnId === input.reviewedSourceTurnId
    : value.status === "reviewed_rejected" && value.sourceTurnId === undefined && input.reviewedSourceTurnId === undefined
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}
