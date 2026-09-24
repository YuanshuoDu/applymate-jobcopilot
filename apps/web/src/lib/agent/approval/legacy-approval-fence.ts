import type { PrismaClient } from "@prisma/client"

import { waitItemId } from "../broker/item-ids"
import { ACTIVE_TURN_STATUSES, lockOpenSession } from "../control-plane/commands/transaction"
import { appendAgentEventWithOutboxInTransaction } from "../session/fact-store"
import { assertApprovalTurnActiveInTransaction, resolvePendingApprovalInTransaction } from "./decision"
import type { LegacyApprovalResolution, ScopedApprovalRecord } from "./legacy-receipt"

export class ApprovalTurnInactiveError extends Error {
  readonly code = "approval_turn_inactive" as const

  constructor(message = "Approval turn is no longer active") {
    super(message)
    this.name = "ApprovalTurnInactiveError"
  }
}

async function assertLegacyTurnActiveInTransaction(
  tx: Parameters<typeof assertApprovalTurnActiveInTransaction>[0],
  scope: { userId: string; sessionId: string; turnId: string },
  inactiveMessage?: string,
): Promise<void> {
  try {
    await assertApprovalTurnActiveInTransaction(tx, scope, inactiveMessage)
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined
    if (code === "approval_scope_mismatch" && error instanceof Error) {
      throw new ApprovalTurnInactiveError(error.message)
    }
    throw error
  }
}

export async function resumeLegacyApprovalTurnInTransaction(
  db: PrismaClient,
  scope: { userId: string; sessionId: string; turnId: string },
): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockOpenSession(tx, scope.sessionId, scope.userId)
    await assertLegacyTurnActiveInTransaction(tx, scope)
    const updated = await tx.agentTurn.updateMany({
      where: {
        id: scope.turnId,
        sessionId: scope.sessionId,
        userId: scope.userId,
        status: { in: [...ACTIVE_TURN_STATUSES] },
      },
      data: { status: "in_progress" },
    })
    if (updated.count !== 1) throw new ApprovalTurnInactiveError()
  })
}

export class ApprovalWaitActiveError extends Error {
  readonly code = "approval_wait_active" as const

  constructor() {
    super("Another approval wait is already active for this Turn")
    this.name = "ApprovalWaitActiveError"
  }
}

export class CanonicalWaitFoundError extends Error {
  constructor() {
    super("A canonical approval wait is already projected")
    this.name = "CanonicalWaitFoundError"
  }
}

export async function resolveLegacyOnlyInTransaction(
  db: PrismaClient,
  input: { approval: ScopedApprovalRecord; userId: string; sessionId: string; decision: "approved" | "rejected" },
  options: { beforeLegacyOnlyResolve?: () => Promise<void> },
): Promise<Extract<LegacyApprovalResolution, { disposition: "legacy_only" }>> {
  const approval = input.approval
  const turnId = approval.turnId
  if (!turnId) throw new Error("Approval is missing its scoped wait state")
  const now = new Date()
  return db.$transaction(async (tx) => {
    await lockOpenSession(tx, input.sessionId, input.userId)

    await assertLegacyTurnActiveInTransaction(tx, { turnId, sessionId: input.sessionId, userId: input.userId }, "Approval turn is no longer available")

    const itemId = waitItemId("approval", approval.id)
    const ownItem = await tx.agentItem.findFirst({
      where: { id: itemId, sessionId: input.sessionId, turnId },
      select: { id: true },
    })
    if (ownItem) throw new CanonicalWaitFoundError()

    const activeItems = await tx.agentItem.findMany({
      where: { sessionId: input.sessionId, turnId, type: "approval_request", status: "started" },
      select: { content: true },
    })
    const pendingApprovals = await tx.agentApproval.findMany({
      where: { sessionId: input.sessionId, userId: input.userId, turnId, status: "pending" },
      select: { id: true },
    })
    const pendingIds = new Set(pendingApprovals.map((row) => row.id))
    const hasOtherActiveWait = activeItems.some((item) => {
      const content = item.content && typeof item.content === "object" && !Array.isArray(item.content)
        ? item.content as Record<string, unknown>
        : null
      const approvalId = typeof content?.approvalId === "string" ? content.approvalId : null
      return approvalId !== null && pendingIds.has(approvalId)
    })
    if (hasOtherActiveWait) throw new ApprovalWaitActiveError()

    await options.beforeLegacyOnlyResolve?.()
    const row = await resolvePendingApprovalInTransaction(tx, {
      id: approval.id,
      userId: input.userId,
      sessionId: input.sessionId,
      decision: input.decision,
      now,
    })
    await appendAgentEventWithOutboxInTransaction(tx, {
      sessionId: input.sessionId,
      turnId: row.turnId,
      itemId: null,
      taskId: row.taskId,
      type: "approval.resolved",
      actor: "user",
      correlationId: approval.id,
      causationId: null,
      idempotencyKey: `approval:${approval.id}:resolved:${input.decision}`,
      payload: {
        approvalId: approval.id,
        action: row.type,
        scopeHash: row.scopeHash ?? "legacy",
        revision: row.revision,
      },
      outboxTopic: "agent.session.event",
    })
    return { disposition: "legacy_only", decision: input.decision }
  })
}
