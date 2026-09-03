export const ROLE_RESULT_SCHEMA = "agent-harness.v2.subagent.result" as const
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

export type StructuredRoleResult = ScoutResult | AnalystResult

export class RoleResultValidationError extends Error {
  constructor(readonly code: "invalid_shape" | "missing_id" | "missing_evidence" | "invalid_score", message: string) {
    super(message)
    this.name = "RoleResultValidationError"
  }
}

export function validateRoleResult(value: unknown, expectedRole?: "scout" | "analyst"): StructuredRoleResult {
  const row = record(value)
  if (row.schemaVersion !== ROLE_RESULT_SCHEMA || !isRole(row.role) || (expectedRole && row.role !== expectedRole)) {
    throw new RoleResultValidationError("invalid_shape", "Structured subagent result has an invalid schema or role")
  }
  if (!isStatus(row.status) || typeof row.summary !== "string") throw new RoleResultValidationError("invalid_shape", "Structured subagent result has invalid status or summary")
  const evidence = parseEvidence(row.evidence)
  return row.role === "scout"
    ? { schemaVersion: ROLE_RESULT_SCHEMA, role: row.role, status: row.status, candidates: parseCandidates(row.candidates, evidence), evidence, summary: row.summary }
    : { schemaVersion: ROLE_RESULT_SCHEMA, role: row.role, status: row.status, findings: parseFindings(row.findings, evidence), evidence, summary: row.summary }
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
function isRole(value: unknown): value is "scout" | "analyst" { return value === "scout" || value === "analyst" }
function isStatus(value: unknown): value is RoleResultStatus { return value === "completed" || value === "partial" }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 }
function parseEvidence(value: unknown): RoleEvidence[] {
  if (!Array.isArray(value)) throw new RoleResultValidationError("invalid_shape", "Evidence must be an array")
  const ids = new Set<string>()
  return value.map(item => {
    const row = record(item)
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
  return value.map(item => { const row = record(item); if (!nonEmpty(row.jobId) || !nonEmpty(row.source) || (row.url !== null && !nonEmpty(row.url))) throw new RoleResultValidationError("missing_id", "Scout candidate requires a job id and source"); return { jobId: row.jobId, source: row.source, url: row.url as string | null, evidenceIds: evidenceForJob(row.evidenceIds, row.jobId, evidence) } })
}
function parseFindings(value: unknown, evidence: readonly RoleEvidence[]): AnalystFinding[] {
  if (!Array.isArray(value)) throw new RoleResultValidationError("invalid_shape", "Analyst findings must be an array")
  return value.map(item => { const row = record(item); if (!nonEmpty(row.jobId) || typeof row.score !== "number" || !Number.isFinite(row.score) || row.score < 0 || row.score > 10) throw new RoleResultValidationError(row.jobId ? "invalid_score" : "missing_id", "Analyst finding requires a job id and a score from 0 to 10"); return { jobId: row.jobId, score: row.score, evidenceIds: evidenceForJob(row.evidenceIds, row.jobId, evidence) } })
}
function isEvidenceKind(value: unknown): value is EvidenceKind { return value === "job" || value === "persona" || value === "resume" || value === "source" }
