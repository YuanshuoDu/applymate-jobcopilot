import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import type pg from "pg"
import { canonicalTaskGraphJson } from "./task-graph-snapshot.js"
import { loadTaskGraphVerificationReceipts, type TaskGraphVerificationReceipts } from "./task-graph-pg-verification-receipts.js"
import type { TaskGraphVerificationScope } from "./task-graph-pg-verification-receipt-validation.js"
import { createPostgresReadToolDataSource } from "../tools/read-data-source.js"
import { isCanonicalJobId, redactJobReadOutput } from "../tools/job-read-output-redaction.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
const JOB_RECORD_KEYS = "company,description,id,keywords,location,role,salary,score,source,status,url"
const MAX_JOB_IDS = 512
const MAX_OUTPUT_BYTES = 512 * 1024
type JobMaterial = Readonly<{ id: string; company: string; description: string | null; keywords: string | null;
  location: string | null; role: string; salary: string | null; source: string | null; url: string | null }>

/** Reconstruct only exact, completed, inline Job material receipts for Analyst findings. */
export async function readScheduledDraftJobMaterialDigests(
  client: Queryable,
  scope: TaskGraphVerificationScope,
  jobIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (!validJobIds(jobIds)) return new Map()
  try {
    const receipts = await loadTaskGraphVerificationReceipts(client, scope)
    return materialDigests(receipts, jobIds)
  } catch {
    return new Map()
  }
}

/** Read current source through the same owner-fenced PoolClient used by admission. */
export async function readCurrentScheduledDraftJobMaterialDigest(
  client: Queryable,
  userId: string,
  jobId: string,
): Promise<string | null> {
  try {
    if (!text(userId) || !isCanonicalJobId(jobId)) return null
    const job = await createPostgresReadToolDataSource(client).getJob(userId, jobId)
    if (!job) return null
    return scheduledDraftJobMaterialDigest(job)
  } catch {
    return null
  }
}

/** Hash the exact current Job source using the same redaction and stable fields as a jobs.get receipt. */
export function scheduledDraftJobMaterialDigest(job: unknown): string | null {
  try {
    const row = record(job)
    if (!row || !isCanonicalJobId(row.id)) return null
    const redacted = redactJobReadOutput("jobs.get", { job }), encoded = JSON.stringify(redacted)
    if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_OUTPUT_BYTES || containsTruncation(redacted)) return null
    return jobMaterialDigest(redacted)
  } catch {
    return null
  }
}

function materialDigests(receipts: TaskGraphVerificationReceipts, jobIds: readonly string[]): ReadonlyMap<string, string> {
  const wanted = new Set(jobIds), results = new Map<string, Row>()
  for (const item of receipts.items) {
    if (item.type !== "tool_result") continue
    const content = record(item.content), callId = content && text(content.toolCallId) ? content.toolCallId : undefined
    if (callId) results.set(callId, content!)
  }
  const digests = new Map<string, string>(), conflicts = new Set<string>()
  for (const item of receipts.items) {
    if (item.type !== "tool_call") continue
    const call = record(item.content), callId = call && text(call.toolCallId) ? call.toolCallId : undefined
    if (!call || !callId || receipts.outcomes.get(callId) !== "completed" || call.toolName !== "jobs.get") continue
    const result = results.get(callId), output = result?.output, outputDigest = jobMaterialDigestsFromOutput(call.toolName, output, wanted)
    for (const [jobId, value] of outputDigest) {
      if (value === null) { digests.delete(jobId); conflicts.add(jobId); continue }
      const previous = digests.get(jobId)
      if (previous !== undefined && previous !== value) { digests.delete(jobId); conflicts.add(jobId) }
      else if (!conflicts.has(jobId)) digests.set(jobId, value)
    }
  }
  return digests
}

function jobMaterialDigestsFromOutput(toolName: unknown, value: unknown, wanted: ReadonlySet<string>): Map<string, string | null> {
  const result = new Map<string, string>(), row = record(value)
  if (!row || toolName !== "jobs.get") return result
  const encoded = JSON.stringify(value)
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_OUTPUT_BYTES || containsTruncation(value)) return result
  if (!exactKeys(row, "job")) return result
  const job = row.job === null ? undefined : materialJob(row.job)
  if (job && wanted.has(job.id)) result.set(job.id, digestMaterial(job))
  return result
}

function jobMaterialDigest(value: unknown): string | null {
  const envelope = record(value)
  if (!envelope || !exactKeys(envelope, "job")) return null
  const job = materialJob(envelope.job)
  return job ? digestMaterial(job) : null
}

function materialJob(value: unknown): JobMaterial | undefined {
  const row = record(value)
  if (!row || !exactKeys(row, JOB_RECORD_KEYS) || !isCanonicalJobId(row.id) || !text(row.company) || !text(row.role)
    || typeof row.status !== "string" || row.score !== null && !Number.isInteger(row.score)
    || !nullableText(row.location) || !nullableText(row.url) || !nullableText(row.source) || !nullableText(row.salary)
    || !nullableText(row.description) || !nullableText(row.keywords)) return undefined
  return { id: row.id, company: row.company, role: row.role, description: row.description, keywords: row.keywords,
    location: row.location, salary: row.salary, source: row.source, url: row.url }
}

function digestMaterial(value: JobMaterial): string {
  return `sha256:${createHash("sha256").update(canonicalTaskGraphJson(value)).digest("hex")}`
}
function validJobIds(values: readonly string[]): boolean {
  return Array.isArray(values) && values.length > 0 && values.length <= MAX_JOB_IDS
    && values.every(isCanonicalJobId) && new Set(values).size === values.length
}
function exactKeys(row: Row, keys: string): boolean {
  const actual = Reflect.ownKeys(row)
  return actual.every(key => typeof key === "string") && [...actual].sort().join(",") === keys
    && actual.every(key => { const descriptor = Object.getOwnPropertyDescriptor(row, key); return Boolean(descriptor && descriptor.enumerable && "value" in descriptor) })
}
function record(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null ? value as Row : undefined } catch { return undefined }
}
function containsTruncation(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsTruncation)
  const row = record(value)
  return Boolean(row && (Object.hasOwn(row, "$truncated") || Reflect.ownKeys(row).some(key => typeof key === "string" && containsTruncation(row[key]))))
}
function nullableText(value: unknown): value is string | null { return value === null || typeof value === "string" }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 }
