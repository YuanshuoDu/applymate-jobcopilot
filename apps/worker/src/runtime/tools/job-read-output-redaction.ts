import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { redactSensitiveValue } from "@jobcopilot/shared"

const FAIL_CLOSED: RepositoryJsonValue = "[REDACTED]"
const CUID_V1 = /^c[a-z0-9]{24}$/
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MISSING = Symbol("missing")

type VerifiedTarget =
  | { readonly kind: "search"; readonly jobIds: readonly string[] }
  | { readonly kind: "discover"; readonly jobIds: readonly string[]; readonly evidenceJobIds: readonly string[] }
  | { readonly kind: "get"; readonly jobId: string | null }

const DISCOVER_OUTPUT_KEYS = ["jobs", "evidence", "nextCursor", "usage"]
const DISCOVER_JOB_KEYS = ["id", "title", "company", "location", "url", "description", "fullDescription", "salary", "logo", "source", "evidenceRefs"]
const DISCOVER_EVIDENCE_KEYS = ["evidenceId", "jobId", "kind", "source", "url", "summary"]
const DISCOVER_USAGE_SCOPE_KEYS = ["ledgerKey", "toolCallId", "sessionId", "turnId", "stepId"] as const
const DISCOVER_USAGE_REQUIRED_KEYS = ["toolName", "toolVersion", "requests", "jobsProcessed", "jobsSucceeded", "jobsFailed", "aiCalls", "providers", "estimatedCostUsd", "durationMs"]
const DISCOVER_INTERNAL_USAGE_KEYS = new Set<string>(DISCOVER_USAGE_SCOPE_KEYS)
const DISCOVER_EVIDENCE_KINDS = new Set<unknown>(["source", "enrichment", "analysis", "comparison"])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function ownDataValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  return descriptor && descriptor.enumerable && "value" in descriptor ? descriptor.value : MISSING
}

function hasExactDataKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  const keys = Reflect.ownKeys(record)
  if (keys.length < required.length || keys.length > allowed.size) return false
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) return false
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false
  }
  return required.every(key => Object.hasOwn(record, key))
}

function boundedString(value: unknown, maxLength: number, minLength = 0): value is string {
  return typeof value === "string" && value.length >= minLength && value.length <= maxLength
}

function isId(value: unknown): value is string { return boundedString(value, 256, 1) }
function isNonEmptyText(value: unknown, maxLength: number): value is string { return boundedString(value, maxLength, 1) }

function isBoundedArray(value: unknown, maxItems: number, validItem: (item: unknown) => boolean, minItems = 0): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < minItems || value.length > maxItems) return false
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1 || keys.some(key => key !== "length"
    && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) return false
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || !validItem(descriptor.value)) return false
  }
  return true
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function isCanonicalJobId(value: unknown): value is string {
  return typeof value === "string" && (CUID_V1.test(value) || UUID_V4.test(value))
}

function validDiscoverJob(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecord(value) || !hasExactDataKeys(value, DISCOVER_JOB_KEYS)) return false
  return isCanonicalJobId(ownDataValue(value, "id"))
    && isNonEmptyText(ownDataValue(value, "title"), 500)
    && isNonEmptyText(ownDataValue(value, "company"), 500)
    && boundedString(ownDataValue(value, "location"), 500)
    && isNonEmptyText(ownDataValue(value, "url"), 4096)
    && boundedString(ownDataValue(value, "description"), 100_000)
    && boundedString(ownDataValue(value, "fullDescription"), 100_000)
    && (ownDataValue(value, "salary") === null || boundedString(ownDataValue(value, "salary"), 500))
    && (ownDataValue(value, "logo") === null || boundedString(ownDataValue(value, "logo"), 4096))
    && isNonEmptyText(ownDataValue(value, "source"), 80)
    && isBoundedArray(ownDataValue(value, "evidenceRefs"), 8, isId, 1)
}

function validDiscoverEvidence(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecord(value) || !hasExactDataKeys(value, DISCOVER_EVIDENCE_KEYS)) return false
  const kind = ownDataValue(value, "kind")
  return isId(ownDataValue(value, "evidenceId")) && isId(ownDataValue(value, "jobId"))
    && DISCOVER_EVIDENCE_KINDS.has(kind)
    && isNonEmptyText(ownDataValue(value, "source"), 80)
    && isNonEmptyText(ownDataValue(value, "url"), 4096)
    && isNonEmptyText(ownDataValue(value, "summary"), 1000)
}

function validDiscoverUsage(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false
  const scopeKeyCount = DISCOVER_USAGE_SCOPE_KEYS.filter(key => Object.hasOwn(value, key)).length
  if (scopeKeyCount !== 0 && scopeKeyCount !== DISCOVER_USAGE_SCOPE_KEYS.length) return false
  if (!hasExactDataKeys(value, DISCOVER_USAGE_REQUIRED_KEYS, [...DISCOVER_USAGE_SCOPE_KEYS, "providerFailures"])) return false
  const integerFields = ["requests", "jobsProcessed", "jobsSucceeded", "jobsFailed", "aiCalls", "durationMs"]
  if (integerFields.some(key => !isNonNegativeInteger(ownDataValue(value, key)))) return false
  if (Object.hasOwn(value, "providerFailures")
    && !isNonNegativeInteger(ownDataValue(value, "providerFailures"))) return false
  const estimatedCostUsd = ownDataValue(value, "estimatedCostUsd")
  return ["toolName", "toolVersion"].every(key => isId(ownDataValue(value, key)))
    && (scopeKeyCount === 0 || DISCOVER_USAGE_SCOPE_KEYS.every(key => isId(ownDataValue(value, key))))
    && isBoundedArray(ownDataValue(value, "providers"), 32, item => isNonEmptyText(item, 80))
    && typeof estimatedCostUsd === "number" && Number.isFinite(estimatedCostUsd) && estimatedCostUsd >= 0
}

function verifyTarget(toolName: string, output: unknown): VerifiedTarget | null {
  if (!isPlainRecord(output)) return null

  if (toolName === "jobs.search") {
    const jobs = ownDataValue(output, "jobs")
    const page = ownDataValue(output, "page")
    const hasMore = ownDataValue(output, "hasMore")
    if (!Array.isArray(jobs) || typeof page !== "number" || !Number.isInteger(page) || typeof hasMore !== "boolean") return null

    const jobIds: string[] = []
    for (const job of jobs as unknown[]) {
      if (!isPlainRecord(job)) return null
      const id = ownDataValue(job, "id")
      if (!isCanonicalJobId(id)) return null
      jobIds.push(id)
    }
    return { kind: "search", jobIds }
  }

  if (toolName === "jobs.discover") {
    const jobs = ownDataValue(output, "jobs")
    const evidence = ownDataValue(output, "evidence")
    const nextCursor = ownDataValue(output, "nextCursor")
    const usage = ownDataValue(output, "usage")
    if (!hasExactDataKeys(output, DISCOVER_OUTPUT_KEYS)
      || !isBoundedArray(jobs, 50, validDiscoverJob) || !isBoundedArray(evidence, 400, validDiscoverEvidence)
      || (nextCursor !== null && !isNonEmptyText(nextCursor, 512)) || !validDiscoverUsage(usage)) return null

    const jobIds: string[] = []
    const jobIdSet = new Set<string>()
    for (const job of jobs) {
      if (!isPlainRecord(job)) return null
      const id = ownDataValue(job, "id")
      if (!isCanonicalJobId(id) || jobIdSet.has(id)) return null
      jobIds.push(id)
      jobIdSet.add(id)
    }

    const evidenceJobIds: string[] = []
    const evidenceIdsByJob = new Map<string, Set<string>>()
    const evidenceIdSet = new Set<string>()
    for (const item of evidence) {
      if (!isPlainRecord(item)) return null
      const jobId = ownDataValue(item, "jobId")
      const evidenceId = ownDataValue(item, "evidenceId")
      if (!isCanonicalJobId(jobId) || !jobIdSet.has(jobId) || typeof evidenceId !== "string" || evidenceIdSet.has(evidenceId)) return null
      evidenceJobIds.push(jobId)
      evidenceIdSet.add(evidenceId)
      const jobEvidenceIds = evidenceIdsByJob.get(jobId) ?? new Set<string>()
      jobEvidenceIds.add(evidenceId)
      evidenceIdsByJob.set(jobId, jobEvidenceIds)
    }
    for (const job of jobs) {
      if (!isPlainRecord(job)) return null
      const id = ownDataValue(job, "id")
      const refs = ownDataValue(job, "evidenceRefs")
      const evidenceIds = typeof id === "string" ? evidenceIdsByJob.get(id) : undefined
      if (!Array.isArray(refs) || !evidenceIds || refs.length !== evidenceIds.size
        || refs.some(ref => typeof ref !== "string" || !evidenceIds.has(ref))) return null
    }
    return { kind: "discover", jobIds, evidenceJobIds }
  }

  if (toolName === "jobs.get") {
    const job = ownDataValue(output, "job")
    if (job === null) return { kind: "get", jobId: null }
    if (!isPlainRecord(job)) return null
    const id = ownDataValue(job, "id")
    return isCanonicalJobId(id) ? { kind: "get", jobId: id } : null
  }

  return null
}

function isJsonRecord(value: RepositoryJsonValue): value is Record<string, RepositoryJsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isJsonArray(value: RepositoryJsonValue): value is RepositoryJsonValue[] {
  return Array.isArray(value)
}

/**
 * Redacts registered job-read results, restoring canonical IDs only at the
 * exact jobs.search, jobs.get, and jobs.discover paths.
 */
export function redactJobReadOutput(toolName: string, output: unknown): RepositoryJsonValue {
  try {
    const target = verifyTarget(toolName, output)
    if (!target) return FAIL_CLOSED

    const redacted = redactSensitiveValue(output)
    if (!isJsonRecord(redacted)) return FAIL_CLOSED

    if (target.kind === "search" || target.kind === "discover") {
      const jobs = redacted.jobs
      if (!isJsonArray(jobs) || jobs.length !== target.jobIds.length) return FAIL_CLOSED

      const safeJobs: RepositoryJsonValue[] = []
      for (let index = 0; index < jobs.length; index += 1) {
        const job = jobs[index]
        if (!isJsonRecord(job)) return FAIL_CLOSED
        safeJobs.push({ ...job, id: target.jobIds[index] })
      }
      if (target.kind === "search") return { ...redacted, jobs: safeJobs }

      const evidence = redacted.evidence
      if (!isJsonArray(evidence) || evidence.length !== target.evidenceJobIds.length) return FAIL_CLOSED
      const safeEvidence: RepositoryJsonValue[] = []
      for (let index = 0; index < evidence.length; index += 1) {
        const item = evidence[index]
        if (!isJsonRecord(item)) return FAIL_CLOSED
        safeEvidence.push({ ...item, jobId: target.evidenceJobIds[index] })
      }
      const usage = redacted.usage
      if (!isJsonRecord(usage)) return FAIL_CLOSED
      const safeUsage: Record<string, RepositoryJsonValue> = {}
      for (const [key, value] of Object.entries(usage)) {
        if (!DISCOVER_INTERNAL_USAGE_KEYS.has(key)) safeUsage[key] = value
      }
      return { ...redacted, jobs: safeJobs, evidence: safeEvidence, usage: safeUsage }
    }

    const job = redacted.job
    if (target.jobId === null) return job === null ? redacted : FAIL_CLOSED
    if (!isJsonRecord(job)) return FAIL_CLOSED
    return { ...redacted, job: { ...job, id: target.jobId } }
  } catch {
    return FAIL_CLOSED
  }
}
