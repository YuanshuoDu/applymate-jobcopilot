import type { Prisma, PrismaClient } from "@prisma/client"
import { type ApprovalType } from "@jobcopilot/agent-protocol"
import { hashAgentReceiptValue } from "@jobcopilot/shared"

import { consumeApprovalAndReserve, issueApprovalReceipt, validatePendingApprovalReceipt } from "./store"
import type { PreparedApprovalReceipt } from "./receipt-issue-owner"
import { reissueApprovalNonce } from "./receipt-rotation"
import { decideApproval } from "../broker/store"
import { waitItemId } from "../broker/item-ids"
import { ApprovalWaitActiveError, CanonicalWaitFoundError, resolveLegacyOnlyInTransaction } from "./legacy-approval-fence"
import type { ApprovalReceiptResult, ApprovalScopeInput } from "./types"

export interface LegacyReceiptInput {
  userId: string
  sessionId: string
  turnId: string
  toolCallId: string
  jobId: string
  action: ApprovalType
  title: string
  body: string
  impact?: unknown
  payload: unknown
  resource: unknown
  material: unknown
  answers?: unknown
  revision?: number
  expiresAt?: Date
  projectWait?: boolean
  executionAttempt?: { id: string; attemptCount: number }
  signal?: AbortSignal
  prepareInTransaction?: (tx: Prisma.TransactionClient) => Promise<{
    taskId?: string | null
    payload?: unknown
    resource?: unknown
    material?: unknown
    answers?: unknown
  }>
}

export interface LegacyReceiptConsumeInput extends Omit<LegacyReceiptInput, "title" | "body" | "impact" | "payload" | "prepareInTransaction"> {
  approvalId: string
  nonce: string
  reservationKey?: string
}

export interface ScopedApprovalRecord {
  id: string
  type: string
  payload: unknown
  turnId: string | null
  toolCallId: string | null
  jobId: string | null
  revision: number
  expiresAt: Date | null
}

export type LegacyApprovalResolution =
  | { disposition: "legacy_only"; decision: "approved" | "rejected" }
  | {
      disposition: "canonical_wait"
      decision: "approved" | "rejected"
      result: Awaited<ReturnType<typeof decideApproval>>
    }

export { ApprovalWaitActiveError }

export async function issueLegacyReceipt(db: PrismaClient, input: LegacyReceiptInput): Promise<ApprovalReceiptResult> {
  const effectiveInput = { ...input, expiresAt: input.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000) }
  const scope = await legacyScope(effectiveInput)
  const prepareInTransaction = effectiveInput.prepareInTransaction
    ? async (tx: Prisma.TransactionClient): Promise<PreparedApprovalReceipt> => {
        const prepared = await effectiveInput.prepareInTransaction!(tx)
        const preparedScope = await legacyScope({ ...effectiveInput, ...prepared })
        return {
          scope: preparedScope,
          ...(prepared.taskId !== undefined ? { taskId: prepared.taskId } : {}),
          ...(prepared.payload !== undefined ? { payload: prepared.payload as never } : {}),
        }
      }
    : undefined
  return issueApprovalReceipt(db, {
    scope,
    title: effectiveInput.title,
    body: effectiveInput.body,
    impact: effectiveInput.impact as never,
    payload: effectiveInput.payload as never,
    projectWait: effectiveInput.projectWait,
    executionAttempt: effectiveInput.executionAttempt,
    signal: effectiveInput.signal,
    prepareInTransaction,
  })
}

export async function consumeLegacyReceipt(db: PrismaClient, input: LegacyReceiptConsumeInput) {
  const scope = await legacyScope(input)
  return consumeApprovalAndReserve(db, input.approvalId, { ...scope, nonce: input.nonce }, input.reservationKey ? { idempotencyKey: input.reservationKey } : null)
}

export async function validateLegacyReceipt(db: PrismaClient, input: LegacyReceiptConsumeInput) {
  const scope = await legacyScope(input)
  return validatePendingApprovalReceipt(db, input.approvalId, { ...scope, nonce: input.nonce })
}

export async function resolveLegacyApproval(
  db: PrismaClient,
  input: { approval: ScopedApprovalRecord; userId: string; sessionId: string; decision: "approved" | "rejected" },
  options: { beforeResolve?: () => Promise<void>; beforeLegacyOnlyResolve?: () => Promise<void> } = {},
): Promise<LegacyApprovalResolution> {
  const approval = input.approval
  if (!approval.turnId || !approval.toolCallId || !approval.jobId || !approval.expiresAt) {
    throw new Error("Approval is missing its scoped wait state")
  }
  await options.beforeResolve?.()
  const item = db.agentItem ? await db.agentItem.findFirst({
    where: { id: waitItemId("approval", approval.id), sessionId: input.sessionId, turnId: approval.turnId },
    select: { id: true, revision: true },
  }) : null
  if (!item) {
    try {
      return await resolveLegacyOnlyInTransaction(db, input, options)
    } catch (error) {
      if (!(error instanceof CanonicalWaitFoundError)) throw error
    }
  }
  const turn = await db.agentTurn.findFirst({
    where: { id: approval.turnId, sessionId: input.sessionId, userId: input.userId },
    select: { id: true, revision: true },
  })
  if (!turn) throw new Error("Approval turn is no longer available")
  const result = await decideApproval(db, {
    waitId: approval.id,
    sessionId: input.sessionId,
    userId: input.userId,
    clientMessageId: `legacy-approval:${approval.id}:${input.decision}`,
    expectedTurnId: approval.turnId,
    expectedRevision: turn.revision,
    decision: input.decision,
  })
  return { disposition: "canonical_wait", decision: input.decision, result }
}

export async function hashLegacyValue(label: string, value: unknown): Promise<string> {
  return hashAgentReceiptValue(label, value)
}

async function legacyScope(input: Pick<LegacyReceiptInput, "userId" | "sessionId" | "turnId" | "jobId" | "toolCallId" | "action" | "resource" | "material" | "answers" | "revision" | "expiresAt">): Promise<ApprovalScopeInput> {
  return {
    userId: input.userId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    jobId: input.jobId,
    toolCallId: input.toolCallId,
    action: input.action,
    resourceHash: await hashLegacyValue("resource", input.resource),
    materialHash: await hashLegacyValue("material", input.material),
    answersHash: await hashLegacyValue("answers", input.answers ?? null),
    revision: input.revision ?? 0,
    expiresAt: input.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000),
  }
}

export function clientReceipt(result: ApprovalReceiptResult, impact?: unknown) {
  const { approval } = result
  return {
    id: approval.id,
    type: approval.type,
    title: approval.title,
    body: approval.body,
    impact: impact ?? null,
    payload: approval.payload,
    status: approval.status,
    receiptNonce: result.nonce,
    scopeHash: approval.scopeHash,
  }
}

export { reissueApprovalNonce }
