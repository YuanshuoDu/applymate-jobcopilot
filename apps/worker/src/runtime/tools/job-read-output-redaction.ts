import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { redactSensitiveValue } from "@jobcopilot/shared"

const FAIL_CLOSED: RepositoryJsonValue = "[REDACTED]"
const CUID_V1 = /^c[a-z0-9]{24}$/
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MISSING = Symbol("missing")

type VerifiedTarget =
  | { readonly kind: "search"; readonly jobIds: readonly string[] }
  | { readonly kind: "get"; readonly jobId: string | null }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function ownDataValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  return descriptor && descriptor.enumerable && "value" in descriptor ? descriptor.value : MISSING
}

function isCanonicalJobId(value: unknown): value is string {
  return typeof value === "string" && (CUID_V1.test(value) || UUID_V4.test(value))
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
 * Redacts a registered job-read result, restoring only canonical Job IDs at the
 * exact jobs.search and jobs.get paths.
 */
export function redactJobReadOutput(toolName: string, output: unknown): RepositoryJsonValue {
  try {
    const target = verifyTarget(toolName, output)
    if (!target) return FAIL_CLOSED

    const redacted = redactSensitiveValue(output)
    if (!isJsonRecord(redacted)) return FAIL_CLOSED

    if (target.kind === "search") {
      const jobs = redacted.jobs
      if (!isJsonArray(jobs) || jobs.length !== target.jobIds.length) return FAIL_CLOSED

      const safeJobs: RepositoryJsonValue[] = []
      for (let index = 0; index < jobs.length; index += 1) {
        const job = jobs[index]
        if (!isJsonRecord(job)) return FAIL_CLOSED
        safeJobs.push({ ...job, id: target.jobIds[index] })
      }
      return { ...redacted, jobs: safeJobs }
    }

    const job = redacted.job
    if (target.jobId === null) return job === null ? redacted : FAIL_CLOSED
    if (!isJsonRecord(job)) return FAIL_CLOSED
    return { ...redacted, job: { ...job, id: target.jobId } }
  } catch {
    return FAIL_CLOSED
  }
}
