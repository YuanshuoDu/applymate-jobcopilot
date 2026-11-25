import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { redactSensitiveValue } from "./agent-redaction.js"
import { uniqueObjectiveRequirementQuoteOffsets, type ObjectiveJobRequirementProposal } from "./objective-job-requirement-citations.js"

export { objectiveJobRequirementProposals, parseObjectiveJobRequirementCitations, uniqueObjectiveRequirementQuoteOffsets } from "./objective-job-requirement-citations.js"
export type { ObjectiveJobRequirementCitation, ObjectiveJobRequirementProposal } from "./objective-job-requirement-citations.js"

type Row = Record<string, unknown>
const JOB_ID = /^(?:c[a-z0-9]{24}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/
const JOB_KEYS = "company,description,id,keywords,location,role,salary,score,source,status,url"
const MATERIAL_KEYS = "company,description,id,keywords,location,role,salary,source,url"
const MAX_DELIVERIES = 8
const MAX_CANDIDATES = 1024
const MAX_OUTPUT_BYTES = 512 * 1024

export type ObjectiveJobRequirementDeliveryCandidate = Readonly<{
  call: Readonly<{ id: string; stepId: string; attempt: number; ordinal: number; revision: number }>
  callContent: Readonly<{ toolCallId: string; toolName: string; toolVersion: string; input: unknown; status: string; errorCode: unknown }>
  outcome: "completed" | "failed" | null
  result: Readonly<{ id: string; stepId: string; attempt: number; ordinal: number; revision: number }> | null
  resultContent: Readonly<{ toolCallId: string; output: unknown; status: string; errorCode: unknown }> | null
  replay: Readonly<{ currentCallId: string; sourceCallItemId: string; sourceResultItemId: string }> | null
}>

export type ObjectiveJobRequirementDeliveryVerification = Readonly<{
  inputJobId: string; outputJobId: string; toolVersion: string; inputDigest: string; outputDigest: string
  jobMaterialDigest: string; quoteDigest: string; startUtf16: number; endUtf16: number
  deliveries: readonly Readonly<{ toolCallId: string; callItemId: string; callItemRevision: number; resultItemId: string;
    resultItemRevision: number; replaySourceCallItemId?: string; replaySourceResultItemId?: string }>[]
}>

/** Recomputes the existing scheduled-draft Job material digest for shared server adapters. */
export function objectiveJobRequirementMaterialDigest(value: unknown): string | null {
  try {
    const source = record(value)
    if (!source || !exact(source, JOB_KEYS) || !canonicalJobId(source.id)) return null
    const redacted = record(redactSensitiveValue({ job: source })), job = record(redacted?.job)
    if (!redacted || !exact(redacted, "job") || !job || !exact(job, JOB_KEYS)) return null
    const encoded = JSON.stringify(redacted)
    if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_OUTPUT_BYTES || truncated(redacted)) return null
    const restored = { ...job, id: source.id }, material = materialJob(restored)
    if (!material) return null
    return `sha256:${sha256(canonicalJson(material))}`
  } catch { return null }
}

/** Verifies a single proposal against bounded exact-attempt tool evidence and current Job material. */
export function verifyObjectiveJobRequirementEvidence(value: unknown): ObjectiveJobRequirementDeliveryVerification | null {
  try {
    const input = record(value)
    if (!input || !exact(input, "attemptCount,currentJob,deliveries,proposal")) return null
    const proposal = record(input.proposal), current = record(input.currentJob)
    if (!proposal || !exact(proposal, "evidenceId,jobId,quote") || !canonicalJobId(proposal.jobId)
      || !text(proposal.evidenceId) || !text(proposal.quote) || proposal.quote.length > 512
      || !Number.isSafeInteger(input.attemptCount) || Number(input.attemptCount) < 1 || !current || !exact(current, JOB_KEYS)
      || current.id !== proposal.jobId || typeof current.description !== "string"
      || !Array.isArray(input.deliveries) || input.deliveries.length > MAX_CANDIDATES || !dense(input.deliveries)) return null
    const currentDigest = objectiveJobRequirementMaterialDigest(current)
    if (!currentDigest) return null
    const rows = selectDeliveries(input.deliveries, proposal.jobId, Number(input.attemptCount))
    if (!rows || !rows.length) return null
    const first = rows[0]!, inputDigest = digest(first.input), outputDigest = digest(first.output)
    if (!inputDigest || !outputDigest || rows.some(row => row.toolVersion !== first.toolVersion
      || digest(row.input) !== inputDigest || digest(row.output) !== outputDigest)) return null
    const offsets = uniqueObjectiveRequirementQuoteOffsets(first.job.description, proposal.quote)
    const outputMaterialDigest = objectiveJobRequirementMaterialDigest(first.job)
    if (!offsets || !outputMaterialDigest || outputMaterialDigest !== currentDigest || first.job.id !== current.id
      || first.job.description !== current.description) return null
    return { inputJobId: proposal.jobId, outputJobId: first.job.id, toolVersion: first.toolVersion,
      inputDigest, outputDigest, jobMaterialDigest: currentDigest, quoteDigest: sha256(proposal.quote), ...offsets,
      deliveries: rows.map(row => ({ toolCallId: row.toolCallId, callItemId: row.callItemId,
        callItemRevision: row.callItemRevision, resultItemId: row.resultItemId, resultItemRevision: row.resultItemRevision,
        ...(row.replay ? { replaySourceCallItemId: row.replay.sourceCallItemId, replaySourceResultItemId: row.replay.sourceResultItemId } : {}) })) }
  } catch { return null }
}

type Selected = Readonly<{ toolCallId: string; callItemId: string; callItemRevision: number; resultItemId: string;
  resultItemRevision: number; input: unknown; output: unknown; job: Row; toolVersion: string;
  replay?: Readonly<{ sourceCallItemId: string; sourceResultItemId: string }> }>
function selectDeliveries(values: readonly unknown[], jobId: string, attemptCount: number): Selected[] | null {
  const matches: Selected[] = [], ids = new Set<string>(), itemIds = new Set<string>()
  for (const value of values) {
    const entry = record(value)
    if (!entry || !exact(entry, "call,callContent,outcome,replay,result,resultContent")) return null
    const call = record(entry.call), callContent = record(entry.callContent), result = record(entry.result), resultContent = record(entry.resultContent)
    if (!call || !callContent || callContent.toolName !== "jobs.get") continue
    const callInput = record(callContent.input), outputJob = jobFrom(resultContent?.output)
    const inputJobId = callInput && ownData(callInput, "jobId")
    if (inputJobId !== jobId && outputJob?.id !== jobId) continue
    const replay = entry.replay === null ? undefined : replaySource(entry.replay, callContent.toolCallId)
    if (!replay && entry.replay !== null || !result || !resultContent || !exact(call, "attempt,id,ordinal,revision,stepId")
      || !exact(callContent, "errorCode,input,status,toolCallId,toolName,toolVersion")
      || !exact(result, "attempt,id,ordinal,revision,stepId") || !exact(resultContent, "errorCode,output,status,toolCallId")
      || !outputJob || !canonicalJobId(outputJob.id) || !exact(callInput!, "jobId") || callInput!.jobId !== outputJob.id
      || callContent.toolVersion !== "1" || callContent.status !== "completed" || callContent.errorCode !== null
      || resultContent.status !== "completed" || resultContent.errorCode !== null
      || resultContent.toolCallId !== callContent.toolCallId || entry.outcome !== "completed"
      || call.stepId !== result.stepId || call.attempt !== attemptCount || result.attempt !== attemptCount
      || call.ordinal !== result.ordinal || typeof call.ordinal !== "number" || !Number.isSafeInteger(call.ordinal) || call.ordinal < 0
      || typeof call.revision !== "number" || !Number.isSafeInteger(call.revision) || call.revision < 0
      || typeof result.revision !== "number" || !Number.isSafeInteger(result.revision) || result.revision < 0
      || !text(call.id) || !text(result.id) || call.id === result.id || !text(callContent.toolCallId)
      || ids.has(callContent.toolCallId) || itemIds.has(call.id) || itemIds.has(result.id)) return null
    ids.add(callContent.toolCallId)
    itemIds.add(call.id); itemIds.add(result.id)
    matches.push({ toolCallId: callContent.toolCallId, callItemId: call.id, callItemRevision: Number(call.revision),
      resultItemId: result.id, resultItemRevision: Number(result.revision), input: callInput, output: resultContent.output,
      job: outputJob, toolVersion: callContent.toolVersion, ...(replay ? { replay } : {}) })
  }
  if (!matches.length || matches.length > MAX_DELIVERIES) return null
  matches.sort((left, right) => compare(left.callItemId, right.callItemId))
  if (matches.length > 1) {
    const direct = matches.filter(row => !row.replay)
    if (direct.length > 1) return null
    const source = direct.length === 1 ? `${direct[0]!.callItemId}\u0000${direct[0]!.resultItemId}`
      : matches[0]!.replay && `${matches[0]!.replay.sourceCallItemId}\u0000${matches[0]!.replay.sourceResultItemId}`
    if (!source || matches.some(row => row.replay && `${row.replay.sourceCallItemId}\u0000${row.replay.sourceResultItemId}` !== source)) return null
  }
  return matches
}

function replaySource(value: unknown, toolCallId: unknown): Selected["replay"] | undefined {
  const row = record(value)
  return row && exact(row, "currentCallId,sourceCallItemId,sourceResultItemId") && row.currentCallId === toolCallId
    && text(row.sourceCallItemId) && text(row.sourceResultItemId)
    ? { sourceCallItemId: row.sourceCallItemId, sourceResultItemId: row.sourceResultItemId } : undefined
}
function jobFrom(value: unknown): Row | undefined {
  const envelope = record(value), job = record(envelope?.job)
  return envelope && exact(envelope, "job") && job && exact(job, JOB_KEYS) && canonicalJobId(job.id) ? job : undefined
}
function materialJob(value: unknown): Row | undefined {
  const row = record(value)
  if (!row || !exact(row, JOB_KEYS) || !canonicalJobId(row.id) || !text(row.company) || !text(row.role)
    || typeof row.status !== "string" || row.score !== null && !Number.isInteger(row.score)
    || !nullableText(row.location) || !nullableText(row.url) || !nullableText(row.source) || !nullableText(row.salary)
    || !nullableText(row.description) || !nullableText(row.keywords)) return undefined
  const { company, description, id, keywords, location, role, salary, source, url } = row
  if (!nullableText(description) || !nullableText(keywords) || !nullableText(location) || !nullableText(salary) || !nullableText(source) || !nullableText(url)) return undefined
  return { id, company, description, keywords, location, role, salary, source, url }
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const row = record(value)
  if (row) return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new TypeError("objective_requirement_json_invalid")
  return encoded
}
function digest(value: unknown): string | undefined { try { return sha256(canonicalJson(value)) } catch { return undefined } }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex") }
function canonicalJobId(value: unknown): value is string { return typeof value === "string" && JOB_ID.test(value) }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.trim() === value }
function nullableText(value: unknown): value is string | null { return value === null || typeof value === "string" }
function exact(row: Row, csv: string): boolean {
  const keys = csv.split(","), actual = Reflect.ownKeys(row)
  return actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key)
    && Boolean(Object.getOwnPropertyDescriptor(row, key)?.enumerable && "value" in Object.getOwnPropertyDescriptor(row, key)!))
}
function ownData(row: Row, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, key)
  return descriptor?.enumerable && "value" in descriptor ? descriptor.value : undefined
}
function record(value: unknown): Row | undefined { if (!value || typeof value !== "object" || Array.isArray(value)) return undefined; try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null ? value as Row : undefined } catch { return undefined } }
function dense(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false
    const keys = Reflect.ownKeys(value)
    if (keys.length !== value.length + 1 || !keys.includes("length")) return false
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !("value" in descriptor)) return false
    }
    return true
  } catch { return false }
}
function truncated(value: unknown): boolean { return hasTruncation(value, new Set<object>(), 0) }
function hasTruncation(value: unknown, seen: Set<object>, depth: number): boolean {
  if (depth > 32 || value === "[TRUNCATED]" || typeof value === "string" && value.includes("...[TRUNCATED]")) return true
  if (!value || typeof value !== "object") return false
  if (seen.has(value)) return true
  seen.add(value)
  try {
    const row = record(value)
    if (row && row.truncated === true && typeof row.preview === "string" && Number.isSafeInteger(row.byteLength)) return true
    return (Array.isArray(value) ? value : row ? Object.values(row) : []).some(child => hasTruncation(child, seen, depth + 1))
  } finally { seen.delete(value) }
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
