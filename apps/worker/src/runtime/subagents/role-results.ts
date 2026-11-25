import { ROLE_RESULT_SCHEMA, SCOUT_ROLE_RESULT_OUTPUT_SCHEMA, ANALYST_ROLE_RESULT_OUTPUT_SCHEMA,
  RoleResultValidationError, parseScoutAnalystResult } from "./role-result-job-evidence.js"
import type { AnalystFinding, AnalystResult, EvidenceKind, RoleEvidence, RoleResultStatus, ScoutCandidate, ScoutResult } from "./role-result-job-evidence.js"

export { ROLE_RESULT_SCHEMA, SCOUT_ROLE_RESULT_OUTPUT_SCHEMA, ANALYST_ROLE_RESULT_OUTPUT_SCHEMA, RoleResultValidationError }
export type { AnalystFinding, AnalystResult, EvidenceKind, RoleEvidence, RoleResultStatus, ScoutCandidate, ScoutResult }
export const ARTIFACT_REFERENCE_SCHEMA = "agent-harness.v2.subagent.artifact-reference" as const
export const REVIEW_STATUSES = ["passed", "needs_revision", "rejected", "stale"] as const
type JsonSchema = Record<string, unknown>
const artifactRefSchema: JsonSchema = { type: "object", properties: { artifactId: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\\s\\S])" }, version: { type: "integer", minimum: 1 }, contentHash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" }, sourceDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" } }, required: ["artifactId", "version", "contentHash", "sourceDigest"], additionalProperties: false }
export const WRITER_ROLE_RESULT_OUTPUT_SCHEMA: JsonSchema = { type: "object", properties: { schemaVersion: { const: ROLE_RESULT_SCHEMA }, role: { const: "writer" }, status: { const: "completed" }, artifactRef: artifactRefSchema }, required: ["schemaVersion", "role", "status", "artifactRef"], additionalProperties: false }
export const REVIEWER_ROLE_RESULT_OUTPUT_SCHEMA: JsonSchema = { type: "object", properties: { schemaVersion: { const: ROLE_RESULT_SCHEMA }, role: { const: "reviewer" }, status: { const: "completed" }, artifactRef: artifactRefSchema, reviewStatus: { type: "string", enum: REVIEW_STATUSES }, reviewHash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" } }, required: ["schemaVersion", "role", "status", "artifactRef", "reviewStatus", "reviewHash"], additionalProperties: false }
const PREPARE_JOB_STATUSES = ["prepared", "skipped", "failed"] as const
const prepareJobSchema: JsonSchema = { type: "object", properties: { jobId: { type: "string", minLength: 1, maxLength: 256 }, status: { type: "string", enum: PREPARE_JOB_STATUSES } }, required: ["jobId", "status"], additionalProperties: false }
const prepareMaterialSchema: JsonSchema = { type: "object", properties: { jobId: { type: "string", minLength: 1, maxLength: 256 }, kind: { type: "string", enum: ["resume", "cover_letter"] }, artifactRef: artifactRefSchema }, required: ["jobId", "kind", "artifactRef"], additionalProperties: false }
const sha256HexPattern = "^[a-f0-9]{64}$"
export const PREPARE_ROLE_RESULT_OUTPUT_SCHEMA: JsonSchema = { type: "object", properties: {
  schemaVersion: { const: ROLE_RESULT_SCHEMA }, role: { const: "prepare" }, status: { type: "string", enum: ["completed", "partial"] },
  taskId: { type: "string", minLength: 1, maxLength: 256 }, attemptCount: { type: "integer", minimum: 1 },
  snapshotDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" }, checkpointDigest: { type: "string", pattern: sha256HexPattern },
  jobs: { type: "array", maxItems: 50, items: prepareJobSchema }, materials: { type: "array", maxItems: 100, items: prepareMaterialSchema },
}, required: ["schemaVersion", "role", "status", "taskId", "attemptCount", "snapshotDigest", "checkpointDigest", "jobs", "materials"], additionalProperties: false }
export type StructuredRole = "scout" | "analyst" | "writer" | "reviewer" | "prepare"
export function roleResultOutputSchema(role: StructuredRole): JsonSchema {
  if (role === "scout") return SCOUT_ROLE_RESULT_OUTPUT_SCHEMA
  if (role === "analyst") return ANALYST_ROLE_RESULT_OUTPUT_SCHEMA
  if (role === "prepare") return PREPARE_ROLE_RESULT_OUTPUT_SCHEMA
  return role === "writer" ? WRITER_ROLE_RESULT_OUTPUT_SCHEMA : REVIEWER_ROLE_RESULT_OUTPUT_SCHEMA
}
export type ArtifactVersionReference = Readonly<{
  artifactId: string
  version: number
  contentHash: string
  sourceDigest: string
}>

export type WriterResult = Readonly<{
  schemaVersion: typeof ROLE_RESULT_SCHEMA
  role: "writer"
  status: "completed"
  artifactRef: ArtifactVersionReference
}>

export type ReviewerResult = Readonly<{
  schemaVersion: typeof ROLE_RESULT_SCHEMA
  role: "reviewer"
  status: "completed"
  artifactRef: ArtifactVersionReference
  reviewStatus: typeof REVIEW_STATUSES[number]
  reviewHash: string
}>

export type PrepareJobStatus = typeof PREPARE_JOB_STATUSES[number]
export type PrepareJobResult = Readonly<{ jobId: string; status: PrepareJobStatus }>
export type PrepareMaterialKind = "resume" | "cover_letter"
export type PrepareMaterial = Readonly<{ jobId: string; kind: PrepareMaterialKind; artifactRef: ArtifactVersionReference }>
export type PrepareResult = Readonly<{ schemaVersion: typeof ROLE_RESULT_SCHEMA; role: "prepare"; status: RoleResultStatus; taskId: string; attemptCount: number; snapshotDigest: string; checkpointDigest: string; jobs: readonly PrepareJobResult[]; materials: readonly PrepareMaterial[] }>

export type StructuredRoleResult = ScoutResult | AnalystResult | WriterResult | ReviewerResult | PrepareResult

export function structuredRoleOutputGuidance(role: string, marker: unknown): string | null {
  try {
    if (!isRole(role) || !marker || typeof marker !== "object" || Array.isArray(marker)) return null
    const value = marker as Record<string, unknown>
    const prototype = Object.getPrototypeOf(marker)
    if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(marker).length !== 0
      || Object.keys(value).sort().join(",") !== "role,schemaVersion" || value.schemaVersion !== ROLE_RESULT_SCHEMA || value.role !== role) return null
    if (role === "writer") return "SERVER STRUCTURED RESULT CONTRACT: Final output must be one JSON object with exactly schemaVersion, role, status, and artifactRef. status must be completed. artifactRef must contain only artifactId, version, contentHash, and sourceDigest from the successful cover_letter.draft tool result. Read the base artifact ID and hash from runtimeContext.coverLetterBase. Never include cover-letter content, findings, identity, lease, capability, permission, or authorization data."
    if (role === "reviewer") return "SERVER STRUCTURED RESULT CONTRACT: Final output must be one JSON object with exactly schemaVersion, role, status, artifactRef, reviewStatus, and reviewHash. status must be completed. Copy artifactRef and the review receipt only from the successful artifact.review tool result. Never include draft content, findings, identity, lease, capability, permission, or authorization data."
    if (role === "prepare") return "SERVER STRUCTURED RESULT CONTRACT: Final output must be one JSON object with exactly schemaVersion, role, status, taskId, attemptCount, snapshotDigest, checkpointDigest, jobs, and materials. Copy taskId, attemptCount, job status, authoritative job bindings, immutable artifact references, and digests only from the successful scheduled.application.prepare tool result. Each job has only jobId and status (prepared, skipped, or failed); each material has only jobId, kind (resume or cover_letter), and artifactRef. Keep status partial exactly when a job failed. The server independently rebinds task, attempt, job IDs, checkpoint digest, snapshot digest, owner, and artifact refs to persisted evidence. Never include scores, resume or letter content, user identity, schedule configuration, or authorization data."
    if (role === "analyst") return "SERVER STRUCTURED RESULT CONTRACT: Final output must be one JSON object with exactly schemaVersion, role, status, findings, evidence, and summary. Each finding includes requirementCitations as null or an array of at most 8 closed objects containing evidenceId and quote. Cite only an exact continuous quote from the same finding Job's saved description returned by jobs.get; use the finding's job evidence ID. If no exact requirement quote is available, use null. Do not cite generated keywords, add rationale, or include identity, lease, capability, permission, or authorization data."
    return "SERVER STRUCTURED RESULT CONTRACT: Final output must be one JSON object with exactly schemaVersion, role, status, candidates, evidence, and summary. evidenceIds must reference evidence in this same result. status must be completed or partial. Do not include extra fields or identity, lease, capability, permission, or authorization data."
  } catch {
    return null
  }
}

const FORBIDDEN_RESULT_KEYS = new Set([
  "userId", "sessionId", "turnId", "stepId", "taskId", "parentTaskId", "rootTaskId", "ownerId", "lease",
  "leaseOwnerId", "leaseVersion", "idempotencyKey", "capabilities", "permissions", "allowedCapabilities", "budgetLimit", "maxBudget",
])
const ARTIFACT_REF_KEYS = ["artifactId", "version", "contentHash", "sourceDigest"] as const
const SAFE_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const WRITER_RESULT_KEYS = ["schemaVersion", "role", "status", "artifactRef"] as const
const REVIEWER_RESULT_KEYS = ["schemaVersion", "role", "status", "artifactRef", "reviewStatus", "reviewHash"] as const
const PREPARE_RESULT_KEYS = ["schemaVersion", "role", "status", "taskId", "attemptCount", "snapshotDigest", "checkpointDigest", "jobs", "materials"] as const

export function validateRoleResult<T extends StructuredRole>(value: unknown, expectedRole: T): Extract<StructuredRoleResult, { role: T }>
export function validateRoleResult(value: unknown): StructuredRoleResult
export function validateRoleResult(value: unknown, expectedRole?: StructuredRole): StructuredRoleResult {
  const row = record(value)
  if (!plainJson(value, new Set<object>(), row.role === "prepare")) throw new RoleResultValidationError("invalid_shape", "Structured subagent result has an invalid JSON shape")
  if (row.schemaVersion !== ROLE_RESULT_SCHEMA || !isRole(row.role) || (expectedRole && row.role !== expectedRole)) {
    throw new RoleResultValidationError("invalid_shape", "Structured subagent result has an invalid schema or role")
  }
  if (row.role === "writer" || row.role === "reviewer") return parseArtifactRoleResult(row)
  if (row.role === "prepare") return parsePrepareRoleResult(row)
  return parseScoutAnalystResult(row)
}

function parseArtifactRoleResult(row: Record<string, unknown>): WriterResult | ReviewerResult {
  if (row.role === "writer") {
    if (!exactKeys(row, WRITER_RESULT_KEYS) || row.status !== "completed") throw new RoleResultValidationError("invalid_shape", "Writer result has an invalid field set")
    return { schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef: parseArtifactReference(row.artifactRef) }
  }
  if (!exactKeys(row, REVIEWER_RESULT_KEYS) || row.status !== "completed" || !isReviewStatus(row.reviewStatus) || !isDigest(row.reviewHash)) {
    throw new RoleResultValidationError("invalid_shape", "Reviewer result has an invalid field set")
  }
  return { schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer", status: "completed", artifactRef: parseArtifactReference(row.artifactRef), reviewStatus: row.reviewStatus, reviewHash: row.reviewHash }
}

function parsePrepareRoleResult(row: Record<string, unknown>): PrepareResult {
  if (!exactKeys(row, PREPARE_RESULT_KEYS) || !isStatus(row.status) || !safeTaskId(row.taskId) || !Number.isSafeInteger(row.attemptCount) || Number(row.attemptCount) < 1 || !isSnapshotDigest(row.snapshotDigest) || !isHexDigest(row.checkpointDigest)) throw new RoleResultValidationError("invalid_shape", "Prepare result has an invalid field set or digest")
  const jobs = parsePrepareJobs(row.jobs)
  const materials = parsePrepareMaterials(row.materials)
  const jobsById = new Map(jobs.map(job => [job.jobId, job.status]))
  const materialKeys = new Set<string>()
  for (const material of materials) {
    if (jobsById.get(material.jobId) !== "prepared") throw new RoleResultValidationError("invalid_shape", "Prepare material must bind to a prepared job")
    const key = `${material.jobId}\u0000${material.kind}`
    if (materialKeys.has(key)) throw new RoleResultValidationError("invalid_shape", "Prepare material kind must be unique per job")
    materialKeys.add(key)
  }
  if ((row.status === "partial") !== jobs.some(job => job.status === "failed")) throw new RoleResultValidationError("invalid_shape", "Prepare status must be partial exactly when a job failed")
  return { schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare", status: row.status, taskId: row.taskId, attemptCount: row.attemptCount as number, snapshotDigest: row.snapshotDigest, checkpointDigest: row.checkpointDigest, jobs, materials }
}

export function parseArtifactReference(value: unknown): ArtifactVersionReference {
  const row = record(value)
  if (!exactKeys(row, ARTIFACT_REF_KEYS) || !nonEmpty(row.artifactId) || !SAFE_ARTIFACT_ID.test(row.artifactId)
    || !Number.isSafeInteger(row.version) || Number(row.version) < 1 || !isDigest(row.contentHash) || !isDigest(row.sourceDigest)) {
    throw new RoleResultValidationError("invalid_shape", "Artifact reference has an invalid field set")
  }
  return { artifactId: row.artifactId, version: row.version as number, contentHash: row.contentHash, sourceDigest: row.sourceDigest }
}

export function makeEvidence(id: string, kind: EvidenceKind, ref: string, source: string): RoleEvidence {
  for (const [field, value] of [["id", id], ["ref", ref], ["source", source]] as const) {
    if (typeof value !== "string" || value.trim().length === 0) throw new RoleResultValidationError("missing_id", `Evidence ${field} is required`)
  }
  return { id, kind, ref, source }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RoleResultValidationError("invalid_shape", "Result must be an object")
  return value as Record<string, unknown>
}
function plainJson(value: unknown, seen = new Set<object>(), allowPrepareIdentity = false, depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object" || seen.has(value)) return false
  try {
    if (!Array.isArray(value)) {
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) return false
    }
    if (Object.getOwnPropertySymbols(value).length > 0 || Object.keys(value).some(key => FORBIDDEN_RESULT_KEYS.has(key) && !(allowPrepareIdentity && depth === 0 && key === "taskId"))) return false
    seen.add(value)
    const valid = Object.values(value).every(child => plainJson(child, seen, allowPrepareIdentity, depth + 1))
    seen.delete(value)
    return valid
  } catch {
    seen.delete(value)
    return false
  }
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}
function isRole(value: unknown): value is StructuredRole { return value === "scout" || value === "analyst" || value === "writer" || value === "reviewer" || value === "prepare" }
function isStatus(value: unknown): value is RoleResultStatus { return value === "completed" || value === "partial" }
function isReviewStatus(value: unknown): value is typeof REVIEW_STATUSES[number] { return typeof value === "string" && (REVIEW_STATUSES as readonly string[]).includes(value) }
function isDigest(value: unknown): value is string { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value) }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 }
function parsePrepareJobs(value: unknown): PrepareJobResult[] {
  if (!densePrepareArray(value, 50)) throw new RoleResultValidationError("invalid_shape", "Prepare jobs must be a bounded array")
  const seen = new Set<string>()
  return value.map(item => {
    const row = record(item)
    if (!exactKeys(row, ["jobId", "status"]) || !safeJobId(row.jobId) || !isPrepareJobStatus(row.status) || seen.has(row.jobId)) {
      throw new RoleResultValidationError("invalid_shape", "Prepare job has an invalid or duplicate binding")
    }
    seen.add(row.jobId)
    return { jobId: row.jobId, status: row.status }
  })
}
function parsePrepareMaterials(value: unknown): PrepareMaterial[] {
  if (!densePrepareArray(value, 100)) throw new RoleResultValidationError("invalid_shape", "Prepare materials must be a bounded array")
  return value.map(item => {
    const row = record(item)
    if (!exactKeys(row, ["jobId", "kind", "artifactRef"]) || !safeJobId(row.jobId)
      || (row.kind !== "resume" && row.kind !== "cover_letter")) throw new RoleResultValidationError("invalid_shape", "Prepare material has an invalid field set")
    return { jobId: row.jobId, kind: row.kind, artifactRef: parseArtifactReference(row.artifactRef) }
  })
}
function densePrepareArray(value: unknown, maximum: number): value is unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return false
  const keys = Object.keys(value)
  return keys.length === value.length && keys.every((key, index) => key === String(index))
}
function safeJobId(value: unknown): value is string { return nonEmpty(value) && value.trim() === value && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) }
function isPrepareJobStatus(value: unknown): value is PrepareJobStatus { return typeof value === "string" && (PREPARE_JOB_STATUSES as readonly string[]).includes(value) }
function isHexDigest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) }
function isSnapshotDigest(value: unknown): value is string { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value) }
function safeTaskId(value: unknown): value is string { return nonEmpty(value) && value.trim() === value && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) }
function isEvidenceKind(value: unknown): value is EvidenceKind { return value === "job" || value === "persona" || value === "resume" || value === "source" }
