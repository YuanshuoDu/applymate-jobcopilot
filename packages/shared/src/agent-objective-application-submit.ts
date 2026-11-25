import { parseObjectiveReviewedFillSource, type ObjectiveReviewedFillSource } from "./agent-objective-reviewed-fill.js"
import { hashAgentReceiptValue } from "./agent-receipt.js"

export const OBJECTIVE_APPLICATION_SUBMISSION_MATERIAL_SCHEMA = "agent-harness.v2.objective-application-submit-material.v1" as const
export const OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_SCHEMA = "agent-harness.application-submission.v3" as const
export const OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_SCHEMA = "agent-harness.v2.objective-submission-manifest-event.v1" as const
export const OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_TYPE = "objective_submission_manifest_recorded" as const
export const OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_ACTOR = "worker" as const
export const OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_BODY = "Objective submission manifest recorded for this fill attempt." as const

export type ObjectiveApplicationSubmissionMaterial = Readonly<{
  schemaVersion: typeof OBJECTIVE_APPLICATION_SUBMISSION_MATERIAL_SCHEMA
  applicationTaskId: string
  jobId: string
  resumeId: string
  coverLetterId: string | null
  reviewedCoverLetterHash: string
  objectiveSource: ObjectiveReviewedFillSource
}>

export type ObjectiveApplicationSubmissionManifest = Readonly<{
  schemaVersion: typeof OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_SCHEMA
  material: ObjectiveApplicationSubmissionMaterial
  answersHash: string
}>

export type ObjectiveApplicationSubmissionManifestEventScope = Readonly<{
  userId: string; sessionId: string; applicationTaskId: string; jobId: string; fillTurnId: string
}>

export type ObjectiveApplicationSubmissionManifestEvent = Readonly<{
  schemaVersion: typeof OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_SCHEMA
  scope: ObjectiveApplicationSubmissionManifestEventScope
  manifest: ObjectiveApplicationSubmissionManifest
  hash: string
}>

const MATERIAL_KEYS = ["schemaVersion", "applicationTaskId", "jobId", "resumeId", "coverLetterId", "reviewedCoverLetterHash", "objectiveSource"] as const
const MANIFEST_KEYS = ["schemaVersion", "material", "answersHash"] as const
const MANIFEST_EVENT_KEYS = ["schemaVersion", "scope", "manifest", "hash"] as const
const MANIFEST_EVENT_SCOPE_KEYS = ["userId", "sessionId", "applicationTaskId", "jobId", "fillTurnId"] as const
const HEX_DIGEST = /^[a-f0-9]{64}$/
const PREFIXED_ARTIFACT_HASH = /^sha256:[a-f0-9]{64}$/
const MANIFEST_EVENT_SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

/** Parses a closed Objective-only submission basis, including the exact fill selector. */
export function parseObjectiveApplicationSubmissionMaterial(value: unknown): ObjectiveApplicationSubmissionMaterial | null {
  const row = exactRecord(value, MATERIAL_KEYS)
  const coverLetterId = row?.coverLetterId
  const objectiveSource = row && parseObjectiveReviewedFillSource({ reviewedApplicationMaterialSource: row.objectiveSource })
  if (!row || row.schemaVersion !== OBJECTIVE_APPLICATION_SUBMISSION_MATERIAL_SCHEMA
    || !id(row.applicationTaskId) || !id(row.jobId) || !id(row.resumeId)
    || (coverLetterId !== null && !id(coverLetterId))
    || typeof row.reviewedCoverLetterHash !== "string" || !HEX_DIGEST.test(row.reviewedCoverLetterHash) || !objectiveSource) return null
  return Object.freeze({ schemaVersion: OBJECTIVE_APPLICATION_SUBMISSION_MATERIAL_SCHEMA,
    applicationTaskId: row.applicationTaskId, jobId: row.jobId, resumeId: row.resumeId,
    coverLetterId, reviewedCoverLetterHash: row.reviewedCoverLetterHash,
    objectiveSource: Object.freeze({ ...objectiveSource }) })
}

/** Commits the exact Objective proof selector and adapted Resume identity for final submission. */
export async function hashObjectiveApplicationSubmissionMaterial(value: unknown): Promise<string | null> {
  const material = parseObjectiveApplicationSubmissionMaterial(value)
  return material ? hashAgentReceiptValue("material", material) : null
}

export function buildObjectiveApplicationSubmissionManifest(
  materialValue: unknown,
  answersHash: unknown,
): ObjectiveApplicationSubmissionManifest | null {
  const material = parseObjectiveApplicationSubmissionMaterial(materialValue)
  if (!material || typeof answersHash !== "string" || !HEX_DIGEST.test(answersHash)) return null
  return Object.freeze({ schemaVersion: OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_SCHEMA, material, answersHash })
}

export function parseObjectiveApplicationSubmissionManifest(value: unknown): ObjectiveApplicationSubmissionManifest | null {
  const row = exactRecord(value, MANIFEST_KEYS)
  const material = row && parseObjectiveApplicationSubmissionMaterial(row.material)
  if (!row || row.schemaVersion !== OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_SCHEMA || !material
    || typeof row.answersHash !== "string" || !HEX_DIGEST.test(row.answersHash)) return null
  return Object.freeze({ schemaVersion: OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_SCHEMA, material, answersHash: row.answersHash })
}

/** Parses only the closed persisted envelope; adapters bind its digest and owner/current-attempt scope. */
export function parseObjectiveApplicationSubmissionManifestEvent(value: unknown): ObjectiveApplicationSubmissionManifestEvent | null {
  const row = exactRecord(value, MANIFEST_EVENT_KEYS)
  const scopeRow = row && exactRecord(row.scope, MANIFEST_EVENT_SCOPE_KEYS)
  const manifest = row && parseObjectiveApplicationSubmissionManifest(row.manifest)
  if (!row || row.schemaVersion !== OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_SCHEMA || !scopeRow || !manifest
    || !manifestEventScopeId(scopeRow.userId) || !manifestEventScopeId(scopeRow.sessionId)
    || !manifestEventScopeId(scopeRow.applicationTaskId) || !manifestEventScopeId(scopeRow.jobId)
    || !manifestEventScopeId(scopeRow.fillTurnId)
    || typeof row.hash !== "string" || !PREFIXED_ARTIFACT_HASH.test(row.hash)) return null
  const scope = Object.freeze({ userId: scopeRow.userId, sessionId: scopeRow.sessionId,
    applicationTaskId: scopeRow.applicationTaskId, jobId: scopeRow.jobId, fillTurnId: scopeRow.fillTurnId })
  return Object.freeze({ schemaVersion: OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_SCHEMA, scope, manifest, hash: row.hash })
}

function manifestEventScopeId(value: unknown): value is string {
  return typeof value === "string" && MANIFEST_EVENT_SCOPE_ID.test(value)
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) return null
    const row = Object.create(null) as Record<string, unknown>
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null
      row[key] = descriptor.value
    }
    return row
  } catch { return null }
}

function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
}
