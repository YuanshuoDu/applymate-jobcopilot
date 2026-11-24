import type { PoolClient } from "pg"
import {
  bindReviewedApplicationSubmissionMaterial, hashReviewedApplicationMaterialProof,
  parseObjectiveReviewedFillSource,
  type LegacyApplicationSubmissionMaterial,
  type ObjectiveReviewedFillSource,
  type ReviewedApplicationMaterialProof, type ReviewedApplicationSubmissionMaterial,
} from "@jobcopilot/shared"
import type { SelectedJobReviewedArtifact } from "../runtime/selected-job-reviewed-artifact-read.js"
import type { SubagentLease } from "../runtime/subagents/types.js"
import { OBJECTIVE_REVIEWED_FILL_BROWSER_START_SCHEMA, type ReviewedApplicationFillSelector } from "../runtime/reviewed-application-fill-binding.js"

const READBACK_SCHEMA = "agent-harness.v2.reviewed-application-fill-readback.v1"
const BINDING_SCHEMA = "agent-harness.v2.reviewed-application-fill-browser-start.v1"
const PROOF_KEYS = ["jobId", "sourceTurnId", "rootTaskId", "graphRevision", "writerTaskId", "reviewerTaskId", "reviewerToolCallId", "reviewHash", "artifactId", "version", "contentHash", "sourceDigest"] as const
const BINDING_KEYS = ["schemaVersion", "userId", "sessionId", "fillTurnId", "jobId", "applicationTaskId", "fillerTaskId", "attemptCount", "leaseOwner", "leaseExpiresAt", "sourceTurnId", "rootTaskId", "graphRevision", "writerTaskId", "reviewerTaskId", "reviewerToolCallId", "reviewHash", "artifactId", "version", "contentHash", "sourceDigest"] as const
const READBACK_KEYS = ["schemaVersion", "userId", "sessionId", "fillTurnId", "applicationTaskId", "jobId", "fillerTaskId", "attemptCount", "leaseOwner", "leaseExpiresAt", "sourceTurnId", "reviewedCoverLetterHash"] as const
const OBJECTIVE_READBACK_SCHEMA = "agent-harness.v2.objective-reviewed-fill-readback.v1"
const OBJECTIVE_BINDING_KEYS = [...BINDING_KEYS, "objectiveSource"] as const
const OBJECTIVE_READBACK_KEYS = [...READBACK_KEYS, "objectiveSource"] as const

type Queryable = Pick<PoolClient, "query">
type RecordValue = Record<string, unknown>
type BindingEventRow = { actor: string; data: unknown }
export type ReviewedApplicationFillReadback = Readonly<{
  schemaVersion: typeof READBACK_SCHEMA; userId: string; sessionId: string; fillTurnId: string; applicationTaskId: string; jobId: string
  fillerTaskId: string; attemptCount: number; leaseOwner: string; leaseExpiresAt: string; sourceTurnId: string; reviewedCoverLetterHash: string
}>
export type ObjectiveReviewedApplicationFillReadback = Readonly<{
  schemaVersion: typeof OBJECTIVE_READBACK_SCHEMA; userId: string; sessionId: string; fillTurnId: string; applicationTaskId: string; jobId: string
  fillerTaskId: string; attemptCount: number; leaseOwner: string; leaseExpiresAt: string; objectiveSource: ObjectiveReviewedFillSource
  sourceTurnId: string; reviewedCoverLetterHash: string
}>
export type ApplicationFillCompletionSelector = ReviewedApplicationFillSelector

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

/** Binds the Objective slot selector into the current browser attempt's readback. */
export async function createObjectiveReviewedApplicationFillReadback(
  lease: SubagentLease, applicationTaskId: string, source: ObjectiveReviewedFillSource, proof: SelectedJobReviewedArtifact,
): Promise<ObjectiveReviewedApplicationFillReadback | null> {
  const selected = parseObjectiveReviewedFillSource({ reviewedApplicationMaterialSource: source })
  const fields = proofProjection(proof), reviewedCoverLetterHash = await hashReviewedApplicationMaterialProof(fields)
  if (!selected || !sameObjectiveReviewedFillSource(selected, source) || !reviewedCoverLetterHash || !lease.turnId
    || !validText(applicationTaskId) || !validText(lease.ownerId) || lease.leaseOwner !== lease.ownerId
    || !Number.isSafeInteger(lease.attemptCount) || lease.attemptCount < 1
    || !(lease.leaseExpiresAt instanceof Date) || !Number.isFinite(lease.leaseExpiresAt.getTime())) return null
  return Object.freeze({ schemaVersion: OBJECTIVE_READBACK_SCHEMA, userId: lease.userId, sessionId: lease.sessionId,
    fillTurnId: lease.turnId, applicationTaskId, jobId: proof.jobId, fillerTaskId: lease.id,
    attemptCount: lease.attemptCount, leaseOwner: lease.ownerId, leaseExpiresAt: lease.leaseExpiresAt.toISOString(),
    objectiveSource: selected, sourceTurnId: proof.sourceTurnId, reviewedCoverLetterHash })
}

/** Rebinds Objective source, exact browser-start proof, and same-attempt readback. */
export async function readObjectiveReviewedApplicationFillCompletionMaterial(
  client: Queryable,
  input: { lease: SubagentLease; applicationTaskId: string; jobId: string; source: ObjectiveReviewedFillSource; turnInput: unknown
    legacyMaterial: LegacyApplicationSubmissionMaterial; readback?: unknown; requireCurrentAttempt: boolean },
): Promise<ReviewedApplicationSubmissionMaterial | null> {
  const { lease } = input
  const selected = parseObjectiveReviewedFillSource(input.turnInput)
  if (!lease.turnId || !validText(input.applicationTaskId) || !validText(input.jobId) || !selected
    || !sameObjectiveReviewedFillSource(selected, input.source)) return null
  const { readObjectiveReviewedApplicationFillSource } = await import("../runtime/objective-reviewed-application-fill-read.js")
  const evidence = await readObjectiveReviewedApplicationFillSource(client, {
    userId: lease.userId, sessionId: lease.sessionId, fillTurnId: lease.turnId,
    applicationTaskId: input.applicationTaskId, jobId: input.jobId, turnInput: input.turnInput,
    phase: input.requireCurrentAttempt ? "completion" : "completion_replay",
  })
  if (!evidence || !sameObjectiveReviewedFillSource(evidence.source, selected) || evidence.reviewedArtifact.jobId !== input.jobId) return null
  const proof = proofProjection(evidence.reviewedArtifact)
  const material = await bindReviewedApplicationSubmissionMaterial(input.legacyMaterial, proof)
  if (!material) return null
  const events = await client.query<BindingEventRow>(`SELECT "actor", "data" FROM "application_task_events"
    WHERE "taskId"=$1 AND "type"='reviewed_application_fill_browser_started' AND "data"->>'fillTurnId'=$2 LIMIT 2 FOR SHARE`,
  [input.applicationTaskId, lease.turnId])
  if (events.rows.length !== 1 || !sameObjectiveBinding(events.rows[0]!, lease, input, selected, proof, input.requireCurrentAttempt)) return null
  if (input.requireCurrentAttempt && !sameObjectiveReadback(input.readback, lease, input, selected, proof, material)) return null
  return material
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

export async function readApplicationFillCompletionMaterial(client: Queryable, input: {
  selector: ApplicationFillCompletionSelector; lease: SubagentLease; applicationTaskId: string; jobId: string; turnInput: unknown
  legacyMaterial: LegacyApplicationSubmissionMaterial; readback?: ReviewedApplicationFillReadback | ObjectiveReviewedApplicationFillReadback
  requireCurrentAttempt: boolean
}): Promise<ReviewedApplicationSubmissionMaterial | null> {
  if (input.selector.kind === "selected") return readReviewedApplicationFillCompletionMaterial(client, {
    lease: input.lease, applicationTaskId: input.applicationTaskId, jobId: input.jobId,
    sourceTurnId: input.selector.sourceTurnId, legacyMaterial: input.legacyMaterial,
    readback: input.readback && "objectiveSource" in input.readback ? undefined : input.readback,
    requireCurrentAttempt: input.requireCurrentAttempt,
  })
  if (input.selector.kind === "objective") return readObjectiveReviewedApplicationFillCompletionMaterial(client, {
    lease: input.lease, applicationTaskId: input.applicationTaskId, jobId: input.jobId,
    source: input.selector.source, turnInput: input.turnInput, legacyMaterial: input.legacyMaterial,
    readback: input.readback, requireCurrentAttempt: input.requireCurrentAttempt,
  })
  return null
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

function sameObjectiveBinding(event: BindingEventRow, lease: SubagentLease,
  input: { applicationTaskId: string; jobId: string; source: ObjectiveReviewedFillSource },
  source: ObjectiveReviewedFillSource, proof: ReviewedApplicationMaterialProof, currentAttempt: boolean): boolean {
  const data = exactRecord(event.data, OBJECTIVE_BINDING_KEYS)
  const recordedSource = data && parseObjectiveReviewedFillSource({ reviewedApplicationMaterialSource: data.objectiveSource })
  if (!data || !recordedSource || event.actor !== "worker" || data.schemaVersion !== OBJECTIVE_REVIEWED_FILL_BROWSER_START_SCHEMA
    || data.userId !== lease.userId || data.sessionId !== lease.sessionId || data.fillTurnId !== lease.turnId
    || data.jobId !== input.jobId || data.applicationTaskId !== input.applicationTaskId || data.fillerTaskId !== lease.id
    || !Number.isSafeInteger(data.attemptCount) || Number(data.attemptCount) < 1
    || !validText(data.leaseOwner) || !validIsoDate(data.leaseExpiresAt)
    || !sameObjectiveReviewedFillSource(recordedSource, source) || !sameObjectiveReviewedFillSource(input.source, source)
    || !PROOF_KEYS.every(key => data[key] === proof[key])) return false
  return !currentAttempt || (data.attemptCount === lease.attemptCount && data.leaseOwner === lease.ownerId
    && data.leaseExpiresAt === lease.leaseExpiresAt.toISOString())
}

function sameObjectiveReadback(value: unknown, lease: SubagentLease,
  input: { applicationTaskId: string; jobId: string; source: ObjectiveReviewedFillSource },
  source: ObjectiveReviewedFillSource, proof: ReviewedApplicationMaterialProof, material: ReviewedApplicationSubmissionMaterial): boolean {
  const data = exactRecord(value, OBJECTIVE_READBACK_KEYS)
  const recordedSource = data && parseObjectiveReviewedFillSource({ reviewedApplicationMaterialSource: data.objectiveSource })
  return Boolean(data && recordedSource && data.schemaVersion === OBJECTIVE_READBACK_SCHEMA
    && data.userId === lease.userId && data.sessionId === lease.sessionId && data.fillTurnId === lease.turnId
    && data.applicationTaskId === input.applicationTaskId && data.jobId === input.jobId && data.fillerTaskId === lease.id
    && data.attemptCount === lease.attemptCount && data.leaseOwner === lease.ownerId
    && data.leaseExpiresAt === lease.leaseExpiresAt.toISOString() && data.sourceTurnId === proof.sourceTurnId
    && data.reviewedCoverLetterHash === material.reviewedCoverLetterHash
    && sameObjectiveReviewedFillSource(recordedSource, source) && sameObjectiveReviewedFillSource(input.source, source))
}

function sameObjectiveReviewedFillSource(left: ObjectiveReviewedFillSource, right: ObjectiveReviewedFillSource): boolean {
  return left.schemaVersion === right.schemaVersion && left.approvalId === right.approvalId
    && left.reviewTurnId === right.reviewTurnId && left.materialProofHash === right.materialProofHash
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
