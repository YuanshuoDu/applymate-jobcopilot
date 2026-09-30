import { Prisma } from "@prisma/client"

import { AgentExecutionCancelledError, refreshAgentExecutionAttempt } from "../execution-control"
import { lockOpenSession } from "../session/v2-turn"
import { ApprovalStoreError, assertScopeInput, type ApprovalScopeInput } from "./types"

const ACTIVE_TURN_STATUSES = ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] as const

export type PreparedApprovalReceipt = {
  scope: ApprovalScopeInput
  taskId?: string | null
  payload?: Prisma.InputJsonValue
}

export type ReceiptIssueOwnerInput = {
  executionAttempt?: { id: string; attemptCount: number }
  signal?: AbortSignal
  prepareInTransaction?: (tx: Prisma.TransactionClient) => Promise<PreparedApprovalReceipt>
}

export async function prepareReceiptIssueInTransaction(
  tx: Prisma.TransactionClient,
  input: { scope: ApprovalScopeInput } & ReceiptIssueOwnerInput,
): Promise<{ prepared?: PreparedApprovalReceipt; receiptScope: ApprovalScopeInput }> {
  const { scope } = input
  if (input.signal?.aborted) throw new AgentExecutionCancelledError()
  await lockOpenSession(tx, { sessionId: scope.sessionId, userId: scope.userId })
  const turns = await tx.$queryRaw<Array<{ id: string; status: string; revision: number }>>(Prisma.sql`
    SELECT "id", "status", "revision" FROM "agent_turns"
    WHERE "id" = ${scope.turnId} AND "sessionId" = ${scope.sessionId} AND "userId" = ${scope.userId}
    FOR UPDATE
  `)
  const turn = turns[0]
  if (!turn || !ACTIVE_TURN_STATUSES.includes(turn.status as (typeof ACTIVE_TURN_STATUSES)[number])) {
    throw new ApprovalStoreError("approval_scope_mismatch", "Approval turn is no longer active")
  }
  if (turn.revision !== scope.revision) throw new ApprovalStoreError("approval_revision_mismatch", "Approval turn revision changed before receipt issuance")
  if (input.signal?.aborted) throw new AgentExecutionCancelledError()
  if (input.executionAttempt && !await refreshAgentExecutionAttempt(tx, { ...input.executionAttempt, userId: scope.userId })) {
    throw new AgentExecutionCancelledError()
  }
  if (input.signal?.aborted) throw new AgentExecutionCancelledError()
  const prepared = await input.prepareInTransaction?.(tx)
  const receiptScope = prepared?.scope ?? scope
  assertScopeInput(receiptScope)
  if (receiptScope.userId !== scope.userId
    || receiptScope.sessionId !== scope.sessionId
    || receiptScope.turnId !== scope.turnId
    || receiptScope.jobId !== scope.jobId
    || receiptScope.toolCallId !== scope.toolCallId
    || receiptScope.action !== scope.action
    || receiptScope.revision !== turn.revision
    || receiptScope.expiresAt.getTime() !== scope.expiresAt.getTime()) {
    throw new ApprovalStoreError("approval_scope_mismatch", "Receipt preparation changed its fenced scope")
  }
  return { prepared, receiptScope }
}
