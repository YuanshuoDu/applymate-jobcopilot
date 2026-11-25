export const ROLE_RESULT_SCHEMA = "agent-harness.v2.subagent.result" as const
const EVIDENCE_KEYS = ["id", "kind", "ref", "source"] as const
const CANDIDATE_KEYS = ["jobId", "source", "url", "evidenceIds"] as const
const FINDING_KEYS = ["jobId", "score", "evidenceIds"] as const
const CITATION_KEYS = ["evidenceId", "quote"] as const
const MAX_CITATIONS = 8
const MAX_QUOTE_LENGTH = 512
type Row = Record<string, unknown>
type JsonSchema = Record<string, unknown>

export type RoleResultStatus = "completed" | "partial"
export type EvidenceKind = "job" | "persona" | "resume" | "source"
export type RoleEvidence = Readonly<{ id: string; kind: EvidenceKind; ref: string; source: string }>
export type ScoutCandidate = Readonly<{ jobId: string; source: string; url: string | null; evidenceIds: readonly string[] }>
export type AnalystRequirementCitation = Readonly<{ evidenceId: string; quote: string }>
export type AnalystFinding = Readonly<{ jobId: string; score: number; evidenceIds: readonly string[];
  requirementCitations?: readonly AnalystRequirementCitation[] }>
export type ScoutResult = Readonly<{ schemaVersion: typeof ROLE_RESULT_SCHEMA; role: "scout"; status: RoleResultStatus;
  candidates: readonly ScoutCandidate[]; evidence: readonly RoleEvidence[]; summary: string }>
export type AnalystResult = Readonly<{ schemaVersion: typeof ROLE_RESULT_SCHEMA; role: "analyst"; status: RoleResultStatus;
  findings: readonly AnalystFinding[]; evidence: readonly RoleEvidence[]; summary: string }>

export class RoleResultValidationError extends Error {
  constructor(readonly code: "invalid_shape" | "missing_id" | "missing_evidence" | "invalid_score", message: string) {
    super(message)
    this.name = "RoleResultValidationError"
  }
}

const evidenceSchema: JsonSchema = { type: "object", properties: { id: { type: "string", minLength: 1 },
  kind: { type: "string", enum: ["job", "persona", "resume", "source"] }, ref: { type: "string", minLength: 1 },
  source: { type: "string", minLength: 1 } }, required: ["id", "kind", "ref", "source"], additionalProperties: false }
const evidenceIdsSchema: JsonSchema = { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 }
const citationSchema: JsonSchema = { type: "object", properties: { evidenceId: { type: "string", minLength: 1, maxLength: 512 },
  quote: { type: "string", minLength: 1, maxLength: MAX_QUOTE_LENGTH } }, required: CITATION_KEYS, additionalProperties: false }
const citationsSchema: JsonSchema = { anyOf: [{ type: "array", maxItems: MAX_CITATIONS, items: citationSchema }, { type: "null" }] }
const baseSchema = (items: JsonSchema, itemName: "candidates" | "findings"): JsonSchema => ({ type: "object", properties: {
  schemaVersion: { const: ROLE_RESULT_SCHEMA }, role: { const: itemName === "candidates" ? "scout" : "analyst" },
  status: { type: "string", enum: ["completed", "partial"] }, [itemName]: { type: "array", items },
  evidence: { type: "array", items: evidenceSchema }, summary: { type: "string" } },
required: ["schemaVersion", "role", "status", itemName, "evidence", "summary"], additionalProperties: false })
const candidateSchema: JsonSchema = { type: "object", properties: { jobId: { type: "string", minLength: 1 },
  source: { type: "string", minLength: 1 }, url: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
  evidenceIds: evidenceIdsSchema }, required: CANDIDATE_KEYS, additionalProperties: false }
const findingSchema: JsonSchema = { type: "object", properties: { jobId: { type: "string", minLength: 1 },
  score: { type: "number", minimum: 0, maximum: 10 }, evidenceIds: evidenceIdsSchema, requirementCitations: citationsSchema },
required: [...FINDING_KEYS, "requirementCitations"], additionalProperties: false }
export const SCOUT_ROLE_RESULT_OUTPUT_SCHEMA = baseSchema(candidateSchema, "candidates")
export const ANALYST_ROLE_RESULT_OUTPUT_SCHEMA = baseSchema(findingSchema, "findings")

/** JavaScript string indices are UTF-16 offsets; only one literal occurrence is authoritative. */
export function uniqueRequirementQuoteOffsets(description: unknown, quote: unknown): Readonly<{ startUtf16: number; endUtf16: number }> | undefined {
  if (typeof description !== "string" || typeof quote !== "string" || quote.length < 1 || quote.length > MAX_QUOTE_LENGTH) return undefined
  const startUtf16 = description.indexOf(quote)
  if (startUtf16 < 0 || description.indexOf(quote, startUtf16 + 1) >= 0) return undefined
  return { startUtf16, endUtf16: startUtf16 + quote.length }
}

/** Keeps malformed optional citations from invalidating the Analyst's score and ordinary result. */
export function parseScoutAnalystResult(row: Row): ScoutResult | AnalystResult {
  if (row.role !== "scout" && row.role !== "analyst") throw new RoleResultValidationError("invalid_shape", "Result role is invalid")
  if (row.role === "scout" && !exactKeys(row, ["schemaVersion", "role", "status", "candidates", "evidence", "summary"])
    || row.role === "analyst" && !exactKeys(row, ["schemaVersion", "role", "status", "findings", "evidence", "summary"], true)) {
    throw new RoleResultValidationError("invalid_shape", "Structured subagent result has an invalid field set")
  }
  if (!isStatus(row.status) || typeof row.summary !== "string") throw new RoleResultValidationError("invalid_shape", "Structured subagent result has invalid status or summary")
  const evidence = parseEvidence(row.evidence)
  if (row.role === "scout") return { schemaVersion: ROLE_RESULT_SCHEMA, role: row.role, status: row.status,
    candidates: parseCandidates(row.candidates, evidence), evidence, summary: row.summary }
  return { schemaVersion: ROLE_RESULT_SCHEMA, role: row.role, status: row.status,
    findings: parseFindings(row.findings, evidence), evidence, summary: row.summary }
}

function parseEvidence(value: unknown): RoleEvidence[] {
  if (!Array.isArray(value)) throw new RoleResultValidationError("invalid_shape", "Evidence must be an array")
  const ids = new Set<string>()
  return value.map(item => {
    const row = record(item)
    if (!row || !exactKeys(row, EVIDENCE_KEYS)) throw new RoleResultValidationError("invalid_shape", "Evidence has an invalid field set")
    if (!nonEmpty(row.id) || !nonEmpty(row.ref) || !nonEmpty(row.source) || !isEvidenceKind(row.kind)) {
      throw new RoleResultValidationError("missing_id", "Evidence requires id, kind, ref and source")
    }
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
  return value.map(item => {
    const row = record(item)
    if (!row || !exactKeys(row, CANDIDATE_KEYS)) throw new RoleResultValidationError("invalid_shape", "Scout candidate has an invalid field set")
    if (!nonEmpty(row.jobId) || !nonEmpty(row.source) || (row.url !== null && !nonEmpty(row.url))) {
      throw new RoleResultValidationError("missing_id", "Scout candidate requires a job id and source")
    }
    return { jobId: row.jobId, source: row.source, url: row.url as string | null, evidenceIds: evidenceForJob(row.evidenceIds, row.jobId, evidence) }
  })
}
function parseFindings(value: unknown, evidence: readonly RoleEvidence[]): AnalystFinding[] {
  if (!Array.isArray(value)) throw new RoleResultValidationError("invalid_shape", "Analyst findings must be an array")
  return value.map(item => {
    const row = record(item)
    if (!row || !exactKeys(row, FINDING_KEYS, true)) throw new RoleResultValidationError("invalid_shape", "Analyst finding has an invalid field set")
    if (!nonEmpty(row.jobId) || typeof row.score !== "number" || !Number.isFinite(row.score) || row.score < 0 || row.score > 10) {
      throw new RoleResultValidationError(row?.jobId ? "invalid_score" : "missing_id", "Analyst finding requires a job id and a score from 0 to 10")
    }
    const ids = evidenceForJob(row.evidenceIds, row.jobId, evidence)
    const finding = { jobId: row.jobId, score: row.score, evidenceIds: ids }
    if (!Object.hasOwn(row, "requirementCitations")) return finding
    if (row.requirementCitations === null) return finding
    const citations = parseRequirementCitations(row.requirementCitations, row.jobId, ids, evidence)
    return citations ? { ...finding, requirementCitations: citations } : finding
  })
}
function parseRequirementCitations(value: unknown, jobId: string, ids: readonly string[], evidence: readonly RoleEvidence[]): AnalystRequirementCitation[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CITATIONS || Reflect.ownKeys(value).length !== value.length + 1) return undefined
  const seen = new Set<string>(), parsed: AnalystRequirementCitation[] = []
  for (const item of value) {
    const row = record(item)
    if (!row || !exactKeys(row, CITATION_KEYS) || !nonEmpty(row.evidenceId) || row.evidenceId.length > 512
      || !nonEmpty(row.quote) || row.quote.length > MAX_QUOTE_LENGTH || !ids.includes(row.evidenceId)
      || !evidence.some(entry => entry.id === row.evidenceId && entry.kind === "job" && entry.ref === jobId)) return undefined
    const key = `${row.evidenceId}\u0000${row.quote}`
    if (seen.has(key)) return undefined
    seen.add(key)
    parsed.push({ evidenceId: row.evidenceId, quote: row.quote })
  }
  return parsed
}
function record(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null ? value as Row : undefined } catch { return undefined }
}
function exactKeys(value: Row, expected: readonly string[], optionalCitations = false): boolean {
  const allowed = optionalCitations ? [...expected, "requirementCitations"] : expected, actual = Reflect.ownKeys(value)
  return actual.every(key => typeof key === "string" && allowed.includes(key) && Boolean(Object.getOwnPropertyDescriptor(value, key)?.enumerable
    && "value" in Object.getOwnPropertyDescriptor(value, key)!)) && expected.every(key => Object.hasOwn(value, key))
}
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 }
function isStatus(value: unknown): value is RoleResultStatus { return value === "completed" || value === "partial" }
function isEvidenceKind(value: unknown): value is EvidenceKind { return value === "job" || value === "persona" || value === "resume" || value === "source" }
