import { Prisma, type PrismaClient } from "@prisma/client"

import { waitItemId } from "../broker/item-ids"
import { appendAgentEventWithOutboxInTransaction } from "../session/fact-store"
import { resolvePendingApprovalInTransaction } from "./decision"
import type { LegacyApprovalResolution, ScopedApprovalRecord } from "./legacy-receipt"

const ACTIVE_TURN_STATUSES = [
  "queued",
  "in_progress",
  "waiting_for_dependency",
  "waiting_for_approval",
  "waiting_for_user",
] as const

function isActiveTurnStatus(status: string): boolean {
  return ACTIVE_TURN_STATUSES.some((activeStatus) => activeStatus === status)
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
    const session = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "agent_sessions"
      WHERE "id" = ${input.sessionId} AND "userId" = ${input.userId}
      FOR UPDATE
    `)
    if (!session[0]) throw new Error("Approval session is no longer available")

    const turn = await tx.agentTurn.findFirst({
      where: { id: turnId, sessionId: input.sessionId, userId: input.userId },
      select: { id: true, status: true },
    })
    if (!turn || !isActiveTurnStatus(turn.status)) throw new Error("Approval turn is no longer available")

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
