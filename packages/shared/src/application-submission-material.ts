import { hashAgentReceiptValue } from "./agent-receipt.js"

export const LEGACY_APPLICATION_SUBMISSION_MANIFEST_SCHEMA = "agent-harness.application-submission.v1" as const
export const REVIEWED_APPLICATION_SUBMISSION_MANIFEST_SCHEMA = "agent-harness.application-submission.v2" as const
export const REVIEWED_APPLICATION_MATERIAL_PROOF_SCHEMA = "agent-harness.v2.reviewed-application-material-proof.v1" as const

export interface LegacyApplicationSubmissionMaterial {
  readonly applicationTaskId: string
  readonly jobId: string
  readonly resumeId: string | null
  readonly coverLetterId: string | null
}

export interface ReviewedApplicationSubmissionMaterial extends LegacyApplicationSubmissionMaterial {
  readonly reviewedCoverLetterHash: string
}

export type ApplicationSubmissionMaterial = LegacyApplicationSubmissionMaterial | ReviewedApplicationSubmissionMaterial

export interface ReviewedApplicationMaterialProof {
  readonly jobId: string
  readonly sourceTurnId: string
  readonly rootTaskId: string
  readonly graphRevision: number
  readonly writerTaskId: string
  readonly reviewerTaskId: string
  readonly reviewerToolCallId: string
  readonly reviewHash: string
  readonly artifactId: string
  readonly version: number
  readonly contentHash: string
  readonly sourceDigest: string
}

export interface LegacyApplicationSubmissionManifest extends LegacyApplicationSubmissionMaterial {
  readonly schemaVersion: typeof LEGACY_APPLICATION_SUBMISSION_MANIFEST_SCHEMA
  readonly answersHash: string
}

export interface ReviewedApplicationSubmissionManifest extends ReviewedApplicationSubmissionMaterial {
  readonly schemaVersion: typeof REVIEWED_APPLICATION_SUBMISSION_MANIFEST_SCHEMA
  readonly answersHash: string
}

export type ApplicationSubmissionManifest = LegacyApplicationSubmissionManifest | ReviewedApplicationSubmissionManifest

const MATERIAL_KEYS = ["applicationTaskId", "jobId", "resumeId", "coverLetterId"] as const
const REVIEWED_MATERIAL_KEYS = [...MATERIAL_KEYS, "reviewedCoverLetterHash"] as const
const PROOF_KEYS = ["jobId", "sourceTurnId", "rootTaskId", "graphRevision", "writerTaskId", "reviewerTaskId", "reviewerToolCallId", "reviewHash", "artifactId", "version", "contentHash", "sourceDigest"] as const
const LEGACY_MANIFEST_KEYS = [...MATERIAL_KEYS, "schemaVersion", "answersHash"] as const
const REVIEWED_MANIFEST_KEYS = [...REVIEWED_MATERIAL_KEYS, "schemaVersion", "answersHash"] as const
const HEX_DIGEST = /^[a-f0-9]{64}$/
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/

function hasExactDataKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false
  const actual = Reflect.ownKeys(value)
  return actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key))
    && keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor
    })
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
}

function hasMaterialFields(value: Record<string, unknown>): boolean {
  return isId(value.applicationTaskId) && isId(value.jobId)
    && (value.resumeId === null || isId(value.resumeId))
    && (value.coverLetterId === null || isId(value.coverLetterId))
}

export function isLegacyApplicationSubmissionMaterial(value: unknown): value is LegacyApplicationSubmissionMaterial {
  return hasExactDataKeys(value, MATERIAL_KEYS) && hasMaterialFields(value)
}

export function isReviewedApplicationSubmissionMaterial(value: unknown): value is ReviewedApplicationSubmissionMaterial {
  return hasExactDataKeys(value, REVIEWED_MATERIAL_KEYS) && hasMaterialFields(value)
    && typeof value.reviewedCoverLetterHash === "string" && HEX_DIGEST.test(value.reviewedCoverLetterHash)
}

export function isApplicationSubmissionMaterial(value: unknown): value is ApplicationSubmissionMaterial {
  return isLegacyApplicationSubmissionMaterial(value) || isReviewedApplicationSubmissionMaterial(value)
}

export function isReviewedApplicationMaterialProof(value: unknown): value is ReviewedApplicationMaterialProof {
  if (!hasExactDataKeys(value, PROOF_KEYS)) return false
  return isId(value.jobId) && isId(value.sourceTurnId) && isId(value.rootTaskId)
    && Number.isSafeInteger(value.graphRevision) && Number(value.graphRevision) >= 1
    && isId(value.writerTaskId) && isId(value.reviewerTaskId) && isId(value.reviewerToolCallId)
    && typeof value.reviewHash === "string" && SHA256_DIGEST.test(value.reviewHash)
    && isId(value.artifactId) && Number.isSafeInteger(value.version) && Number(value.version) >= 1
    && typeof value.contentHash === "string" && SHA256_DIGEST.test(value.contentHash)
    && typeof value.sourceDigest === "string" && SHA256_DIGEST.test(value.sourceDigest)
}

export async function hashReviewedApplicationMaterialProof(value: unknown): Promise<string | null> {
  if (!isReviewedApplicationMaterialProof(value)) return null
  return hashAgentReceiptValue("reviewed-application-material", {
    schemaVersion: REVIEWED_APPLICATION_MATERIAL_PROOF_SCHEMA,
    jobId: value.jobId,
    sourceTurnId: value.sourceTurnId,
    rootTaskId: value.rootTaskId,
    graphRevision: value.graphRevision,
    writerTaskId: value.writerTaskId,
    reviewerTaskId: value.reviewerTaskId,
    reviewerToolCallId: value.reviewerToolCallId,
    reviewHash: value.reviewHash,
    artifactId: value.artifactId,
    version: value.version,
    contentHash: value.contentHash,
    sourceDigest: value.sourceDigest,
  })
}

export async function bindReviewedApplicationSubmissionMaterial(
  legacy: unknown,
  proof: unknown,
): Promise<ReviewedApplicationSubmissionMaterial | null> {
  if (!isLegacyApplicationSubmissionMaterial(legacy) || !isReviewedApplicationMaterialProof(proof)) return null
  const material = { ...legacy }
  const source = {
    jobId: proof.jobId, sourceTurnId: proof.sourceTurnId, rootTaskId: proof.rootTaskId,
    graphRevision: proof.graphRevision, writerTaskId: proof.writerTaskId, reviewerTaskId: proof.reviewerTaskId,
    reviewerToolCallId: proof.reviewerToolCallId, reviewHash: proof.reviewHash, artifactId: proof.artifactId,
    version: proof.version, contentHash: proof.contentHash, sourceDigest: proof.sourceDigest,
  }
  if (material.jobId !== source.jobId) return null
  const reviewedCoverLetterHash = await hashReviewedApplicationMaterialProof(source)
  return reviewedCoverLetterHash ? { ...material, reviewedCoverLetterHash } : null
}

export async function matchesReviewedApplicationMaterialProof(
  material: unknown,
  proof: unknown,
): Promise<boolean> {
  if (!isReviewedApplicationSubmissionMaterial(material) || !isReviewedApplicationMaterialProof(proof)) return false
  const jobId = material.jobId, commitment = material.reviewedCoverLetterHash, proofJobId = proof.jobId
  const expected = await hashReviewedApplicationMaterialProof(proof)
  return jobId === proofJobId && commitment === expected
}

export async function hashApplicationSubmissionMaterial(value: unknown): Promise<string | null> {
  if (!isApplicationSubmissionMaterial(value)) return null
  return hashAgentReceiptValue("material", value)
}

export function buildApplicationSubmissionManifest(
  material: unknown,
  answersHash: unknown,
): ApplicationSubmissionManifest | null {
  if (!isApplicationSubmissionMaterial(material) || typeof answersHash !== "string" || !HEX_DIGEST.test(answersHash)) return null
  return isReviewedApplicationSubmissionMaterial(material)
    ? { schemaVersion: REVIEWED_APPLICATION_SUBMISSION_MANIFEST_SCHEMA, ...material, answersHash }
    : { schemaVersion: LEGACY_APPLICATION_SUBMISSION_MANIFEST_SCHEMA, ...material, answersHash }
}

export function isApplicationSubmissionManifest(value: unknown): value is ApplicationSubmissionManifest {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false
  const version = Object.getOwnPropertyDescriptor(value, "schemaVersion")
  if (!version || !version.enumerable || !("value" in version)) return false
  const record = value as Record<string, unknown>
  if (version.value === LEGACY_APPLICATION_SUBMISSION_MANIFEST_SCHEMA) {
    if (!hasExactDataKeys(value, LEGACY_MANIFEST_KEYS) || typeof record.answersHash !== "string" || !HEX_DIGEST.test(record.answersHash)) return false
    return isLegacyApplicationSubmissionMaterial({
      applicationTaskId: record.applicationTaskId, jobId: record.jobId,
      resumeId: record.resumeId, coverLetterId: record.coverLetterId,
    })
  }
  if (version.value !== REVIEWED_APPLICATION_SUBMISSION_MANIFEST_SCHEMA
    || !hasExactDataKeys(value, REVIEWED_MANIFEST_KEYS) || typeof record.answersHash !== "string" || !HEX_DIGEST.test(record.answersHash)) return false
  return isReviewedApplicationSubmissionMaterial({
    applicationTaskId: record.applicationTaskId, jobId: record.jobId, resumeId: record.resumeId,
    coverLetterId: record.coverLetterId, reviewedCoverLetterHash: record.reviewedCoverLetterHash,
  })
}
