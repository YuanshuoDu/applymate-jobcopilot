import { isReviewedApplicationMaterialProof, type ReviewedApplicationMaterialProof } from "./application-submission-material.js"

export const REVIEWED_APPLICATION_FILL_SOURCE_SCHEMA = "agent-harness.v2.selected-job-reviewed-fill-source.v1" as const
export const REVIEWED_APPLICATION_FILL_BROWSER_START_SCHEMA = "agent-harness.v2.reviewed-application-fill-browser-start.v1" as const

export type ReviewedApplicationFillSourceSelection =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "selected"; sourceTurnId: string }>

export type ReviewedApplicationFillBrowserStartBinding = Readonly<{
  schemaVersion: typeof REVIEWED_APPLICATION_FILL_BROWSER_START_SCHEMA
  userId: string
  sessionId: string
  fillTurnId: string
  jobId: string
  applicationTaskId: string
  fillerTaskId: string
  attemptCount: number
  leaseOwner: string
  leaseExpiresAt: string
  proof: ReviewedApplicationMaterialProof
}>

const SOURCE_KEYS = ["schemaVersion", "sourceTurnId"] as const
const BINDING_KEYS = ["schemaVersion", "userId", "sessionId", "fillTurnId", "jobId", "applicationTaskId", "fillerTaskId",
  "attemptCount", "leaseOwner", "leaseExpiresAt", "sourceTurnId", "rootTaskId", "graphRevision", "writerTaskId",
  "reviewerTaskId", "reviewerToolCallId", "reviewHash", "artifactId", "version", "contentHash", "sourceDigest"] as const

/** Parses the private opt-in from an accepted Turn input without granting authority. */
export function parseReviewedApplicationFillSource(input: unknown): ReviewedApplicationFillSourceSelection {
  if (input === null || input === undefined) return { kind: "absent" }
  const envelope = record(input)
  if (!envelope) return { kind: "invalid" }
  let descriptor: PropertyDescriptor | undefined
  try { descriptor = Object.getOwnPropertyDescriptor(envelope, "reviewedApplicationMaterialSource") } catch { return { kind: "invalid" } }
  if (!descriptor) return { kind: "absent" }
  if (!descriptor.enumerable || !("value" in descriptor)) return { kind: "invalid" }
  const source = exactRecord(descriptor.value, SOURCE_KEYS)
  if (!source || source.schemaVersion !== REVIEWED_APPLICATION_FILL_SOURCE_SCHEMA || !id(source.sourceTurnId)) return { kind: "invalid" }
  return { kind: "selected", sourceTurnId: source.sourceTurnId }
}

/** Parses the exact durable browser-start data; the caller must bind the event actor and row scope. */
export function parseReviewedApplicationFillBrowserStartEvent(data: unknown): ReviewedApplicationFillBrowserStartBinding | null {
  const row = exactRecord(data, BINDING_KEYS)
  if (!row || row.schemaVersion !== REVIEWED_APPLICATION_FILL_BROWSER_START_SCHEMA
    || ![row.userId, row.sessionId, row.fillTurnId, row.applicationTaskId, row.fillerTaskId, row.leaseOwner].every(id)
    || !Number.isSafeInteger(row.attemptCount) || Number(row.attemptCount) < 1 || !canonicalIso(row.leaseExpiresAt)) return null
  const proof = Object.fromEntries(PROOF_KEYS.map(key => [key, row[key]]))
  if (!isReviewedApplicationMaterialProof(proof)) return null
  return Object.freeze({
    schemaVersion: REVIEWED_APPLICATION_FILL_BROWSER_START_SCHEMA,
    userId: row.userId as string, sessionId: row.sessionId as string, fillTurnId: row.fillTurnId as string,
    applicationTaskId: row.applicationTaskId as string, fillerTaskId: row.fillerTaskId as string,
    attemptCount: row.attemptCount as number, leaseOwner: row.leaseOwner as string, leaseExpiresAt: row.leaseExpiresAt as string,
    jobId: row.jobId as string, proof: Object.freeze(proof as ReviewedApplicationMaterialProof),
  })
}

const PROOF_KEYS = ["jobId", "sourceTurnId", "rootTaskId", "graphRevision", "writerTaskId", "reviewerTaskId",
  "reviewerToolCallId", "reviewHash", "artifactId", "version", "contentHash", "sourceDigest"] as const

function record(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype ? parsed as Record<string, unknown> : null } catch { return null }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const row = record(value)
  if (!row) return null
  try {
    const own = Reflect.ownKeys(row)
    return own.length === keys.length && own.every(key => typeof key === "string" && keys.includes(key))
      && keys.every(key => { const descriptor = Object.getOwnPropertyDescriptor(row, key); return Boolean(descriptor?.enumerable && "value" in descriptor) })
      ? row : null
  } catch { return null }
}

function id(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 }
function canonicalIso(value: unknown): value is string { if (typeof value !== "string") return false; const date = new Date(value); return Number.isFinite(date.getTime()) && date.toISOString() === value }
