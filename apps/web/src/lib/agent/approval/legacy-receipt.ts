import type { Prisma, PrismaClient } from "@prisma/client"
import { hashApprovalNonce, type ApprovalType } from "@jobcopilot/agent-protocol"
import { hashAgentReceiptValue } from "@jobcopilot/shared"
import { createHmac } from "node:crypto"

import { consumeApprovalAndReserve, issueApprovalReceipt, validatePendingApprovalReceipt } from "./store"
import { assertGateReplayTaskBinding, recoverGateReviewReplay, type ReplayReceiptExpectation, type ScheduledGateReplayOwnerFence } from "./gate-replay"
import type { PreparedApprovalReceipt } from "./receipt-issue-owner"
import { reissueApprovalNonce } from "./receipt-rotation"
import { decideApproval } from "../broker/store"
import { waitItemId } from "../broker/item-ids"
import { ApprovalWaitActiveError, CanonicalWaitFoundError, resolveLegacyOnlyInTransaction } from "./legacy-approval-fence"
import { lockOpenSession } from "../session/v2-turn"
import { AgentExecutionCancelledError } from "../execution-control"
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
  scheduledOwnerFence?: ScheduledGateReplayOwnerFence
  /** Stable, recoverable issuance for a Gate review after a transaction commit/retry. */
  replayMode?: "gate-review" | "scheduled-taskgraph-gate-review"
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
  const initialScope = await legacyScope(effectiveInput)
  const replayCoordinates = effectiveInput.replayMode
    ? gateReviewReplayCoordinates(initialScope, effectiveInput.executionAttempt, effectiveInput.scheduledOwnerFence, effectiveInput.replayMode)
    : null
  if (replayCoordinates) effectiveInput.toolCallId = replayCoordinates.toolCallId
  const scope = replayCoordinates ? { ...initialScope, toolCallId: replayCoordinates.toolCallId } : initialScope
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
    ...(replayCoordinates ? {
      approvalId: replayCoordinates.approvalId,
      nonce: replayCoordinates.nonce,
      replayExisting: { taskPayloadField: "applicationTaskId" },
      ...(effectiveInput.scheduledOwnerFence ? { scheduledOwnerFence: effectiveInput.scheduledOwnerFence } : {}),
    } : {}),
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

/** Recovers only an exact scheduled Gate receipt. An absent row has no preparation or write fallback. */
export async function findScheduledGateReviewReceiptReplay(
  db: PrismaClient,
  input: LegacyReceiptInput & { replayMode: "scheduled-taskgraph-gate-review" },
): Promise<ApprovalReceiptResult | null> {
  const effectiveInput = { ...input, expiresAt: input.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000) }
  const initialScope = await legacyScope(effectiveInput)
  const replayCoordinates = gateReviewReplayCoordinates(initialScope, effectiveInput.executionAttempt,
    effectiveInput.scheduledOwnerFence, "scheduled-taskgraph-gate-review")
  effectiveInput.toolCallId = replayCoordinates.toolCallId
  const scope = { ...initialScope, toolCallId: replayCoordinates.toolCallId }
  const expectation = await replayExpectation(effectiveInput, scope, replayCoordinates)

  return db.$transaction(async tx => {
    await assertScheduledGateReplayOwnerReadOnly(tx, effectiveInput)
    const existing = await tx.agentApproval.findFirst({
      where: { id: replayCoordinates.approvalId, userId: scope.userId },
    })
    if (!existing) return null
    await assertGateReplayTaskBinding(tx, existing, expectation)
    return recoverGateReviewReplay(existing, expectation, new Date())
  })
}

async function assertScheduledGateReplayOwnerReadOnly(
  tx: Prisma.TransactionClient,
  input: LegacyReceiptInput,
): Promise<void> {
  const fence = input.scheduledOwnerFence
  if (input.signal?.aborted || !fence || !input.executionAttempt) throw new AgentExecutionCancelledError()
  await lockOpenSession(tx, { sessionId: input.sessionId, userId: input.userId })
  if (input.signal?.aborted || !await fence.assertCurrent(tx)) throw new AgentExecutionCancelledError()
  const current = await tx.agentExecution.findFirst({
    where: { id: input.executionAttempt.id, userId: input.userId, status: "running", attemptCount: input.executionAttempt.attemptCount },
    select: { id: true },
  })
  if (!current || input.signal?.aborted) throw new AgentExecutionCancelledError()
}

type GateReplayAttempt = { id: string; attemptCount: number } | undefined
type GateReplayOwnerFence = ScheduledGateReplayOwnerFence

type GateReplayMode = NonNullable<LegacyReceiptInput["replayMode"]>

function gateReviewReplayCoordinates(scope: ApprovalScopeInput, attempt: GateReplayAttempt, ownerFence: GateReplayOwnerFence | undefined, mode: GateReplayMode) {
  if (scope.action !== "review_application" || !attempt || !attempt.id.trim()
    || !Number.isSafeInteger(attempt.attemptCount) || attempt.attemptCount < 0) {
    throw new Error("Gate receipt replay requires an exact execution attempt")
  }
  const owner = ownerFence?.owner
  if (!ownerFence || !owner
    || owner.userId !== scope.userId || owner.sessionId !== scope.sessionId || owner.turnId !== scope.turnId
    || !owner.rootTaskId.trim() || !Number.isSafeInteger(owner.rootAttemptCount) || owner.rootAttemptCount < 1
    || !owner.turnLeaseOwnerId.trim() || !Number.isSafeInteger(owner.turnLeaseVersion) || owner.turnLeaseVersion < 1
    || owner.executionId !== attempt.id || owner.executionAttemptCount !== attempt.attemptCount
    || !ownerFence.key.trim() || !ownerFence.claimToken.trim() || typeof ownerFence.assertCurrent !== "function") {
    throw new Error("Gate receipt replay requires an exact scheduled owner fence")
  }
  const secret = process.env.AGENT_WORKER_SECRET?.trim()
  if (!secret) throw new Error("Gate receipt replay signing key is unavailable")

  const identity = JSON.stringify([
    1,
    scope.userId,
    scope.sessionId,
    scope.turnId,
    attempt.id,
    attempt.attemptCount,
    [owner.rootTaskId, owner.rootAttemptCount, owner.executionId, owner.executionAttemptCount],
    scope.jobId,
    scope.action,
    scope.resourceHash,
    scope.materialHash,
    scope.answersHash,
    ...(mode === "scheduled-taskgraph-gate-review" ? [ownerFence.key] : []),
  ])
  const derive = (label: "approval-id" | "receipt-nonce" | "tool-call-id") => createHmac("sha256", secret)
    .update(`${mode === "scheduled-taskgraph-gate-review" ? "applymate.scheduled-gate-review-replay.v2" : "applymate.gate-review-replay.v1"}:${label}\0${identity}`)
    .digest("hex")

  return {
    approvalId: `gate_review_${derive("approval-id")}`,
    nonce: derive("receipt-nonce"),
    toolCallId: `application-review:${derive("tool-call-id")}`,
  }
}

async function replayExpectation(
  input: LegacyReceiptInput,
  scope: ApprovalScopeInput,
  replayCoordinates: ReturnType<typeof gateReviewReplayCoordinates>,
): Promise<ReplayReceiptExpectation> {
  return {
    approvalId: replayCoordinates.approvalId,
    nonce: replayCoordinates.nonce,
    nonceHash: await hashApprovalNonce(replayCoordinates.nonce),
    scope,
    taskId: null,
    taskPayloadField: "applicationTaskId",
    title: input.title,
    body: input.body,
    impact: input.impact ?? null,
    payload: input.payload,
  }
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
