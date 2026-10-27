import { Buffer } from "node:buffer"
import { redactSensitiveText } from "@jobcopilot/shared"

export const DISCOVERY_QUERY_FOOTPRINT_SCHEMA_VERSION = "agent-harness.v2.task-graph.discovery-query-footprint.v1" as const
export const DISCOVERY_QUERY_FOOTPRINT_MAX_CALLS = 8
export const DISCOVERY_QUERY_FOOTPRINT_MAX_BYTES = 4 * 1024

const SOURCES = new Set(["greenhouse", "lever", "workday", "smartrecruiters", "personio"])
const OMIT_REASONS = new Set(["call_limit", "byte_limit", "unsafe_criteria", "capture_unavailable", "invalid_criteria"])
const OUTCOMES = new Set(["completed", "failed", "cancelled", "unresolved"])
const MAX_COUNT = 1_000_000

export type DiscoveryQueryCriteria = Readonly<{
  targetRoles: readonly string[]
  targetLocations: readonly string[]
  source?: "greenhouse" | "lever" | "workday" | "smartrecruiters" | "personio"
  pageSize?: number
  hasCursor: boolean
}>
export type DiscoveryQueryOmissionReason = "call_limit" | "byte_limit" | "unsafe_criteria" | "capture_unavailable" | "invalid_criteria"
export type DiscoveryQueryCapture = Readonly<
  | { availability: "captured"; criteria: DiscoveryQueryCriteria }
  | { availability: "omitted"; omissionReason: "unsafe_criteria" | "invalid_criteria" }
>
export type DiscoveryQueryFootprintCall = Readonly<{
  criteria: DiscoveryQueryCriteria
  outcome: "completed" | "failed" | "cancelled" | "unresolved"
  requestCount: number | null
  observedCandidateCount: number | null
  providerFailures: number | null
  materializationFailures: number | null
  hasMore: boolean | null
}>
export type DiscoveryQueryAttemptObservation = Readonly<{
  query?: DiscoveryQueryCapture
  phase: "started" | "completed" | "failed" | "cancelled"
  receipt?: Readonly<{
    requestCount: number | null
    candidateCount: number | null
    providerFailures: number | null
    materializationFailures: number | null
    hasMore: boolean | null
  }>
}>
export type DiscoveryQueryFootprint = Readonly<
  | { schemaVersion: typeof DISCOVERY_QUERY_FOOTPRINT_SCHEMA_VERSION; availability: "available"; calls: readonly DiscoveryQueryFootprintCall[] }
  | { schemaVersion: typeof DISCOVERY_QUERY_FOOTPRINT_SCHEMA_VERSION; availability: "omitted"; omissionReason: DiscoveryQueryOmissionReason }
>

function omissionReason(value: unknown): value is DiscoveryQueryOmissionReason {
  return typeof value === "string" && OMIT_REASONS.has(value)
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    const ownKeys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || ownKeys.length !== keys.length
      || !ownKeys.every(key => typeof key === "string" && keys.includes(key))) return null
    const row = value as Record<string, unknown>
    return keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return descriptor?.enumerable && "value" in descriptor && descriptor.value === row[key]
    }) ? row : null
  } catch { return null }
}

function allowedRecord(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null)
      || keys.some(key => typeof key !== "string" || !allowed.includes(key))
      || required.some(key => !Object.hasOwn(value, key))) return null
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return null
    }
    return value as Record<string, unknown>
  } catch { return null }
}

function denseArray(value: unknown, max: number, min = 0): value is unknown[] {
  try {
    if (!Array.isArray(value) || value.length < min || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) return false
    return Reflect.ownKeys(value).every(key => key === "length" || typeof key === "string"
      && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length
      && "value" in (Object.getOwnPropertyDescriptor(value, key) ?? {}))
  } catch { return false }
}

function boundedQueryText(value: unknown): value is string {
  try {
    return typeof value === "string" && value.length >= 1 && value.length <= 160 && value.trim().length > 0
      && !/[\u0000-\u001f\u007f]/.test(value) && Buffer.from(value, "utf8").toString("utf8") === value
  } catch { return false }
}

function safeQueryText(value: string): boolean {
  try { return redactSensitiveText(value) === value } catch { return false }
}

function queryCriteria(value: unknown): DiscoveryQueryCriteria | null {
  const row = allowedRecord(value, ["targetRoles", "targetLocations", "source", "pageSize", "cursor", "hasCursor"], ["targetRoles", "targetLocations"])
  const projected = Object.hasOwn(row ?? {}, "hasCursor")
  if (!row || projected && Object.hasOwn(row, "cursor")
    || !denseArray(row.targetRoles, 8, 1) || !row.targetRoles.every(boundedQueryText)
    || !denseArray(row.targetLocations, 8) || !row.targetLocations.every(boundedQueryText)) return null
  if (Object.hasOwn(row, "source") && (typeof row.source !== "string" || !SOURCES.has(row.source))) return null
  if (Object.hasOwn(row, "pageSize") && (!Number.isSafeInteger(row.pageSize) || Number(row.pageSize) < 1 || Number(row.pageSize) > 50)) return null
  if (projected && typeof row.hasCursor !== "boolean") return null
  if (Object.hasOwn(row, "cursor") && (typeof row.cursor !== "string" || row.cursor.length < 1 || row.cursor.length > 512)) return null
  return {
    targetRoles: [...row.targetRoles] as string[], targetLocations: [...row.targetLocations] as string[],
    ...(typeof row.source === "string" ? { source: row.source as DiscoveryQueryCriteria["source"] } : {}),
    ...(typeof row.pageSize === "number" ? { pageSize: row.pageSize } : {}),
    hasCursor: projected ? row.hasCursor as boolean : Object.hasOwn(row, "cursor"),
  }
}

export function captureDiscoveryQueryCriteria(value: unknown): DiscoveryQueryCapture {
  const criteria = queryCriteria(value)
  if (!criteria) return { availability: "omitted", omissionReason: "invalid_criteria" }
  if ([...criteria.targetRoles, ...criteria.targetLocations].some(text => !safeQueryText(text))) {
    return { availability: "omitted", omissionReason: "unsafe_criteria" }
  }
  return { availability: "captured", criteria }
}

export function omittedDiscoveryQueryFootprint(omissionReason: DiscoveryQueryOmissionReason): DiscoveryQueryFootprint {
  return { schemaVersion: DISCOVERY_QUERY_FOOTPRINT_SCHEMA_VERSION, availability: "omitted", omissionReason }
}

export function createDiscoveryQueryFootprint(calls: readonly DiscoveryQueryFootprintCall[], omissionReason?: DiscoveryQueryOmissionReason): DiscoveryQueryFootprint {
  if (omissionReason) return omittedDiscoveryQueryFootprint(omissionReason)
  if (calls.length === 0) return omittedDiscoveryQueryFootprint("capture_unavailable")
  if (calls.length > DISCOVERY_QUERY_FOOTPRINT_MAX_CALLS) return omittedDiscoveryQueryFootprint("call_limit")
  try {
    const parsed = parseFootprint({ schemaVersion: DISCOVERY_QUERY_FOOTPRINT_SCHEMA_VERSION, availability: "available", calls }, false)
    if (!parsed) return omittedDiscoveryQueryFootprint("invalid_criteria")
    return Buffer.byteLength(JSON.stringify(parsed), "utf8") <= DISCOVERY_QUERY_FOOTPRINT_MAX_BYTES
      ? parsed : omittedDiscoveryQueryFootprint("byte_limit")
  } catch { return omittedDiscoveryQueryFootprint("invalid_criteria") }
}

export function createDiscoveryQueryFootprintForAttempts(
  attempts: readonly DiscoveryQueryAttemptObservation[], captureUnavailable = false,
): DiscoveryQueryFootprint {
  if (captureUnavailable) return omittedDiscoveryQueryFootprint("capture_unavailable")
  const calls: DiscoveryQueryFootprintCall[] = []
  for (const attempt of attempts) {
    if (attempt.query?.availability !== "captured") {
      return omittedDiscoveryQueryFootprint(attempt.query?.availability === "omitted" ? attempt.query.omissionReason : "capture_unavailable")
    }
    calls.push({ criteria: attempt.query.criteria, outcome: attempt.phase === "started" ? "unresolved" : attempt.phase,
      requestCount: attempt.receipt?.requestCount ?? null, observedCandidateCount: attempt.receipt?.candidateCount ?? null,
      providerFailures: attempt.receipt?.providerFailures ?? null, materializationFailures: attempt.receipt?.materializationFailures ?? null,
      hasMore: attempt.receipt?.hasMore ?? null })
  }
  return createDiscoveryQueryFootprint(calls)
}

function count(value: unknown): value is number | null {
  return value === null || Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_COUNT
}

function parseCriteria(value: unknown): DiscoveryQueryCriteria | null {
  const row = allowedRecord(value, ["targetRoles", "targetLocations", "source", "pageSize", "hasCursor"], ["targetRoles", "targetLocations", "hasCursor"])
  if (!row) return null
  const parsed = queryCriteria(row)
  return parsed && Object.hasOwn(row, "hasCursor")
    && [...parsed.targetRoles, ...parsed.targetLocations].every(safeQueryText) ? parsed : null
}

function parseFootprint(value: unknown, enforceByteLimit = true): DiscoveryQueryFootprint | null {
  try {
    const header = allowedRecord(value, ["schemaVersion", "availability", "calls", "omissionReason"], ["schemaVersion", "availability"])
    if (!header || header.schemaVersion !== DISCOVERY_QUERY_FOOTPRINT_SCHEMA_VERSION) return null
    if (header.availability === "omitted") {
      const row = exactRecord(value, ["schemaVersion", "availability", "omissionReason"])
      return row && omissionReason(row.omissionReason)
        ? { schemaVersion: DISCOVERY_QUERY_FOOTPRINT_SCHEMA_VERSION, availability: "omitted", omissionReason: row.omissionReason }
        : null
    }
    const row = exactRecord(value, ["schemaVersion", "availability", "calls"])
    if (!row || row.availability !== "available" || !denseArray(row.calls, DISCOVERY_QUERY_FOOTPRINT_MAX_CALLS, 1)) return null
    const calls: DiscoveryQueryFootprintCall[] = []
    for (const item of row.calls) {
      const call = exactRecord(item, ["criteria", "outcome", "requestCount", "observedCandidateCount", "providerFailures", "materializationFailures", "hasMore"])
      const criteria = call && parseCriteria(call.criteria)
      if (!call || !criteria || typeof call.outcome !== "string" || !OUTCOMES.has(call.outcome)
        || !count(call.requestCount) || !count(call.observedCandidateCount) || !count(call.providerFailures)
        || !count(call.materializationFailures) || call.hasMore !== null && typeof call.hasMore !== "boolean"
        || call.outcome !== "completed" && (call.observedCandidateCount !== null || call.hasMore !== null)
        || call.outcome === "unresolved" && (call.requestCount !== null || call.providerFailures !== null || call.materializationFailures !== null)) return null
      calls.push({ criteria, outcome: call.outcome as DiscoveryQueryFootprintCall["outcome"],
        requestCount: call.requestCount, observedCandidateCount: call.observedCandidateCount,
        providerFailures: call.providerFailures, materializationFailures: call.materializationFailures, hasMore: call.hasMore })
    }
    const parsed: DiscoveryQueryFootprint = { schemaVersion: DISCOVERY_QUERY_FOOTPRINT_SCHEMA_VERSION, availability: "available", calls }
    return !enforceByteLimit || Buffer.byteLength(JSON.stringify(parsed), "utf8") <= DISCOVERY_QUERY_FOOTPRINT_MAX_BYTES ? parsed : null
  } catch { return null }
}

export function parseDiscoveryQueryFootprint(value: unknown): DiscoveryQueryFootprint | null {
  return parseFootprint(value)
}
