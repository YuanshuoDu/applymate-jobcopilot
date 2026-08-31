import type { Prisma } from "@prisma/client"

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
  if (typeof row.turnId !== "string" || row.turnId.length === 0) throw new ApprovalStoreError("approval_integrity_error", "Legacy approval records cannot become scoped receipts")
  if (row.status !== "pending") throw new ApprovalStoreError(row.status === "consumed" ? "approval_already_consumed" : "approval_not_approved", "Approval receipt is no longer pending")
  if (row.expiresAt && row.expiresAt <= input.now) throw new ApprovalStoreError("approval_expired", "Approval receipt has expired")
  const updated = await tx.agentApproval.updateMany({
    where: { id: input.id, userId: input.userId, sessionId: input.sessionId, status: "pending", turnId: row.turnId, revision: row.revision },
    data: { status: input.decision, decidedAt: input.now },
  })
  if (updated.count !== 1) throw new ApprovalStoreError("approval_not_approved", "Approval receipt resolution raced with another decision")
  return { ...row, turnId: row.turnId as string }
}
