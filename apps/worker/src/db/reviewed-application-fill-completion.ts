import type { PoolClient } from "pg"
import {
  bindReviewedApplicationSubmissionMaterial, hashReviewedApplicationMaterialProof,
  type LegacyApplicationSubmissionMaterial,
  type ReviewedApplicationMaterialProof, type ReviewedApplicationSubmissionMaterial,
} from "@jobcopilot/shared"
import type { SelectedJobReviewedArtifact } from "../runtime/selected-job-reviewed-artifact-read.js"
import type { SubagentLease } from "../runtime/subagents/types.js"

const READBACK_SCHEMA = "agent-harness.v2.reviewed-application-fill-readback.v1"
const BINDING_SCHEMA = "agent-harness.v2.reviewed-application-fill-browser-start.v1"
const PROOF_KEYS = ["jobId", "sourceTurnId", "rootTaskId", "graphRevision", "writerTaskId", "reviewerTaskId", "reviewerToolCallId", "reviewHash", "artifactId", "version", "contentHash", "sourceDigest"] as const
const BINDING_KEYS = ["schemaVersion", "userId", "sessionId", "fillTurnId", "jobId", "applicationTaskId", "fillerTaskId", "attemptCount", "leaseOwner", "leaseExpiresAt", "sourceTurnId", "rootTaskId", "graphRevision", "writerTaskId", "reviewerTaskId", "reviewerToolCallId", "reviewHash", "artifactId", "version", "contentHash", "sourceDigest"] as const
const READBACK_KEYS = ["schemaVersion", "userId", "sessionId", "fillTurnId", "applicationTaskId", "jobId", "fillerTaskId", "attemptCount", "leaseOwner", "leaseExpiresAt", "sourceTurnId", "reviewedCoverLetterHash"] as const

type Queryable = Pick<PoolClient, "query">
type RecordValue = Record<string, unknown>
type BindingEventRow = { actor: string; data: unknown }
export type ReviewedApplicationFillReadback = Readonly<{
  schemaVersion: typeof READBACK_SCHEMA; userId: string; sessionId: string; fillTurnId: string; applicationTaskId: string; jobId: string
  fillerTaskId: string; attemptCount: number; leaseOwner: string; leaseExpiresAt: string; sourceTurnId: string; reviewedCoverLetterHash: string
}>

/** Minted only after the actual browser field has been read back and matched. */
export async function createReviewedApplicationFillReadback(
  lease: SubagentLease, applicationTaskId: string, proof: SelectedJobReviewedArtifact,
): Promise<ReviewedApplicationFillReadback | null> {
  const fields = proofProjection(proof), reviewedCoverLetterHash = await hashReviewedApplicationMaterialProof(fields)
  if (!reviewedCoverLetterHash || !lease.turnId || !validText(applicationTaskId) || !validText(lease.ownerId)
    || lease.leaseOwner !== lease.ownerId || !Number.isSafeInteger(lease.attemptCount) || lease.attemptCount < 1) return null
  return Object.freeze({ schemaVersion: READBACK_SCHEMA, userId: lease.userId, sessionId: lease.sessionId, fillTurnId: lease.turnId,
    applicationTaskId, jobId: proof.jobId, fillerTaskId: lease.id, attemptCount: lease.attemptCount, leaseOwner: lease.ownerId,
    leaseExpiresAt: lease.leaseExpiresAt.toISOString(), sourceTurnId: proof.sourceTurnId, reviewedCoverLetterHash })
}

/** Rebinds the browser-start event and current source; no historical lease is recreated. */
export async function readReviewedApplicationFillCompletionMaterial(
  client: Queryable,
  input: { lease: SubagentLease; applicationTaskId: string; jobId: string; sourceTurnId: string; legacyMaterial: LegacyApplicationSubmissionMaterial; readback?: unknown; requireCurrentAttempt: boolean },
): Promise<ReviewedApplicationSubmissionMaterial | null> {
  const { lease } = input
  if (!lease.turnId || !validText(input.applicationTaskId) || !validText(input.jobId) || !validText(input.sourceTurnId)) return null
  const { readSelectedJobReviewedArtifactWithClient } = await import("../runtime/selected-job-reviewed-artifact-read.js")
  const current = await readSelectedJobReviewedArtifactWithClient(client, {
    userId: lease.userId, sessionId: lease.sessionId, jobId: input.jobId, sourceTurnId: input.sourceTurnId,
  })
  if (!current || current.jobId !== input.jobId || current.sourceTurnId !== input.sourceTurnId) return null
  const proof = proofProjection(current)
  const material = await bindReviewedApplicationSubmissionMaterial(input.legacyMaterial, proof)
  if (!material) return null
  const events = await client.query<BindingEventRow>(`SELECT "actor", "data" FROM "application_task_events"
    WHERE "taskId"=$1 AND "type"='reviewed_application_fill_browser_started' AND "data"->>'fillTurnId'=$2 LIMIT 2`,
  [input.applicationTaskId, lease.turnId])
  if (events.rows.length !== 1 || !sameBinding(events.rows[0]!, lease, input, proof, input.requireCurrentAttempt)) return null
  if (input.requireCurrentAttempt && !sameReadback(input.readback, lease, input, material)) return null
  return material
}

function sameBinding(event: BindingEventRow, lease: SubagentLease, input: { applicationTaskId: string; jobId: string; sourceTurnId: string }, proof: ReviewedApplicationMaterialProof, currentAttempt: boolean): boolean {
  const data = exactRecord(event.data, BINDING_KEYS)
  if (!data || event.actor !== "worker" || data.schemaVersion !== BINDING_SCHEMA || data.userId !== lease.userId
    || data.sessionId !== lease.sessionId || data.fillTurnId !== lease.turnId || data.jobId !== input.jobId
    || data.applicationTaskId !== input.applicationTaskId || data.fillerTaskId !== lease.id || !Number.isSafeInteger(data.attemptCount)
    || Number(data.attemptCount) < 1 || !validText(data.leaseOwner) || !validIsoDate(data.leaseExpiresAt)) return false
  return PROOF_KEYS.every(key => data[key] === proof[key]) && (!currentAttempt
    || (data.attemptCount === lease.attemptCount && data.leaseOwner === lease.ownerId && data.leaseExpiresAt === lease.leaseExpiresAt.toISOString()))
}

function sameReadback(value: unknown, lease: SubagentLease, input: { applicationTaskId: string; jobId: string; sourceTurnId: string }, material: ReviewedApplicationSubmissionMaterial): boolean {
  const data = exactRecord(value, READBACK_KEYS)
  return Boolean(data && data.schemaVersion === READBACK_SCHEMA && data.userId === lease.userId && data.sessionId === lease.sessionId
    && data.fillTurnId === lease.turnId && data.applicationTaskId === input.applicationTaskId && data.jobId === input.jobId
    && data.fillerTaskId === lease.id && data.attemptCount === lease.attemptCount && data.leaseOwner === lease.ownerId
    && data.leaseExpiresAt === lease.leaseExpiresAt.toISOString() && data.sourceTurnId === input.sourceTurnId
    && data.reviewedCoverLetterHash === material.reviewedCoverLetterHash)
}

function proofProjection(value: SelectedJobReviewedArtifact): ReviewedApplicationMaterialProof {
  return { jobId: value.jobId, sourceTurnId: value.sourceTurnId, rootTaskId: value.rootTaskId, graphRevision: value.graphRevision,
    writerTaskId: value.writerTaskId, reviewerTaskId: value.reviewerTaskId, reviewerToolCallId: value.reviewerToolCallId,
    reviewHash: value.reviewHash, artifactId: value.artifactId, version: value.version, contentHash: value.contentHash, sourceDigest: value.sourceDigest }
}

function exactRecord(value: unknown, keys: readonly string[]): RecordValue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) return null
    for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor?.enumerable || !("value" in descriptor)) return null }
    return keys.every(key => Reflect.ownKeys(value).includes(key)) ? value as RecordValue : null
  } catch { return null }
}
function validText(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 }
function validIsoDate(value: unknown): boolean { if (typeof value !== "string") return false; const parsed = new Date(value); return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value }
