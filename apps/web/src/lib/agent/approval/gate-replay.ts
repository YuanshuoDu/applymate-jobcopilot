import { Prisma } from "@prisma/client"
import {
  hashApprovalNonce,
  hashApprovalScope,
  schemaVersion,
  type AgentApproval,
  type ApprovalScope,
  type ApprovalType,
} from "@jobcopilot/agent-protocol"

import { AgentExecutionCancelledError, refreshAgentExecutionAttempt } from "../execution-control"
import { lockOpenSession } from "../session/v2-turn"
import type { ScheduledTaskGraphPipelineOwner } from "../scheduled-taskgraph-pipeline-checkpoint"
import type { ReceiptIssueOwnerInput } from "./receipt-issue-owner"
import {
  ApprovalStoreError,
  protocolScope,
  type ApprovalReceiptResult,
  type ApprovalScopeInput,
  type IssueApprovalReceiptInput,
} from "./types"

type ApprovalRow = Prisma.AgentApprovalGetPayload<{}>

export type ScheduledGateReplayOwnerFence = {
  owner: ScheduledTaskGraphPipelineOwner
  key: string
  claimToken: string
  assertCurrent: (tx: Prisma.TransactionClient) => Promise<boolean>
}

export type ReplayReceiptExpectation = {
  approvalId: string
  nonce: string
  nonceHash: string
  scope: ApprovalScopeInput
  taskId: string | null
  taskPayloadField?: string
  title: string
  body: string
  impact: unknown
  payload: unknown
}

type ReplayTaskReader = {
  applicationTask: {
    findFirst(args: Prisma.ApplicationTaskFindFirstArgs): Promise<{ id: string } | null>
  }
}

export type ReplayOwnerInput = Pick<IssueApprovalReceiptInput, "scope">
  & Pick<ReceiptIssueOwnerInput, "executionAttempt" | "signal">
  & { scheduledOwnerFence?: ScheduledGateReplayOwnerFence }

const ACTIVE_ISSUE_TURN_STATUSES = ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] as const

export function scopeFromRow(row: ApprovalRow): ApprovalScope {
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

function stableJson(value: unknown): string {
  if (value === null) return "null"
  if (typeof value !== "object") return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`
}

export function mapReplayApproval(row: ApprovalRow, scope: ApprovalScope): AgentApproval {
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

export async function recoverGateReviewReplay(
  row: ApprovalRow,
  expected: ReplayReceiptExpectation,
  now: Date,
): Promise<ApprovalReceiptResult> {
  if (row.id !== expected.approvalId || row.userId !== expected.scope.userId) {
    throw new ApprovalStoreError("approval_scope_mismatch", "Approval replay does not match the issued receipt")
  }
  const actual = scopeFromRow(row)
  if (row.scopeHash !== await hashApprovalScope(actual)) {
    throw new ApprovalStoreError("approval_integrity_error", "Approval replay scope integrity check failed")
  }
  if (row.nonceHash !== expected.nonceHash) {
    throw new ApprovalStoreError("approval_nonce_mismatch", "Approval replay nonce does not match")
  }
  const scope = expected.scope
  const expectedPayload = expected.taskPayloadField
    ? withTaskPayloadField(expected.payload, expected.taskPayloadField, row.taskId)
    : expected.payload
  if (actual.userId !== scope.userId
    || actual.sessionId !== scope.sessionId
    || actual.turnId !== scope.turnId
    || actual.jobId !== scope.jobId
    || actual.toolCallId !== scope.toolCallId
    || actual.action !== scope.action
    || actual.resourceHash !== scope.resourceHash
    || actual.materialHash !== scope.materialHash
    || actual.answersHash !== scope.answersHash
    || row.type !== scope.action
    || (!expected.taskPayloadField && row.taskId !== expected.taskId)
    || row.title !== expected.title
    || row.body !== expected.body
    || stableJson(row.impact) !== stableJson(expected.impact)
    || stableJson(row.payload) !== stableJson(expectedPayload)) {
    throw new ApprovalStoreError("approval_scope_mismatch", "Approval replay content or scope changed")
  }
  if (!row.expiresAt || row.expiresAt <= now) throw new ApprovalStoreError("approval_expired", "Approval replay receipt has expired")
  if (row.status === "consumed") throw new ApprovalStoreError("approval_already_consumed", "Approval replay receipt has already been consumed")
  if (row.status === "rejected") throw new ApprovalStoreError("approval_not_approved", "Approval replay receipt was rejected")
  if (row.status !== "pending" && row.status !== "approved") {
    throw new ApprovalStoreError("approval_integrity_error", "Approval replay receipt has an invalid status")
  }
  if ((row.status === "pending" && (row.decidedAt !== null || row.consumedAt !== null))
    || (row.status === "approved" && (!row.decidedAt || row.consumedAt !== null))) {
    throw new ApprovalStoreError("approval_integrity_error", "Approval replay receipt status metadata is inconsistent")
  }
  return { approval: mapReplayApproval(row, actual), nonce: expected.nonce }
}

function withTaskPayloadField(payload: unknown, field: string, taskId: string | null): unknown {
  if (!taskId || payload === null || typeof payload !== "object" || Array.isArray(payload)) return null
  return { ...(payload as Record<string, unknown>), [field]: taskId }
}

export async function assertGateReplayTaskBinding(
  reader: ReplayTaskReader,
  row: ApprovalRow,
  expected: ReplayReceiptExpectation,
): Promise<void> {
  if (!expected.taskPayloadField) return
  if (!row.taskId || withTaskPayloadField(expected.payload, expected.taskPayloadField, row.taskId) === null) {
    throw new ApprovalStoreError("approval_scope_mismatch", "Approval replay task binding is incomplete")
  }
  const payload = row.payload
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)
    || (payload as Record<string, unknown>)[expected.taskPayloadField] !== row.taskId) {
    throw new ApprovalStoreError("approval_scope_mismatch", "Approval replay task payload does not match its task")
  }
  const task = await reader.applicationTask.findFirst({
    where: { id: row.taskId, userId: expected.scope.userId, jobId: expected.scope.jobId, sessionId: expected.scope.sessionId },
    select: { id: true },
  })
  if (!task) throw new ApprovalStoreError("approval_scope_mismatch", "Approval replay task is not owned by the receipt scope")
}

export async function assertGateReplayOwnerInTransaction(
  tx: Prisma.TransactionClient,
  input: ReplayOwnerInput,
): Promise<void> {
  if (input.signal?.aborted) throw new AgentExecutionCancelledError()
  await lockOpenSession(tx, { sessionId: input.scope.sessionId, userId: input.scope.userId })
  if (input.scheduledOwnerFence) {
    if (!await input.scheduledOwnerFence.assertCurrent(tx)) throw new AgentExecutionCancelledError()
  } else {
    const turns = await tx.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
      SELECT "id", "status" FROM "agent_turns"
      WHERE "id" = ${input.scope.turnId} AND "sessionId" = ${input.scope.sessionId} AND "userId" = ${input.scope.userId}
      FOR UPDATE
    `)
    const turn = turns[0]
    if (!turn || !ACTIVE_ISSUE_TURN_STATUSES.includes(turn.status as (typeof ACTIVE_ISSUE_TURN_STATUSES)[number])) {
      throw new ApprovalStoreError("approval_scope_mismatch", "Approval turn is no longer active")
    }
  }
  if (input.signal?.aborted) throw new AgentExecutionCancelledError()
  if (!input.executionAttempt || !await refreshAgentExecutionAttempt(tx, { ...input.executionAttempt, userId: input.scope.userId })) {
    throw new AgentExecutionCancelledError()
  }
  if (input.signal?.aborted) throw new AgentExecutionCancelledError()
}
