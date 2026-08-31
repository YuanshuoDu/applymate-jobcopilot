import { Prisma, PrismaClient } from "@prisma/client"
import { createApprovalNonce, hashApprovalNonce, hashApprovalScope, type ApprovalScope, type ApprovalType } from "@jobcopilot/agent-protocol"

import { waitItemId } from "../broker/item-ids"
import { appendAgentEventWithOutboxInTransaction } from "../session/fact-store"
import { ApprovalStoreError, protocolScope } from "./types"

type ApprovalRow = Prisma.AgentApprovalGetPayload<{}>

export interface RotatedApprovalReceipt {
  approvalId: string
  receiptNonce: string
  scopeHash: string
  expiresAt: string
}

/** Reissues only the in-memory nonce; plaintext never enters an event. */
export async function reissueApprovalNonce(
  db: PrismaClient,
  input: { approvalId: string; sessionId: string; userId: string },
): Promise<RotatedApprovalReceipt> {
  const nonce = createApprovalNonce()
  const nonceHash = await hashApprovalNonce(nonce)

  return db.$transaction(async (tx) => {
    const row = await tx.agentApproval.findFirst({
      where: { id: input.approvalId, sessionId: input.sessionId, userId: input.userId },
    })
    if (!row) throw new ApprovalStoreError("approval_not_found", "Approval receipt was not found")
    if (row.status !== "pending") throw new ApprovalStoreError("approval_not_approved", "Approval receipt is no longer pending")
    if (!row.turnId || !row.toolCallId || !row.jobId || !row.resourceHash || !row.materialHash || !row.answersHash || !row.scopeHash || !row.expiresAt || !row.nonceHash) {
      throw new ApprovalStoreError("approval_integrity_error", "Approval receipt is missing its immutable scope")
    }
    if (row.expiresAt <= new Date()) throw new ApprovalStoreError("approval_expired", "Approval receipt has expired")

    const currentScope = protocolScope({
      userId: row.userId, sessionId: row.sessionId, turnId: row.turnId, jobId: row.jobId,
      toolCallId: row.toolCallId, action: row.type as ApprovalType, resourceHash: row.resourceHash,
      materialHash: row.materialHash, answersHash: row.answersHash, revision: row.revision, expiresAt: row.expiresAt,
    }, row.nonceHash)
    if (row.scopeHash !== await hashApprovalScope(currentScope)) {
      throw new ApprovalStoreError("approval_integrity_error", "Approval receipt scope integrity check failed")
    }

    const scopeHash = await hashApprovalScope({ ...currentScope, nonceHash } as ApprovalScope)
    const updated = await tx.agentApproval.updateMany({
      where: { id: row.id, sessionId: input.sessionId, userId: input.userId, status: "pending", scopeHash: row.scopeHash, nonceHash: row.nonceHash },
      data: { scopeHash, nonceHash },
    })
    if (updated.count !== 1) throw new ApprovalStoreError("approval_already_consumed", "Approval receipt changed while it was being refreshed")

    const item = await tx.agentItem.findFirst({
      where: { id: waitItemId("approval", row.id), sessionId: input.sessionId, turnId: row.turnId },
      select: { id: true, content: true },
    })
    if (item) {
      const content = record(item.content)
      await tx.agentItem.update({ where: { id: item.id }, data: { content: { ...content, scopeHash } as Prisma.InputJsonValue } })
    }

    await appendAgentEventWithOutboxInTransaction(tx, {
      sessionId: row.sessionId, turnId: row.turnId, itemId: item?.id ?? null, taskId: row.taskId,
      type: "approval.receipt_rotated", actor: "system", correlationId: row.id, causationId: null,
      idempotencyKey: `approval:${row.id}:receipt-rotated:${scopeHash}`,
      payload: { approvalId: row.id, scopeHash, revision: row.revision }, outboxTopic: "agent.session.event",
    })
    return { approvalId: row.id, receiptNonce: nonce, scopeHash, expiresAt: row.expiresAt.toISOString() }
  })
}

function record(value: Prisma.JsonValue): Record<string, Prisma.JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue>
    : {}
}
