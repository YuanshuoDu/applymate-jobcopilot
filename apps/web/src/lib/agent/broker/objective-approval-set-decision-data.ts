import { Prisma } from "@prisma/client"
import { hashApprovalScope, isApprovalHash, parseObjectiveApplicationApprovalSet, type ObjectiveApplicationApprovalSet } from "@jobcopilot/agent-protocol"
import { parseObjectiveApplicationResumeWitness, type ObjectiveApplicationResumeWitness } from "@jobcopilot/shared"

import { protocolScope } from "../approval/types"
import { waitScopeMismatch } from "./errors"

type Tx = Prisma.TransactionClient
type Input = Readonly<{ userId: string; sessionId: string; expectedTurnId: string; approvalId: string }>
type JsonRecord = Record<string, unknown>
export type ObjectiveApprovalSetMemberEnvelope = Readonly<{
  schema: "objective-application-approval-set-member.v1"; setId: string; sourceTurnId: string; slotOrdinal: number; proof: JsonRecord
}>
export type ObjectiveApprovalSetMember = Readonly<{
  approvalId: string; taskId: string | null; userId: string; sessionId: string; turnId: string; jobId: string
  toolCallId: string; scopeHash: string; revision: number; expiresAt: Date; proof: JsonRecord; resumeWitness: ObjectiveApplicationResumeWitness
}>
export type LoadedObjectiveApprovalSetMember = Readonly<{
  slotOrdinal: number; row: Prisma.AgentApprovalGetPayload<{}>; member: ObjectiveApprovalSetMember
}>

const MEMBER_SCHEMA = "objective-application-approval-set-member.v1"

function record(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    for (const key of keys) {
      const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : undefined
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null
    }
    return value as JsonRecord
  } catch { return null }
}

export function parseObjectiveApprovalSetMemberEnvelope(value: unknown): ObjectiveApprovalSetMemberEnvelope | null {
  const row = record(value)
  if (!row || Reflect.ownKeys(row).length !== 5 || row.schema !== MEMBER_SCHEMA
    || typeof row.setId !== "string" || !row.setId.trim() || typeof row.sourceTurnId !== "string" || !row.sourceTurnId.trim()
    || !Number.isSafeInteger(row.slotOrdinal) || Number(row.slotOrdinal) < 1 || Number(row.slotOrdinal) > 8) return null
  const proof = record(row.proof)
  return proof && Object.hasOwn(proof, "resumeWitness")
    ? row as unknown as ObjectiveApprovalSetMemberEnvelope : null
}

async function validScopeHash(row: Prisma.AgentApprovalGetPayload<{}>): Promise<boolean> {
  if (!row.scopeHash || !isApprovalHash(row.scopeHash) || !row.nonceHash || !isApprovalHash(row.nonceHash)
    || !row.resourceHash || !isApprovalHash(row.resourceHash) || !row.materialHash || !isApprovalHash(row.materialHash)
    || !row.answersHash || !isApprovalHash(row.answersHash) || row.jobId === null || row.toolCallId === null || row.expiresAt === null) return false
  const userId = row.userId, sessionId = row.sessionId, turnId = row.turnId
  const jobId = row.jobId, toolCallId = row.toolCallId
  if (typeof userId !== "string" || typeof sessionId !== "string" || typeof turnId !== "string"
    || typeof jobId !== "string" || typeof toolCallId !== "string" || !(row.expiresAt instanceof Date)) return false
  return row.scopeHash === await hashApprovalScope(protocolScope({
    userId, sessionId, turnId, jobId, toolCallId,
    action: "review_application", resourceHash: row.resourceHash, materialHash: row.materialHash,
    answersHash: row.answersHash, revision: row.revision, expiresAt: row.expiresAt,
  }, row.nonceHash))
}

/** Locks and proves the complete set membership before any member decision is applied. */
export async function loadLockedObjectiveApprovalSetMembers(
  tx: Tx,
  input: Input,
  approvalSet: ObjectiveApplicationApprovalSet,
): Promise<readonly LoadedObjectiveApprovalSetMember[]> {
  const ids = approvalSet.members.map(member => member.approvalId).sort()
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "agent_approvals" WHERE "sessionId" = ${input.sessionId} AND "turnId" = ${input.expectedTurnId}
      AND "userId" = ${input.userId} AND "type" = 'review_application'
      AND ("id" = ANY(${ids}::text[]) OR "payload" ->> 'setId' = ${approvalSet.setId}) ORDER BY "id" FOR UPDATE
  `)
  const lockedIds = locked.map(row => row.id).sort()
  if (lockedIds.length !== ids.length || ids.some((id, index) => lockedIds[index] !== id)) return failClosed()
  const rows = await tx.agentApproval.findMany({
    where: { id: { in: ids }, userId: input.userId, sessionId: input.sessionId, turnId: input.expectedTurnId }, orderBy: { id: "asc" },
  })
  if (rows.length !== ids.length) return failClosed()
  const byId = new Map(rows.map(row => [row.id, row])), jobs = new Set<string>(), calls = new Set<string>()
  const result: LoadedObjectiveApprovalSetMember[] = []
  for (const expected of approvalSet.members) {
    const row = byId.get(expected.approvalId), envelope = row && parseObjectiveApprovalSetMemberEnvelope(row.payload)
    const witness = envelope && parseObjectiveApplicationResumeWitness(envelope.proof.resumeWitness)
    if (!row || !envelope || !witness || envelope.setId !== approvalSet.setId || envelope.sourceTurnId !== approvalSet.sourceTurnId
      || envelope.slotOrdinal !== expected.slotOrdinal || row.id !== expected.approvalId || row.userId !== input.userId
      || row.sessionId !== input.sessionId || row.turnId !== input.expectedTurnId || row.type !== "review_application"
      || row.jobId === null || row.toolCallId === null || row.expiresAt === null || !Number.isSafeInteger(row.revision)
      || row.revision < 0 || row.expiresAt.toISOString() !== approvalSet.expiresAt || !["pending", "approved", "rejected", "expired"].includes(row.status)
      || witness.userId !== row.userId || witness.jobId !== row.jobId || jobs.has(row.jobId) || calls.has(row.toolCallId)
      || !await validScopeHash(row)) return failClosed()
    jobs.add(row.jobId); calls.add(row.toolCallId)
    result.push({ slotOrdinal: expected.slotOrdinal, row, member: {
      approvalId: row.id, taskId: row.taskId, userId: row.userId, sessionId: row.sessionId, turnId: row.turnId,
      jobId: row.jobId, toolCallId: row.toolCallId, scopeHash: row.scopeHash!, revision: row.revision,
      expiresAt: row.expiresAt, proof: envelope.proof, resumeWitness: witness,
    } })
  }
  return result
}

function failClosed(): never { throw waitScopeMismatch() }
