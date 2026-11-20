import { randomUUID } from "node:crypto"

import { Prisma, PrismaClient } from "@prisma/client"
import {
  createApprovalNonce,
  hashApprovalNonce,
  hashApprovalScope,
  type AgentApproval,
} from "@jobcopilot/agent-protocol"

import { appendAgentEventWithOutboxInTransaction } from "../session/fact-store"
import { projectApprovalWaitInTransaction } from "../broker/item-projector"
import {
  assertGateReplayOwnerInTransaction,
  assertGateReplayTaskBinding,
  mapReplayApproval,
  recoverGateReviewReplay,
  scopeFromRow,
  type ReplayOwnerInput,
  type ReplayReceiptExpectation,
  type ScheduledGateReplayOwnerFence,
} from "./gate-replay"
import { prepareReceiptIssueInTransaction, type ReceiptIssueOwnerInput } from "./receipt-issue-owner"
import {
  ApprovalStoreError,
  assertScopeInput,
  protocolScope,
  type ApprovalReceiptResult as StoreApprovalReceiptResult,
  type ApprovalScopeInput,
  type IssueApprovalReceiptInput,
} from "./types"

type ApprovalRow = Prisma.AgentApprovalGetPayload<{}>

export async function acquireReceiptSourceFence(
  tx: Prisma.TransactionClient,
  userId: string,
  hooks: ReceiptIssueOwnerInput["scheduledSourceHooks"],
): Promise<void> {
  if (hooks !== undefined) await hooks.acquireFence(tx, userId)
}

export async function validateReceiptSource(
  tx: Prisma.TransactionClient,
  scope: ApprovalScopeInput,
  hooks: ReceiptIssueOwnerInput["scheduledSourceHooks"],
): Promise<void> {
  if (hooks !== undefined) await hooks.validateFinalSource(tx, scope)
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2002"
}

function auditPayload(approvalId: string, action: string, scopeHash: string, revision: number): Prisma.InputJsonObject {
  return { approvalId, action, scopeHash, revision }
}

function mapApproval(row: ApprovalRow): AgentApproval {
  return mapReplayApproval(row, scopeFromRow(row))
}

export async function issueApprovalReceipt(
  db: PrismaClient,
  input: IssueApprovalReceiptInput & ReceiptIssueOwnerInput & {
    replayExisting?: { taskPayloadField?: string }
    scheduledOwnerFence?: ScheduledGateReplayOwnerFence
  },
): Promise<StoreApprovalReceiptResult> {
  assertScopeInput(input.scope)
  if (input.replayExisting && (!input.approvalId || !input.nonce?.trim() || !input.executionAttempt || !input.scheduledOwnerFence)) {
    throw new ApprovalStoreError("approval_scope_mismatch", "Approval replay requires its stable id and nonce")
  }
  const nonce = input.nonce ?? createApprovalNonce()
  const nonceHash = await hashApprovalNonce(nonce)
  const approvalId = input.approvalId ?? randomUUID()
  const replayExpectation: ReplayReceiptExpectation = {
    approvalId,
    nonce,
    nonceHash,
    scope: input.scope,
    taskId: input.taskId ?? null,
    ...(input.replayExisting?.taskPayloadField ? { taskPayloadField: input.replayExisting.taskPayloadField } : {}),
    title: input.title,
    body: input.body,
    impact: input.impact ?? null,
    payload: input.payload,
  }
  let sourceHookFailed = false
  const acquireFence = async (tx: Prisma.TransactionClient) => {
    try {
      await acquireReceiptSourceFence(tx, input.scope.userId, input.scheduledSourceHooks)
    } catch (error: unknown) {
      sourceHookFailed = true
      throw error
    }
  }
  const validateSource = async (tx: Prisma.TransactionClient, scope: ApprovalScopeInput) => {
    try {
      await validateReceiptSource(tx, scope, input.scheduledSourceHooks)
    } catch (error: unknown) {
      sourceHookFailed = true
      throw error
    }
  }

  try {
    const row = await db.$transaction(async (tx) => {
      await acquireFence(tx)
      if (input.replayExisting) {
        await assertGateReplayOwnerInTransaction(tx, input as ReplayOwnerInput)
        const existing = await tx.agentApproval.findFirst({ where: { id: approvalId, userId: input.scope.userId } })
        if (existing) {
          await assertGateReplayTaskBinding(tx, existing, replayExpectation)
          await validateSource(tx, input.scope)
          await recoverGateReviewReplay(existing, replayExpectation, new Date())
          return existing
        }
      }
      const { prepared, receiptScope } = await prepareReceiptIssueInTransaction(tx, input)
      await validateSource(tx, receiptScope)
      const scope = protocolScope(receiptScope, nonceHash)
      const scopeHash = await hashApprovalScope(scope)
      const taskId = prepared?.taskId ?? input.taskId ?? null
      const payload = prepared?.payload ?? input.payload
      const job = await tx.job.findFirst({ where: { id: receiptScope.jobId, userId: receiptScope.userId }, select: { id: true } })
      if (!job) throw new ApprovalStoreError("approval_scope_mismatch", "Approval job is not owned by the user")
      const impact = input.impact === undefined ? undefined : input.impact === null ? Prisma.JsonNull : input.impact
      const created = await tx.agentApproval.create({
        data: {
          id: approvalId, sessionId: receiptScope.sessionId, taskId, userId: receiptScope.userId,
          turnId: receiptScope.turnId, toolCallId: receiptScope.toolCallId, jobId: receiptScope.jobId, type: receiptScope.action,
          status: "pending", title: input.title, body: input.body,
          impact,
          payload,
          resourceHash: receiptScope.resourceHash, materialHash: receiptScope.materialHash, answersHash: receiptScope.answersHash,
          scopeHash, nonceHash, revision: receiptScope.revision, expiresAt: receiptScope.expiresAt,
        },
      })
      if (input.projectWait !== false) await projectApprovalWaitInTransaction(tx, {
        sessionId: receiptScope.sessionId,
        userId: receiptScope.userId,
        approvalId,
        turnId: receiptScope.turnId,
        toolCallId: receiptScope.toolCallId,
        action: receiptScope.action,
        title: input.title,
        body: input.body,
        impact: input.impact,
        scopeHash,
        receiptRevision: receiptScope.revision,
        expiresAt: receiptScope.expiresAt,
      })
      await appendAgentEventWithOutboxInTransaction(tx, {
        sessionId: receiptScope.sessionId, turnId: receiptScope.turnId, itemId: null, taskId,
        type: "approval.requested", actor: "orchestrator", correlationId: approvalId, causationId: null,
        idempotencyKey: `approval:${approvalId}:requested`, payload: auditPayload(approvalId, receiptScope.action, scopeHash, receiptScope.revision),
        outboxTopic: "agent.session.event",
      })
      return created
    })
    return { approval: mapApproval(row), nonce }
  } catch (error: unknown) {
    if (sourceHookFailed) throw error
    if (isUniqueViolation(error)) {
      if (input.replayExisting) {
        const replay = await db.$transaction(async tx => {
          await acquireFence(tx)
          await assertGateReplayOwnerInTransaction(tx, input as ReplayOwnerInput)
          const existing = await tx.agentApproval.findFirst({ where: { id: approvalId, userId: input.scope.userId } })
          if (!existing) {
            await validateSource(tx, input.scope)
            return null
          }
          await assertGateReplayTaskBinding(tx, existing, replayExpectation)
          await validateSource(tx, input.scope)
          return recoverGateReviewReplay(existing, replayExpectation, new Date())
        })
        if (replay) return replay
      }
      throw new ApprovalStoreError("approval_reservation_conflict", "Approval nonce or id is already in use")
    }
    throw error
  }
}
