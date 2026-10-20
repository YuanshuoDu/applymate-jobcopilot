import { createHmac } from "node:crypto"
import type { Prisma } from "@prisma/client"
import { hashApprovalNonce, hashApprovalScope, isApprovalHash } from "@jobcopilot/agent-protocol"
import { hashAgentReceiptValue } from "@jobcopilot/shared"
import type { ScheduledTaskGraphPipelineOwner } from "./scheduled-taskgraph-pipeline-checkpoint"
import { protocolScope } from "./approval/types"

const CLAIM_SCHEMA = "agent-harness.v2.scheduled-pipeline-claim.v1"
const CONTINUATION_SCHEMA = "agent-harness.v2.scheduled-pipeline-continuation.v1"
const ALLOWED_CHECKPOINTS = new Set(["gate", "execute", "audit", "completed"])
const OWNER_KEYS = ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "turnLeaseOwnerId", "turnLeaseVersion", "executionId", "executionAttemptCount"]
const CLAIM_KEYS = ["schemaVersion", "key", "claimToken", "owner", "claimedAt", "leaseExpiresAt"]
const CONTINUATION_KEYS = ["schemaVersion", "key", "owner", "snapshotDigest", "graphRevision", "evidenceDigest"]

type ProofReader = Pick<Prisma.TransactionClient, "agentApproval" | "agentItem">

export async function hasScheduledTaskGraphGateProof(input: {
  reader: ProofReader
  owner: ScheduledTaskGraphPipelineOwner
  key: string
  claimToken: string
  executionStatus: string
  checkpoint: string
  state: unknown
  now?: Date
}): Promise<boolean> {
  if (!validCheckpoint(input) || !validOwner(input.owner)) return false
  // Bound the read to this Turn; Gate replay's ID lookup rejects rows whose turn/session metadata is corrupted.
  const approvals = await input.reader.agentApproval.findMany({
    where: { turnId: input.owner.turnId },
    select: {
      id: true, userId: true, sessionId: true, turnId: true, toolCallId: true, jobId: true, type: true, status: true,
      title: true, body: true, impact: true, payload: true, resourceHash: true, materialHash: true, answersHash: true,
      scopeHash: true, nonceHash: true, revision: true, expiresAt: true, decidedAt: true, consumedAt: true,
    },
  })
  let foundCurrentAttemptReceipt = false
  let foundCanonicalWaitItem = false
  for (const approval of approvals) {
    if (!receiptAttemptCoordinatesMatch(approval, input.owner)) continue
    foundCurrentAttemptReceipt = true
    const waitItem = await input.reader.agentItem.findFirst({
      where: { id: `agent-wait:approval:${approval.id}` },
      select: { id: true, sessionId: true, turnId: true, type: true, status: true, revision: true, content: true, startedAt: true, completedAt: true },
    })
    if (!await receiptProofIsValid({ owner: input.owner, approval, now: input.now })) return false
    if (waitItem === null || waitItem === undefined) {
      if (objectRow(approval)?.status !== "pending") return false
      continue
    }
    foundCanonicalWaitItem = true
    if (!waitItemIsValid(approval, waitItem)) return false
  }
  return foundCurrentAttemptReceipt && foundCanonicalWaitItem
}

export async function scheduledTaskGraphGateProofIsValid(input: {
  owner: ScheduledTaskGraphPipelineOwner
  key: string
  claimToken: string
  executionStatus: string
  checkpoint: string
  state: unknown
  approval: unknown
  waitItem: unknown
  now?: Date
}): Promise<boolean> {
  return validCheckpoint(input) && validOwner(input.owner)
    && await receiptProofIsValid({ owner: input.owner, approval: input.approval, now: input.now })
    && waitItemIsValid(input.approval, input.waitItem)
}

async function receiptProofIsValid(input: {
  owner: ScheduledTaskGraphPipelineOwner; approval: unknown; now?: Date
}): Promise<boolean> {
  const approval = objectRow(input.approval), now = input.now ?? new Date()
  if (!approval || !await receiptIdentityMatches(approval, input.owner, now)) return false
  const { userId, sessionId, turnId, jobId, toolCallId, type, resourceHash, materialHash, answersHash, nonceHash } = approval
  if (answersHash !== await hashAgentReceiptValue("answers", null)) return false
  const expiresAt = approval.expiresAt
  const scope = protocolScope({ userId: userId as string, sessionId: sessionId as string, turnId: turnId as string,
    jobId: jobId as string, toolCallId: toolCallId as string, action: type as "review_application",
    resourceHash: resourceHash as string, materialHash: materialHash as string, answersHash: answersHash as string,
    revision: approval.revision as number, expiresAt: expiresAt as Date }, nonceHash as string)
  if (approval.scopeHash !== await hashApprovalScope(scope) || objectRow(approval.payload)?.jobId !== jobId) return false
  if (approval.status === "pending") return approval.decidedAt === null
  return approval.status === "approved" && approval.decidedAt instanceof Date
}

function waitItemIsValid(approvalValue: unknown, itemValue: unknown): boolean {
  const approval = objectRow(approvalValue), item = objectRow(itemValue), content = objectRow(item?.content)
  if (!approval || !item || !content) return false
  const { id, sessionId, turnId, toolCallId, scopeHash, revision, title, body, impact, expiresAt } = approval
  if (item.id !== `agent-wait:approval:${id}` || item.sessionId !== sessionId || item.turnId !== turnId
    || item.type !== "approval_request" || !(item.startedAt instanceof Date) || content.waitKind !== "approval"
    || content.approvalId !== id || content.toolCallId !== toolCallId || content.action !== "review_application"
    || content.scopeHash !== scopeHash || content.receiptRevision !== revision
    || content.expiresAt !== (expiresAt as Date).toISOString() || content.title !== title || content.body !== body
    || stableJson(content.impact) !== stableJson(impact)) return false
  if (approval.status === "pending") return approval.decidedAt === null && approval.consumedAt === null
    && item.status === "started" && item.revision === 0 && item.completedAt === null && content.decision === null
    && content.responseAvailable !== true
  return approval.status === "approved" && approval.decidedAt instanceof Date && approval.consumedAt === null
    && item.status === "completed" && item.revision === 1 && item.completedAt instanceof Date
    && content.decision === "approved" && content.responseAvailable === true
    && content.respondedAt === approval.decidedAt.toISOString()
}

function validCheckpoint(input: {
  owner: ScheduledTaskGraphPipelineOwner; key: string; claimToken: string
  executionStatus: string; checkpoint: string; state: unknown
}): boolean {
  const state = objectRow(input.state), claim = objectRow(state?.scheduledTaskGraphClaim)
  const continuation = objectRow(state?.scheduledTaskGraphContinuation)
  const owner = stateOwner(claim?.owner)
  return input.executionStatus === "running" && ALLOWED_CHECKPOINTS.has(input.checkpoint)
    && state?.nextStage === input.checkpoint && owner !== null
    && exactKeys(claim, CLAIM_KEYS) && claim?.schemaVersion === CLAIM_SCHEMA && validId(claim.key)
    && claim.key === input.key && validId(claim.claimToken) && claim.claimToken === input.claimToken
    && validTimestamp(claim.claimedAt) && validTimestamp(claim.leaseExpiresAt)
    && sameOwner(owner, input.owner)
    && exactKeys(continuation, CONTINUATION_KEYS) && continuation?.schemaVersion === CONTINUATION_SCHEMA
    && continuation.key === input.key && sameOwner(stateOwner(continuation.owner), input.owner)
    && isSnapshotDigest(continuation.snapshotDigest) && positiveInteger(continuation.graphRevision)
    && isDigest(continuation.evidenceDigest)
}

function receiptAttemptCoordinatesMatch(row: unknown, owner: ScheduledTaskGraphPipelineOwner): boolean {
  const value = objectRow(row), identity = gateReceiptIdentity(value, owner)
  return Boolean(identity && (value?.id === `gate_review_${identity.derive("approval-id")}`
    || value?.toolCallId === `application-review:${identity.derive("tool-call-id")}`))
}
async function receiptIdentityMatches(row: Record<string, unknown>, owner: ScheduledTaskGraphPipelineOwner, now: Date): Promise<boolean> {
  const identity = gateReceiptIdentity(row, owner), expiresAt = row.expiresAt
  if (!identity || row.userId !== owner.userId || row.sessionId !== owner.sessionId || row.turnId !== owner.turnId
    || row.type !== "review_application" || row.id !== `gate_review_${identity.derive("approval-id")}`
    || row.toolCallId !== `application-review:${identity.derive("tool-call-id")}`
    || !isApprovalHash(row.scopeHash) || !isApprovalHash(row.nonceHash) || !safeCount(row.revision)
    || !(expiresAt instanceof Date) || !Number.isFinite(now.getTime()) || expiresAt <= now || row.consumedAt !== null
    || !["pending", "approved"].includes(String(row.status))) return false
  return row.nonceHash === await hashApprovalNonce(identity.derive("receipt-nonce"))
}
function gateReceiptIdentity(row: Record<string, unknown> | null, owner: ScheduledTaskGraphPipelineOwner) {
  const secret = process.env.AGENT_WORKER_SECRET?.trim()
  if (!secret || !row || !validId(row.jobId) || !isApprovalHash(row.resourceHash) || !isApprovalHash(row.materialHash)
    || !isApprovalHash(row.answersHash)) return null
  const identity = JSON.stringify([1, owner.userId, owner.sessionId, owner.turnId, owner.executionId, owner.executionAttemptCount,
    [owner.rootTaskId, owner.rootAttemptCount, owner.executionId, owner.executionAttemptCount],
    row.jobId, "review_application", row.resourceHash, row.materialHash, row.answersHash])
  return { derive: (label: string) => createHmac("sha256", secret)
    .update(`applymate.gate-review-replay.v1:${label}\0${identity}`).digest("hex") }
}

function stateOwner(value: unknown): ScheduledTaskGraphPipelineOwner | null {
  const row = objectRow(value)
  if (!row || !exactKeys(row, OWNER_KEYS) || !OWNER_KEYS.every(key => Object.hasOwn(row, key))) return null
  return row as unknown as ScheduledTaskGraphPipelineOwner
}
function validOwner(owner: ScheduledTaskGraphPipelineOwner): boolean {
  return [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.turnLeaseOwnerId, owner.executionId].every(validId)
    && positiveInteger(owner.rootAttemptCount) && positiveInteger(owner.turnLeaseVersion)
    && Number.isSafeInteger(owner.executionAttemptCount) && owner.executionAttemptCount >= 0
}
function sameOwner(actual: ScheduledTaskGraphPipelineOwner | null, expected: ScheduledTaskGraphPipelineOwner): boolean {
  return Boolean(actual && OWNER_KEYS.every(key => actual[key as keyof ScheduledTaskGraphPipelineOwner] === expected[key as keyof ScheduledTaskGraphPipelineOwner]))
}
function exactKeys(row: Record<string, unknown> | null, keys: string[]): boolean {
  return Boolean(row && Object.keys(row).sort().join(",") === [...keys].sort().join(","))
}
function objectRow(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`
}
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
function safeCount(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function positiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function validTimestamp(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)) }
function isDigest(value: unknown): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) }
function isSnapshotDigest(value: unknown): boolean { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value) }
