export type ObjectiveJobRequirementCitation = Readonly<{ evidenceId: string; quote: string }>
export type ObjectiveJobRequirementProposal = Readonly<{ jobId: string; evidenceId: string; quote: string }>
type Evidence = Readonly<{ id: string; kind: string; ref: string }>
type Row = Record<string, unknown>

const RESULT_SCHEMA = "agent-harness.v2.subagent.result"
const MAX_CITATIONS = 8
const MAX_JOB_IDS = 8
const MAX_FINDINGS = 512
const MAX_EVIDENCE = 1024
const MAX_FINDING_EVIDENCE = 1024
const MAX_QUOTE_LENGTH = 512
const JOB_ID = /^(?:c[a-z0-9]{24}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/
const EVIDENCE_KINDS = new Set(["job", "persona", "resume", "source"])

/** Parses the optional citation field without changing the containing Analyst result. */
export function parseObjectiveJobRequirementCitations(value: unknown, jobId: string, findingEvidenceIds: readonly string[], evidence: readonly Evidence[]): ObjectiveJobRequirementCitation[] | undefined {
  if (!dense(value, MAX_CITATIONS) || value.length < 1) return undefined
  const seen = new Set<string>(), parsed: ObjectiveJobRequirementCitation[] = []
  for (const item of value) {
    const row = record(item)
    if (!row || !exact(row, "evidenceId,quote") || !nonEmpty(row.evidenceId) || row.evidenceId.length > 512
      || !nonEmpty(row.quote) || row.quote.length > MAX_QUOTE_LENGTH || !findingEvidenceIds.includes(row.evidenceId)
      || !evidence.some(entry => entry.id === row.evidenceId && entry.kind === "job" && entry.ref === jobId)) return undefined
    const key = `${row.evidenceId}\u0000${row.quote}`
    if (seen.has(key)) return undefined
    seen.add(key)
    parsed.push({ evidenceId: row.evidenceId, quote: row.quote })
  }
  return parsed
}

/** Extracts only citations bound to a same-finding Job evidence reference. */
export function objectiveJobRequirementProposals(result: unknown, jobIds: readonly string[]): ObjectiveJobRequirementProposal[] | null {
  try {
  if (!dense(jobIds, MAX_JOB_IDS) || new Set(jobIds).size !== jobIds.length || jobIds.some(id => typeof id !== "string" || !JOB_ID.test(id))) return null
  const row = record(result)
  if (!row || !exact(row, "evidence,findings,role,schemaVersion,status,summary") || row.schemaVersion !== RESULT_SCHEMA
    || row.role !== "analyst" || (row.status !== "completed" && row.status !== "partial")
    || typeof row.summary !== "string" || row.summary.length > 65_536
    || !dense(row.evidence, MAX_EVIDENCE) || !dense(row.findings, MAX_FINDINGS)) return null
  const evidence: Evidence[] = []
  const evidenceById = new Map<string, Evidence>()
  for (const value of row.evidence) {
    const item = record(value)
    if (!item || !exact(item, "id,kind,ref,source") || !boundedText(item.id, 512) || !boundedText(item.ref, 512)
      || !boundedText(item.source, 256) || typeof item.kind !== "string" || !EVIDENCE_KINDS.has(item.kind)
      || evidenceById.has(item.id)) return null
    const parsed = { id: item.id, kind: item.kind, ref: item.ref }
    evidenceById.set(item.id, parsed)
    evidence.push(parsed)
  }
  const selected = new Set(jobIds), proposals: ObjectiveJobRequirementProposal[] = []
  for (const value of row.findings) {
    const finding = record(value)
    if (!finding || !exact(finding, "evidenceIds,jobId,score", "requirementCitations") || !nonEmpty(finding.jobId)
      || typeof finding.score !== "number" || !Number.isFinite(finding.score) || finding.score < 0 || finding.score > 10
      || !dense(finding.evidenceIds, MAX_FINDING_EVIDENCE) || finding.evidenceIds.length === 0 || !finding.evidenceIds.every(nonEmpty)) return null
    const findingIds = finding.evidenceIds as string[], uniqueFindingIds = new Set(findingIds)
    if (uniqueFindingIds.size !== findingIds.length || findingIds.some(id => !evidenceById.has(id))
      || !findingIds.some(id => { const entry = evidenceById.get(id); return entry?.kind === "job" && entry.ref === finding.jobId })) return null
    if (!selected.has(finding.jobId) || !Object.hasOwn(finding, "requirementCitations") || finding.requirementCitations === null) continue
    const citations = parseObjectiveJobRequirementCitations(finding.requirementCitations, finding.jobId, finding.evidenceIds, evidence)
    if (citations) proposals.push(...citations.map(citation => ({ jobId: finding.jobId as string, ...citation })))
  }
  return proposals
  } catch { return null }
}

/** JavaScript string indices are UTF-16 offsets; only one literal occurrence is authoritative. */
export function uniqueObjectiveRequirementQuoteOffsets(description: unknown, quote: unknown): Readonly<{ startUtf16: number; endUtf16: number }> | undefined {
  if (typeof description !== "string" || typeof quote !== "string" || quote.length < 1 || quote.length > MAX_QUOTE_LENGTH) return undefined
  const startUtf16 = description.indexOf(quote)
  if (startUtf16 < 0 || description.indexOf(quote, startUtf16 + 1) >= 0) return undefined
  return { startUtf16, endUtf16: startUtf16 + quote.length }
}

function exact(row: Row, required: string, optional?: string): boolean {
  const keys = required.split(","), extra = optional ? optional.split(",") : [], actual = Reflect.ownKeys(row)
  return actual.length >= keys.length && actual.length <= keys.length + extra.length
    && actual.every(key => typeof key === "string" && [...keys, ...extra].includes(key)
      && Boolean(Object.getOwnPropertyDescriptor(row, key)?.enumerable && "value" in Object.getOwnPropertyDescriptor(row, key)!))
    && keys.every(key => Object.hasOwn(row, key))
}
function record(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null ? value as Row : undefined } catch { return undefined }
}
function dense(value: unknown, maxItems: number): value is unknown[] {
  if (!Array.isArray(value)) return false
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > maxItems) return false
    const keys = Reflect.ownKeys(value)
    if (keys.length !== value.length + 1 || !keys.includes("length")) return false
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !("value" in descriptor)) return false
    }
    return true
  } catch { return false }
}
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 }
function boundedText(value: unknown, max: number): value is string { return nonEmpty(value) && value.length <= max }
