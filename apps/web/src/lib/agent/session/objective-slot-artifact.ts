import { createHash } from "node:crypto"
import type { Prisma } from "@prisma/client"
import { hashArtifactContent } from "../artifacts/hash"
import { validObjectiveApplicationSourceManifest } from "../broker/objective-application-review-source-proof"
import { readObjectiveJourneyProofContext, readObjectiveJourneyReadySlot, type ObjectiveJourneyProofContext, type ObjectiveJourneyReadySlotProof } from "./objective-journey-report-source"
import { OBJECTIVE_SLOT_REVIEWER_RECEIPT_SCHEMA, type ObjectiveSlotReviewerReceipt } from "./objective-slot-reviewer-receipt-contract"

export const OBJECTIVE_SLOT_ARTIFACT_SCHEMA = "agent-harness.v2.objective-slot-artifact.v1" as const
type Tx = Prisma.TransactionClient
type Ref = Readonly<{ artifactId: string; version: number; contentHash: string; sourceDigest: string }>
type Input = Readonly<{ userId: string; sessionId: string; finalItemId: string; graphRevision: number; slotOrdinal: number }>
type Row = Record<string, unknown>
export type ObjectiveSlotArtifactEvidence = Readonly<{ schemaVersion: typeof OBJECTIVE_SLOT_ARTIFACT_SCHEMA; graphRevision: number; slotOrdinal: number; artifactRef: Ref }>
const MAX_DRAFT_LENGTH = 20_000

/** Revalidates one ready Objective slot and returns only its immutable viewer reference. */
export async function readObjectiveSlotArtifactEvidence(tx: Tx, input: Input): Promise<ObjectiveSlotArtifactEvidence | null> {
  try {
    const proof = await readVerifiedSlot(tx, input)
    return proof ? { schemaVersion: OBJECTIVE_SLOT_ARTIFACT_SCHEMA, graphRevision: proof.context.graphRevision,
      slotOrdinal: input.slotOrdinal, artifactRef: proof.slot.artifactRef } : null
  } catch { return null }
}

/** Revalidates the persisted Reviewer receipt for the exact effective slot. */
export async function readObjectiveSlotReviewerReceiptEvidence(tx: Tx, input: Input): Promise<ObjectiveSlotReviewerReceipt | null> {
  try {
    const proof = await readVerifiedSlot(tx, input)
    if (!proof) return null
    return { schemaVersion: OBJECTIVE_SLOT_REVIEWER_RECEIPT_SCHEMA, graphRevision: proof.context.graphRevision,
      slotOrdinal: input.slotOrdinal, artifactVersion: proof.slot.artifactRef.version, outcome: "passed",
      receiptKey: receiptKey(proof.context, proof.slot, proof.version, proof.review) }
  } catch { return null }
}

type VerifiedSlot = Readonly<{ context: ObjectiveJourneyProofContext; slot: ObjectiveJourneyReadySlotProof; version: Row; review: Row }>

async function readVerifiedSlot(tx: Tx, input: Input): Promise<VerifiedSlot | null> {
  if (![input.userId, input.sessionId, input.finalItemId].every(id) || !positive(input.graphRevision) || !positive(input.slotOrdinal)) return null
  const context = await readObjectiveJourneyProofContext(tx, input, input.graphRevision)
  if (!context || !validObjectiveApplicationSourceManifest(context.manifest, input.finalItemId, context.progress, context.tasks)) return null
  const slot = readObjectiveJourneyReadySlot(context, input.slotOrdinal)
  if (!slot) return null
  const jobs = await tx.job.findMany({ where: { id: slot.jobId, userId: input.userId }, take: 2, select: { id: true, userId: true } })
  if (jobs.length !== 1 || jobs[0]?.id !== slot.jobId || jobs[0]?.userId !== input.userId) return null
  const writer = context.tasks.get(slot.writerTaskId), reviewer = context.tasks.get(slot.reviewerTaskId)
  if (!taskScope(writer, slot.writerTaskId, context, "writer", "cover_letter_draft")
    || !taskScope(reviewer, slot.reviewerTaskId, context, "reviewer", "cover_letter_review")) return null
  const version = await readVersion(tx, input, slot.jobId, slot.writerTaskId, slot.artifactRef)
  const review = version && await readReview(tx, input, slot.jobId, slot.reviewerTaskId, slot.artifactRef, slot.reviewHash, version.id as string, "passed")
  if (!version || !review || slot.prior && !await verifyCorrection(tx, input, slot, version)) return null
  return { context, slot, version, review }
}

async function verifyCorrection(tx: Tx, input: Input, slot: ObjectiveJourneyReadySlotProof, current: Row): Promise<boolean> {
  const prior = slot.prior
  if (!prior || current.previousHash !== prior.artifactRef.contentHash || current.artifactId !== prior.artifactRef.artifactId
    || current.version !== prior.artifactRef.version + 1 || current.sourceDigest !== prior.artifactRef.sourceDigest) return false
  const version = await readVersion(tx, input, slot.jobId, prior.writerTaskId, prior.artifactRef)
  return !!version && !!await readReview(tx, input, slot.jobId, prior.reviewerTaskId, prior.artifactRef, prior.reviewHash, version.id as string, "needs_revision", prior.toolCallId)
}

async function readVersion(tx: Tx, input: Input, jobId: string, taskId: string, ref: Ref): Promise<Row | null> {
  const rows = await tx.agentArtifactVersion.findMany({ where: { userId: input.userId, sessionId: input.sessionId, jobId,
    artifactId: ref.artifactId, version: ref.version, artifactType: "cover_letter", taskId, contentHash: ref.contentHash, sourceDigest: ref.sourceDigest }, take: 2,
    select: { id: true, artifactId: true, version: true, userId: true, sessionId: true, jobId: true, artifactType: true,
      content: true, contentHash: true, sourceDigest: true, previousHash: true, taskId: true } }) as unknown[]
  const row = rows.length === 1 ? record(rows[0]) : null
  if (!row || typeof row.content !== "string" || row.content.length > MAX_DRAFT_LENGTH || !id(row.id) || row.artifactId !== ref.artifactId || row.version !== ref.version || row.userId !== input.userId
    || row.sessionId !== input.sessionId || row.jobId !== jobId || row.artifactType !== "cover_letter" || row.taskId !== taskId
    || row.contentHash !== ref.contentHash || row.sourceDigest !== ref.sourceDigest || hashArtifactContent(row.content) !== ref.contentHash) return null
  return row
}

async function readReview(tx: Tx, input: Input, jobId: string, taskId: string, ref: Ref, reviewHash: string, versionId: string,
  status: "passed" | "needs_revision", toolCallId?: string): Promise<Row | null> {
  const rows = await tx.agentArtifactReview.findMany({ where: { artifactVersionId: versionId, userId: input.userId, sessionId: input.sessionId,
    jobId, taskId, artifactId: ref.artifactId, version: ref.version, contentHash: ref.contentHash, sourceDigest: ref.sourceDigest,
    currentSourceDigest: ref.sourceDigest, status, reviewHash, ...(toolCallId ? { toolCallId } : {}) }, take: 2,
    select: { artifactVersionId: true, userId: true, sessionId: true, jobId: true, taskId: true, artifactId: true, version: true,
      contentHash: true, sourceDigest: true, currentSourceDigest: true, status: true, reviewHash: true, toolCallId: true } }) as unknown[]
  const row = rows.length === 1 ? record(rows[0]) : null
  return row && row.artifactVersionId === versionId && row.userId === input.userId && row.sessionId === input.sessionId
    && row.jobId === jobId && row.taskId === taskId && row.artifactId === ref.artifactId && row.version === ref.version
    && row.contentHash === ref.contentHash && row.sourceDigest === ref.sourceDigest && row.currentSourceDigest === ref.sourceDigest
    && row.status === status && row.reviewHash === reviewHash && id(row.toolCallId) && (!toolCallId || row.toolCallId === toolCallId) ? row : null
}

function receiptKey(context: { userId: string; sessionId: string; sourceTurnId: string; rootTaskId: string; finalItemId: string; graphRevision: number },
  slot: ObjectiveJourneyReadySlotProof, version: Row, review: Row): string {
  const material = JSON.stringify(["agent-harness.v2.objective-slot-reviewer-receipt", context.userId, context.sessionId,
    context.finalItemId, context.sourceTurnId, context.rootTaskId, context.graphRevision, slot.ordinal, slot.jobId,
    slot.writerTaskId, slot.reviewerTaskId, version.id, slot.artifactRef.artifactId, slot.artifactRef.version,
    slot.artifactRef.contentHash, slot.artifactRef.sourceDigest, review.artifactVersionId, review.toolCallId, review.status, review.reviewHash])
  return `review-${createHash("sha256").update(material).digest("hex")}`
}

function taskScope(value: unknown, taskId: string, context: { userId: string; sessionId: string; sourceTurnId: string; rootTaskId: string }, role: string, taskType: string): boolean {
  const row = record(value)
  return !!row && row.id === taskId && (row.userId === undefined || row.userId === context.userId) && row.sessionId === context.sessionId && row.turnId === context.sourceTurnId
    && row.rootTaskId === context.rootTaskId && row.parentTaskId === context.rootTaskId && row.role === role && row.taskType === taskType && row.status === "completed"
}

function record(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try { const keys = Reflect.ownKeys(value); return (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && keys.every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(value, key)?.enumerable
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value")) ? value as Row : undefined } catch { return undefined }
}
function id(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value) && value.trim() === value }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
