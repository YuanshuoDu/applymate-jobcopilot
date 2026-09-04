import { isApprovalHash, type AgentApproval, type ApprovalScope, type ApprovalType } from "@jobcopilot/agent-protocol"

export interface ApprovalScopeInput {
  userId: string
  sessionId: string
  turnId: string
  jobId: string
  toolCallId: string
  action: ApprovalType
  resourceHash: string
  materialHash: string
  answersHash: string
  revision: number
  expiresAt: Date
}

export interface IssueApprovalReceiptInput {
  approvalId?: string
  taskId?: string | null
  scope: ApprovalScopeInput
  title: string
  body: string
  impact?: unknown
  payload: unknown
  nonce?: string
  projectWait?: boolean
}

export interface ApprovalScopeMatch extends ApprovalScopeInput { nonce: string }
export interface ApprovalReservationInput { idempotencyKey: string }
export type ApprovalDecision = "approved" | "rejected"

export interface ApprovalReceiptResult { approval: AgentApproval; nonce: string }
export interface ApprovalConsumeResult { approvalId: string; reservationId: string | null; consumedAt: Date }

export type ApprovalStoreErrorCode =
  | "approval_not_found" | "approval_scope_mismatch" | "approval_integrity_error" | "approval_expired"
  | "approval_not_approved" | "approval_already_consumed" | "approval_nonce_mismatch"
  | "approval_revision_mismatch" | "approval_reservation_conflict"

export class ApprovalStoreError extends Error {
  constructor(readonly code: ApprovalStoreErrorCode, message: string) {
    super(message)
    this.name = "ApprovalStoreError"
  }
}

export function protocolScope(input: ApprovalScopeInput, nonceHash: string): ApprovalScope {
  return {
    userId: input.userId, sessionId: input.sessionId, turnId: input.turnId, jobId: input.jobId, toolCallId: input.toolCallId,
    action: input.action, resourceHash: input.resourceHash, materialHash: input.materialHash, answersHash: input.answersHash,
    revision: input.revision, nonceHash, expiresAt: input.expiresAt.toISOString(),
  }
}

export function assertScopeInput(input: ApprovalScopeInput): void {
  const values = [input.userId, input.sessionId, input.turnId, input.jobId, input.toolCallId]
  if (values.some((value) => !value.trim()) || !Number.isInteger(input.revision) || input.revision < 0) {
    throw new ApprovalStoreError("approval_scope_mismatch", "Approval receipt scope is incomplete")
  }
  if (![input.resourceHash, input.materialHash, input.answersHash].every(isApprovalHash)) {
    throw new ApprovalStoreError("approval_scope_mismatch", "Approval receipt hashes are invalid")
  }
  if (Number.isNaN(input.expiresAt.getTime()) || input.expiresAt <= new Date()) {
    throw new ApprovalStoreError("approval_expired", "Approval receipt expiry must be in the future")
  }
}
