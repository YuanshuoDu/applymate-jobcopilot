import { Prisma } from "@prisma/client"

import { ApprovalStoreError, type ApprovalDecision } from "./types"

type Tx = Prisma.TransactionClient

export interface PendingApprovalDecisionInput {
  id: string
  userId: string
  sessionId: string
  decision: ApprovalDecision
  now: Date
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
}

/**
 * Serializes the decision with session-scoped event writes, then checks the
 * durable request lineage and revision events before the approval mutates.
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
    select: { id: true, sessionId: true, taskId: true, userId: true, turnId: true, toolCallId: true, type: true, status: true, scopeHash: true, revision: true, expiresAt: true },
  })
  if (!row) throw new ApprovalStoreError("approval_not_found", "Approval receipt was not found")
  const turnId = row.turnId
  if (typeof turnId !== "string" || turnId.length === 0) throw new ApprovalStoreError("approval_integrity_error", "Legacy approval records cannot become scoped receipts")
  if (row.status !== "pending") throw new ApprovalStoreError(row.status === "consumed" ? "approval_already_consumed" : "approval_not_approved", "Approval receipt is no longer pending")
  if (row.expiresAt && row.expiresAt <= input.now) throw new ApprovalStoreError("approval_expired", "Approval receipt has expired")
  await assertApprovalFreshnessInTransaction(tx, { id: row.id, sessionId: row.sessionId, turnId })
  const updated = await tx.agentApproval.updateMany({
    where: { id: input.id, userId: input.userId, sessionId: input.sessionId, status: "pending", turnId, revision: row.revision },
    data: { status: input.decision, decidedAt: input.now },
  })
  if (updated.count !== 1) throw new ApprovalStoreError("approval_not_approved", "Approval receipt resolution raced with another decision")
  return { ...row, turnId }
}
