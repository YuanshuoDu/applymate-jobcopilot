export const ROLE_RESULT_SCHEMA = "agent-harness.v2.subagent.result" as const
export const ARTIFACT_REFERENCE_SCHEMA = "agent-harness.v2.subagent.artifact-reference" as const
export const REVIEW_STATUSES = ["passed", "needs_revision", "rejected", "stale"] as const
type JsonSchema = Record<string, unknown>
const evidenceSchema: JsonSchema = { type: "object", properties: { id: { type: "string", minLength: 1 }, kind: { type: "string", enum: ["job", "persona", "resume", "source"] }, ref: { type: "string", minLength: 1 }, source: { type: "string", minLength: 1 } }, required: ["id", "kind", "ref", "source"], additionalProperties: false }
const evidenceIdsSchema: JsonSchema = { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 }
const baseSchema = (items: JsonSchema, itemName: "candidates" | "findings"): JsonSchema => ({ type: "object", properties: { schemaVersion: { const: ROLE_RESULT_SCHEMA }, role: { const: itemName === "candidates" ? "scout" : "analyst" }, status: { type: "string", enum: ["completed", "partial"] }, [itemName]: { type: "array", items, }, evidence: { type: "array", items: evidenceSchema }, summary: { type: "string" } }, required: ["schemaVersion", "role", "status", itemName, "evidence", "summary"], additionalProperties: false })
const candidateSchema: JsonSchema = { type: "object", properties: { jobId: { type: "string", minLength: 1 }, source: { type: "string", minLength: 1 }, url: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] }, evidenceIds: evidenceIdsSchema }, required: ["jobId", "source", "url", "evidenceIds"], additionalProperties: false }
const findingSchema: JsonSchema = { type: "object", properties: { jobId: { type: "string", minLength: 1 }, score: { type: "number", minimum: 0, maximum: 10 }, evidenceIds: evidenceIdsSchema }, required: ["jobId", "score", "evidenceIds"], additionalProperties: false }
export const SCOUT_ROLE_RESULT_OUTPUT_SCHEMA: JsonSchema = baseSchema(candidateSchema, "candidates")
export const ANALYST_ROLE_RESULT_OUTPUT_SCHEMA: JsonSchema = baseSchema(findingSchema, "findings")
const artifactRefSchema: JsonSchema = { type: "object", properties: { artifactId: { type: "string", minLength: 1, maxLength: 256 }, version: { type: "integer", minimum: 1 }, contentHash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" }, sourceDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" } }, required: ["artifactId", "version", "contentHash", "sourceDigest"], additionalProperties: false }
export const WRITER_ROLE_RESULT_OUTPUT_SCHEMA: JsonSchema = { type: "object", properties: { schemaVersion: { const: ROLE_RESULT_SCHEMA }, role: { const: "writer" }, status: { const: "completed" }, artifactRef: artifactRefSchema }, required: ["schemaVersion", "role", "status", "artifactRef"], additionalProperties: false }
export const REVIEWER_ROLE_RESULT_OUTPUT_SCHEMA: JsonSchema = { type: "object", properties: { schemaVersion: { const: ROLE_RESULT_SCHEMA }, role: { const: "reviewer" }, status: { const: "completed" }, artifactRef: artifactRefSchema, reviewStatus: { type: "string", enum: REVIEW_STATUSES }, reviewHash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" } }, required: ["schemaVersion", "role", "status", "artifactRef", "reviewStatus", "reviewHash"], additionalProperties: false }
export type StructuredRole = "scout" | "analyst" | "writer" | "reviewer"
export function roleResultOutputSchema(role: StructuredRole): JsonSchema {
  if (role === "scout") return SCOUT_ROLE_RESULT_OUTPUT_SCHEMA
  if (role === "analyst") return ANALYST_ROLE_RESULT_OUTPUT_SCHEMA
  return role === "writer" ? WRITER_ROLE_RESULT_OUTPUT_SCHEMA : REVIEWER_ROLE_RESULT_OUTPUT_SCHEMA
}
export type RoleResultStatus = "completed" | "partial"
export type EvidenceKind = "job" | "persona" | "resume" | "source"

export type RoleEvidence = {
  readonly id: string
  readonly kind: EvidenceKind
  readonly ref: string
  readonly source: string
}

export type ScoutCandidate = {
  readonly jobId: string
  readonly source: string
  readonly url: string | null
  readonly evidenceIds: readonly string[]
}

export type ScoutResult = {
  readonly schemaVersion: typeof ROLE_RESULT_SCHEMA
  readonly role: "scout"
  readonly status: RoleResultStatus
  readonly candidates: readonly ScoutCandidate[]
  readonly evidence: readonly RoleEvidence[]
  readonly summary: string
}

export type AnalystFinding = {
  readonly jobId: string
  readonly score: number
  readonly evidenceIds: readonly string[]
}

export type AnalystResult = {
  readonly schemaVersion: typeof ROLE_RESULT_SCHEMA
  readonly role: "analyst"
  readonly status: RoleResultStatus
  readonly findings: readonly AnalystFinding[]
  readonly evidence: readonly RoleEvidence[]
  readonly summary: string
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

export type StructuredRoleResult = ScoutResult | AnalystResult | WriterResult | ReviewerResult

export function structuredRoleOutputGuidance(role: string, marker: unknown): string | null {
  try {
    if (!isRole(role) || !marker || typeof marker !== "object" || Array.isArray(marker)) return null
    const value = marker as Record<string, unknown>
    const prototype = Object.getPrototypeOf(marker)
    if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(marker).length !== 0
      || Object.keys(value).sort().join(",") !== "role,schemaVersion" || value.schemaVersion !== ROLE_RESULT_SCHEMA || value.role !== role) return null
    if (role === "writer") return "SERVER STRUCTURED RESULT CONTRACT: Final output must be one JSON object with exactly schemaVersion, role, status, and artifactRef. status must be completed. artifactRef must contain only artifactId, version, contentHash, and sourceDigest from the successful cover_letter.draft tool result. Read the base artifact ID and hash from runtimeContext.coverLetterBase. Never include cover-letter content, findings, identity, lease, capability, permission, or authorization data."
    if (role === "reviewer") return "SERVER STRUCTURED RESULT CONTRACT: Final output must be one JSON object with exactly schemaVersion, role, status, artifactRef, reviewStatus, and reviewHash. status must be completed. Copy artifactRef and the review receipt only from the successful artifact.review tool result. Never include draft content, findings, identity, lease, capability, permission, or authorization data."
    return "SERVER STRUCTURED RESULT CONTRACT: Final output must be one JSON object with exactly schemaVersion, role, status, candidates (scout) or findings (analyst), evidence, and summary. evidenceIds must reference evidence in this same result. status must be completed or partial. Do not include extra fields or identity, lease, capability, permission, or authorization data."
  } catch {
    return null
  }
}

export class RoleResultValidationError extends Error {
  constructor(readonly code: "invalid_shape" | "missing_id" | "missing_evidence" | "invalid_score", message: string) {
    super(message)
    this.name = "RoleResultValidationError"
  }
}

const FORBIDDEN_RESULT_KEYS = new Set([
  "userId", "sessionId", "turnId", "stepId", "taskId", "parentTaskId", "rootTaskId", "ownerId", "lease",
  "leaseOwnerId", "leaseVersion", "idempotencyKey", "capabilities", "permissions", "allowedCapabilities", "budgetLimit", "maxBudget",
])
const SCOUT_RESULT_KEYS = ["schemaVersion", "role", "status", "candidates", "evidence", "summary"] as const
const ANALYST_RESULT_KEYS = ["schemaVersion", "role", "status", "findings", "evidence", "summary"] as const
const EVIDENCE_KEYS = ["id", "kind", "ref", "source"] as const
const CANDIDATE_KEYS = ["jobId", "source", "url", "evidenceIds"] as const
const FINDING_KEYS = ["jobId", "score", "evidenceIds"] as const
const ARTIFACT_REF_KEYS = ["artifactId", "version", "contentHash", "sourceDigest"] as const
const SAFE_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const WRITER_RESULT_KEYS = ["schemaVersion", "role", "status", "artifactRef"] as const
const REVIEWER_RESULT_KEYS = ["schemaVersion", "role", "status", "artifactRef", "reviewStatus", "reviewHash"] as const

export function validateRoleResult<T extends StructuredRole>(value: unknown, expectedRole: T): Extract<StructuredRoleResult, { role: T }>
export function validateRoleResult(value: unknown): StructuredRoleResult
export function validateRoleResult(value: unknown, expectedRole?: StructuredRole): StructuredRoleResult {
  if (!plainJson(value)) throw new RoleResultValidationError("invalid_shape", "Structured subagent result has an invalid JSON shape")
  const row = record(value)
  if (row.schemaVersion !== ROLE_RESULT_SCHEMA || !isRole(row.role) || (expectedRole && row.role !== expectedRole)) {
    throw new RoleResultValidationError("invalid_shape", "Structured subagent result has an invalid schema or role")
  }
  if (row.role === "writer" || row.role === "reviewer") return parseArtifactRoleResult(row)
  if (!exactKeys(row, row.role === "scout" ? SCOUT_RESULT_KEYS : ANALYST_RESULT_KEYS)) throw new RoleResultValidationError("invalid_shape", "Structured subagent result has an invalid field set")
  if (!isStatus(row.status) || typeof row.summary !== "string") throw new RoleResultValidationError("invalid_shape", "Structured subagent result has invalid status or summary")
  const evidence = parseEvidence(row.evidence)
  return row.role === "scout"
    ? { schemaVersion: ROLE_RESULT_SCHEMA, role: row.role, status: row.status, candidates: parseCandidates(row.candidates, evidence), evidence, summary: row.summary }
    : { schemaVersion: ROLE_RESULT_SCHEMA, role: row.role, status: row.status, findings: parseFindings(row.findings, evidence), evidence, summary: row.summary }
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
function plainJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object" || seen.has(value)) return false
  try {
    if (!Array.isArray(value)) {
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) return false
    }
    if (Object.getOwnPropertySymbols(value).length > 0 || Object.keys(value).some(key => FORBIDDEN_RESULT_KEYS.has(key))) return false
    seen.add(value)
    const valid = Object.values(value).every(child => plainJson(child, seen))
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
function isRole(value: unknown): value is StructuredRole { return value === "scout" || value === "analyst" || value === "writer" || value === "reviewer" }
function isStatus(value: unknown): value is RoleResultStatus { return value === "completed" || value === "partial" }
function isReviewStatus(value: unknown): value is typeof REVIEW_STATUSES[number] { return typeof value === "string" && (REVIEW_STATUSES as readonly string[]).includes(value) }
function isDigest(value: unknown): value is string { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value) }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 }
function parseEvidence(value: unknown): RoleEvidence[] {
  if (!Array.isArray(value)) throw new RoleResultValidationError("invalid_shape", "Evidence must be an array")
  const ids = new Set<string>()
  return value.map(item => {
    const row = record(item)
    if (!exactKeys(row, EVIDENCE_KEYS)) throw new RoleResultValidationError("invalid_shape", "Evidence has an invalid field set")
    if (!nonEmpty(row.id) || !nonEmpty(row.ref) || !nonEmpty(row.source) || !isEvidenceKind(row.kind)) throw new RoleResultValidationError("missing_id", "Evidence requires id, kind, ref and source")
    if (ids.has(row.id)) throw new RoleResultValidationError("invalid_shape", `Duplicate evidence id: ${row.id}`)
    ids.add(row.id)
    return { id: row.id, kind: row.kind, ref: row.ref, source: row.source }
  })
}
function evidenceIds(value: unknown, evidence: readonly RoleEvidence[]): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(nonEmpty)) throw new RoleResultValidationError("missing_evidence", "Every result item needs evidence ids")
  const available = new Set(evidence.map(item => item.id))
  if (!value.every(id => available.has(id))) throw new RoleResultValidationError("missing_evidence", "Result references unknown evidence")
  return [...new Set(value)]
}
function evidenceForJob(value: unknown, jobId: string, evidence: readonly RoleEvidence[]): string[] {
  const ids = evidenceIds(value, evidence)
  if (!ids.some(id => evidence.some(item => item.id === id && item.kind === "job" && item.ref === jobId))) {
    throw new RoleResultValidationError("missing_evidence", `Job ${jobId} needs job evidence with the same real id`)
  }
  return ids
}
function parseCandidates(value: unknown, evidence: readonly RoleEvidence[]): ScoutCandidate[] {
  if (!Array.isArray(value)) throw new RoleResultValidationError("invalid_shape", "Scout candidates must be an array")
  return value.map(item => { const row = record(item); if (!exactKeys(row, CANDIDATE_KEYS)) throw new RoleResultValidationError("invalid_shape", "Scout candidate has an invalid field set"); if (!nonEmpty(row.jobId) || !nonEmpty(row.source) || (row.url !== null && !nonEmpty(row.url))) throw new RoleResultValidationError("missing_id", "Scout candidate requires a job id and source"); return { jobId: row.jobId, source: row.source, url: row.url as string | null, evidenceIds: evidenceForJob(row.evidenceIds, row.jobId, evidence) } })
}
function parseFindings(value: unknown, evidence: readonly RoleEvidence[]): AnalystFinding[] {
  if (!Array.isArray(value)) throw new RoleResultValidationError("invalid_shape", "Analyst findings must be an array")
  return value.map(item => { const row = record(item); if (!exactKeys(row, FINDING_KEYS)) throw new RoleResultValidationError("invalid_shape", "Analyst finding has an invalid field set"); if (!nonEmpty(row.jobId) || typeof row.score !== "number" || !Number.isFinite(row.score) || row.score < 0 || row.score > 10) throw new RoleResultValidationError(row.jobId ? "invalid_score" : "missing_id", "Analyst finding requires a job id and a score from 0 to 10"); return { jobId: row.jobId, score: row.score, evidenceIds: evidenceForJob(row.evidenceIds, row.jobId, evidence) } })
}
function isEvidenceKind(value: unknown): value is EvidenceKind { return value === "job" || value === "persona" || value === "resume" || value === "source" }
