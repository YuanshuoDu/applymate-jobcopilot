import { randomUUID } from "node:crypto"

import { Prisma, PrismaClient } from "@prisma/client"
import {
  createApprovalNonce,
  hashApprovalNonce,
  hashApprovalScope,
  schemaVersion,
  type AgentApproval,
  type ApprovalScope,
  type ApprovalType,
} from "@jobcopilot/agent-protocol"

import { appendAgentEventWithOutboxInTransaction } from "../session/fact-store"
import { projectApprovalWaitInTransaction } from "../broker/item-projector"
import { assertApprovalFreshnessInTransaction, resolvePendingApprovalInTransaction } from "./decision"
import { prepareReceiptIssueInTransaction, type ReceiptIssueOwnerInput } from "./receipt-issue-owner"
import {
  ApprovalStoreError,
  assertScopeInput,
  protocolScope,
  type ApprovalConsumeResult,
  type ApprovalDecision,
  type ApprovalReservationInput,
  type ApprovalReceiptResult,
  type ApprovalScopeInput,
  type ApprovalScopeMatch,
  type IssueApprovalReceiptInput,
} from "./types"

type ApprovalRow = Prisma.AgentApprovalGetPayload<{}>
type ApprovalReader = { agentApproval: { findFirst(args: Prisma.AgentApprovalFindFirstArgs): Promise<ApprovalRow | null> } }
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2002"
}

function auditPayload(approvalId: string, action: string, scopeHash: string, revision: number): Prisma.InputJsonObject {
  return { approvalId, action, scopeHash, revision }
}

function scopeFromRow(row: ApprovalRow): ApprovalScope {
  if (!row.turnId || !row.toolCallId || !row.jobId || !row.resourceHash || !row.materialHash || !row.answersHash || !row.scopeHash || !row.nonceHash || !row.expiresAt) {
    throw new ApprovalStoreError("approval_integrity_error", "Approval receipt is missing its immutable scope")
  }
  return protocolScope({
    userId: row.userId,
    sessionId: row.sessionId,
    turnId: row.turnId,
    jobId: row.jobId,
    toolCallId: row.toolCallId,
    action: row.type as ApprovalType,
    resourceHash: row.resourceHash,
    materialHash: row.materialHash,
    answersHash: row.answersHash,
    revision: row.revision,
    expiresAt: row.expiresAt,
  }, row.nonceHash)
}

function mapApproval(row: ApprovalRow): AgentApproval {
  const scope = scopeFromRow(row)
  return {
    schemaVersion,
    id: row.id,
    type: row.type as ApprovalType,
    status: row.status as AgentApproval["status"],
    title: row.title,
    body: row.body,
    scope,
    scopeHash: row.scopeHash as string,
    payload: row.payload,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    consumedAt: row.consumedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

async function loadApproval(reader: ApprovalReader, id: string, userId: string): Promise<ApprovalRow> {
  const row = await reader.agentApproval.findFirst({ where: { id, userId } })
  if (!row) throw new ApprovalStoreError("approval_not_found", "Approval receipt was not found")
  return row
}

async function assertScope(row: ApprovalRow, expected: ApprovalScopeMatch, now: Date): Promise<ApprovalScope> {
  if (row.status === "consumed") throw new ApprovalStoreError("approval_already_consumed", "Approval receipt has already been consumed")
  if (row.status !== "approved") throw new ApprovalStoreError("approval_not_approved", "Approval receipt is not approved")
  if (row.expiresAt && row.expiresAt <= now) throw new ApprovalStoreError("approval_expired", "Approval receipt has expired")

  const actual = scopeFromRow(row)
  if (row.scopeHash !== await hashApprovalScope(actual)) {
    throw new ApprovalStoreError("approval_integrity_error", "Approval receipt scope integrity check failed")
  }
  const expectedNonceHash = await hashApprovalNonce(expected.nonce)
  if (row.nonceHash !== expectedNonceHash) throw new ApprovalStoreError("approval_nonce_mismatch", "Approval receipt nonce does not match")
  const expectedScope = protocolScope(expected, expectedNonceHash)
  if (row.scopeHash !== await hashApprovalScope(expectedScope)) {
    if (row.revision !== expected.revision) throw new ApprovalStoreError("approval_revision_mismatch", "Approval receipt revision is stale")
    throw new ApprovalStoreError("approval_scope_mismatch", "Approval receipt scope does not match the requested action")
  }
  return actual
}

/** Verifies a pending receipt before a decision can mutate its state. */
async function assertPendingScope(row: ApprovalRow, expected: ApprovalScopeMatch, now: Date): Promise<ApprovalScope> {
  if (row.status !== "pending") throw new ApprovalStoreError("approval_not_approved", "Approval receipt is no longer pending")
  if (row.expiresAt && row.expiresAt <= now) throw new ApprovalStoreError("approval_expired", "Approval receipt has expired")

  const actual = scopeFromRow(row)
  if (row.scopeHash !== await hashApprovalScope(actual)) {
    throw new ApprovalStoreError("approval_integrity_error", "Approval receipt scope integrity check failed")
  }
  const expectedNonceHash = await hashApprovalNonce(expected.nonce)
  if (row.nonceHash !== expectedNonceHash) throw new ApprovalStoreError("approval_nonce_mismatch", "Approval receipt nonce does not match")
  const expectedScope = protocolScope(expected, expectedNonceHash)
  if (row.scopeHash !== await hashApprovalScope(expectedScope)) {
    if (row.revision !== expected.revision) throw new ApprovalStoreError("approval_revision_mismatch", "Approval receipt revision is stale")
    throw new ApprovalStoreError("approval_scope_mismatch", "Approval receipt scope does not match the requested action")
  }
  return actual
}

export async function issueApprovalReceipt(db: PrismaClient, input: IssueApprovalReceiptInput & ReceiptIssueOwnerInput): Promise<ApprovalReceiptResult> {
  assertScopeInput(input.scope)
  const nonce = input.nonce ?? createApprovalNonce()
  const nonceHash = await hashApprovalNonce(nonce)
  const approvalId = input.approvalId ?? randomUUID()

  try {
    const row = await db.$transaction(async (tx) => {
      const { prepared, receiptScope } = await prepareReceiptIssueInTransaction(tx, input)
      const scope = protocolScope(receiptScope, nonceHash)
      const scopeHash = await hashApprovalScope(scope)
      const taskId = prepared?.taskId ?? input.taskId ?? null
      const payload = prepared?.payload ?? input.payload
      const job = await tx.job.findFirst({ where: { id: receiptScope.jobId, userId: receiptScope.userId }, select: { id: true } })
      if (!job) throw new ApprovalStoreError("approval_scope_mismatch", "Approval job is not owned by the user")
      const created = await tx.agentApproval.create({
        data: {
          id: approvalId, sessionId: receiptScope.sessionId, taskId, userId: receiptScope.userId,
          turnId: receiptScope.turnId, toolCallId: receiptScope.toolCallId, jobId: receiptScope.jobId, type: receiptScope.action,
          status: "pending", title: input.title, body: input.body,
          impact: input.impact === undefined ? undefined : input.impact === null ? Prisma.JsonNull : input.impact,
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
    if (isUniqueViolation(error)) throw new ApprovalStoreError("approval_reservation_conflict", "Approval nonce or id is already in use")
    throw error
  }
}

export async function validateApproval(db: PrismaClient, id: string, expected: ApprovalScopeMatch, now = new Date()): Promise<AgentApproval> {
  assertScopeInput(expected)
  const row = await loadApproval(db, id, expected.userId)
  await assertScope(row, expected, now)
  return mapApproval(row)
}

export async function validatePendingApprovalReceipt(db: PrismaClient, id: string, expected: ApprovalScopeMatch, now = new Date()): Promise<AgentApproval> {
  assertScopeInput(expected)
  const row = await loadApproval(db, id, expected.userId)
  await assertPendingScope(row, expected, now)
  return mapApproval(row)
}

export async function resolveApproval(db: PrismaClient, input: { id: string; userId: string; sessionId: string; decision: ApprovalDecision; now?: Date }): Promise<void> {
  const now = input.now ?? new Date()
  await db.$transaction(async (tx) => {
    const row = await resolvePendingApprovalInTransaction(tx, { ...input, now })
    await appendAgentEventWithOutboxInTransaction(tx, {
      sessionId: input.sessionId, turnId: row.turnId, itemId: null, taskId: row.taskId,
      type: "approval.resolved", actor: "user", correlationId: input.id, causationId: null,
      idempotencyKey: `approval:${input.id}:resolved:${input.decision}`,
      payload: auditPayload(input.id, row.type, row.scopeHash ?? "legacy", row.revision), outboxTopic: "agent.session.event",
    })
  })
}

export async function consumeApproval(db: PrismaClient, id: string, expected: ApprovalScopeMatch, now = new Date()): Promise<ApprovalConsumeResult> {
  return consumeApprovalAndReserve(db, id, expected, null, now)
}

export async function consumeApprovalAndReserve(
  db: PrismaClient,
  id: string,
  expected: ApprovalScopeMatch,
  reservation: ApprovalReservationInput | null,
  now = new Date(),
): Promise<ApprovalConsumeResult> {
  assertScopeInput(expected)
  try {
    return await db.$transaction(async (tx) => {
      const row = await loadApproval(tx, id, expected.userId)
      const scope = await assertScope(row, expected, now)
      await assertApprovalFreshnessInTransaction(tx, { id: row.id, sessionId: row.sessionId, turnId: scope.turnId, userId: expected.userId })
      const updated = await tx.agentApproval.updateMany({
        where: { id, userId: expected.userId, status: "approved", revision: expected.revision, scopeHash: row.scopeHash, nonceHash: row.nonceHash, expiresAt: { gt: now } },
        data: { status: "consumed", consumedAt: now },
      })
      if (updated.count !== 1) throw new ApprovalStoreError("approval_already_consumed", "Approval receipt was consumed by another request")
      const created = reservation
        ? await tx.agentActionReservation.create({ data: {
            id: randomUUID(), approvalId: id, userId: expected.userId, sessionId: scope.sessionId, turnId: scope.turnId, jobId: scope.jobId,
            toolCallId: scope.toolCallId, action: scope.action, resourceHash: scope.resourceHash, idempotencyKey: reservation.idempotencyKey, status: "reserved",
          } })
        : null
      await appendAgentEventWithOutboxInTransaction(tx, {
        sessionId: scope.sessionId, turnId: scope.turnId, itemId: null, taskId: row.taskId, type: "approval.consumed", actor: "system",
        correlationId: id, causationId: null, idempotencyKey: `approval:${id}:consumed`, payload: auditPayload(id, scope.action, row.scopeHash as string, scope.revision), outboxTopic: "agent.session.event",
      })
      if (created) await appendAgentEventWithOutboxInTransaction(tx, {
        sessionId: scope.sessionId, turnId: scope.turnId, itemId: null, taskId: row.taskId, type: "external_action.reserved", actor: "system",
        correlationId: id, causationId: null, idempotencyKey: `reservation:${created.idempotencyKey}:reserved`,
        payload: { approvalId: id, reservationId: created.id, action: scope.action, resourceHash: scope.resourceHash }, outboxTopic: "agent.session.event",
      })
      return { approvalId: id, reservationId: created?.id ?? null, consumedAt: now }
    })
  } catch (error: unknown) {
    if (isUniqueViolation(error)) throw new ApprovalStoreError("approval_reservation_conflict", "External action reservation already exists")
    throw error
  }
}
