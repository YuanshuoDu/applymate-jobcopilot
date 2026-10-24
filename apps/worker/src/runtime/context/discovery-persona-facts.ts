import { createHash } from "node:crypto"

export const DISCOVERY_PERSONA_EVENT_SCHEMA = "applymate.discovery-persona.v1" as const
export const DISCOVERY_PERSONA_PROJECTION_SCHEMA = "applymate.discovery-persona-projection.v1" as const
export const DISCOVERY_PERSONA_FACT_LIMIT = 32
export const DISCOVERY_PERSONA_BYTE_LIMIT = 8192

export type DiscoveryPersonaFact = Readonly<{
  factId: string; key: string; label: string; category: string; source: string
  value: string; normalizedValue: string; updatedAt: string
}>
export type DiscoveryPersonaProjection = Readonly<{
  schemaVersion: typeof DISCOVERY_PERSONA_PROJECTION_SCHEMA; purpose: "discovery"; facts: readonly DiscoveryPersonaFact[]
}>
export type DiscoveryPersonaSnapshotPayload = Readonly<{
  schemaVersion: typeof DISCOVERY_PERSONA_EVENT_SCHEMA; status: "accepted"; purpose: "discovery"
  factCount: number; canonicalUtf8Bytes: number; digest: string; projection: DiscoveryPersonaProjection
}>
export type DiscoveryPersonaOverflowPayload = Readonly<{
  schemaVersion: typeof DISCOVERY_PERSONA_EVENT_SCHEMA; status: "overflow"; purpose: "discovery"
  reason: "fact_limit" | "byte_limit"; observedFactCount: number; factLimit: number; byteLimit: number
  canonicalUtf8Bytes: number | null
}>
export type DiscoveryPersonaProjectionResult =
  | { readonly kind: "accepted"; readonly payload: DiscoveryPersonaSnapshotPayload }
  | { readonly kind: "overflow"; readonly payload: DiscoveryPersonaOverflowPayload }

export type DiscoveryPersonaFactRow = Readonly<{
  id: unknown; key: unknown; category: unknown; value: unknown; normalizedValue: unknown; source: unknown
  evidence: unknown; updatedAt: unknown
}>

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}
function exact(recordValue: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(recordValue).sort().join(",") === [...keys].sort().join(",")
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function normalized(value: string): string { return value.trim().toLowerCase() }
function factOrder(left: DiscoveryPersonaFact, right: DiscoveryPersonaFact): number {
  return compare(left.key, right.key) || compare(left.normalizedValue, right.normalizedValue) || compare(left.factId, right.factId)
}
function iso(value: unknown): string | null {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null
}
function string(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 }

export function canonicalDiscoveryPersonaProjection(projection: DiscoveryPersonaProjection): string {
  return JSON.stringify({ schemaVersion: projection.schemaVersion, purpose: projection.purpose,
    facts: [...projection.facts].sort(factOrder).map(fact => ({ factId: fact.factId, key: fact.key, label: fact.label,
      category: fact.category, source: fact.source, value: fact.value, normalizedValue: fact.normalizedValue, updatedAt: fact.updatedAt })) })
}

export function projectDiscoveryPersonaFacts(rows: readonly DiscoveryPersonaFactRow[]): DiscoveryPersonaProjectionResult {
  if (rows.length > DISCOVERY_PERSONA_FACT_LIMIT) return { kind: "overflow", payload: {
    schemaVersion: DISCOVERY_PERSONA_EVENT_SCHEMA, status: "overflow", purpose: "discovery", reason: "fact_limit",
    observedFactCount: rows.length, factLimit: DISCOVERY_PERSONA_FACT_LIMIT, byteLimit: DISCOVERY_PERSONA_BYTE_LIMIT, canonicalUtf8Bytes: null,
  } }
  const facts: DiscoveryPersonaFact[] = []
  for (const row of rows) {
    const key = row.key, updatedAt = iso(row.updatedAt), evidence = record(row.evidence)
    if (!string(row.id) || !string(key) || !string(row.category) || !string(row.value)
      || !string(row.normalizedValue) || row.normalizedValue !== normalized(row.value) || !string(row.source) || updatedAt === null) {
      throw new TypeError("Confirmed discovery fact is malformed")
    }
    facts.push({ factId: row.id, key, label: typeof evidence?.label === "string" && string(evidence.label) ? evidence.label : key,
      category: row.category, source: row.source, value: row.value, normalizedValue: row.normalizedValue, updatedAt })
  }
  facts.sort(factOrder)
  if (new Set(facts.map(fact => fact.factId)).size !== facts.length
    || new Set(facts.map(fact => `${fact.key}\u0000${fact.normalizedValue}`)).size !== facts.length) {
    throw new TypeError("Confirmed discovery facts are not unique")
  }
  const projection: DiscoveryPersonaProjection = { schemaVersion: DISCOVERY_PERSONA_PROJECTION_SCHEMA, purpose: "discovery", facts }
  const canonical = canonicalDiscoveryPersonaProjection(projection), bytes = Buffer.byteLength(canonical, "utf8")
  if (bytes > DISCOVERY_PERSONA_BYTE_LIMIT) return { kind: "overflow", payload: {
    schemaVersion: DISCOVERY_PERSONA_EVENT_SCHEMA, status: "overflow", purpose: "discovery", reason: "byte_limit",
    observedFactCount: facts.length, factLimit: DISCOVERY_PERSONA_FACT_LIMIT, byteLimit: DISCOVERY_PERSONA_BYTE_LIMIT, canonicalUtf8Bytes: bytes,
  } }
  return { kind: "accepted", payload: { schemaVersion: DISCOVERY_PERSONA_EVENT_SCHEMA, status: "accepted", purpose: "discovery",
    factCount: facts.length, canonicalUtf8Bytes: bytes, digest: createHash("sha256").update(canonical, "utf8").digest("hex"), projection } }
}

export function parseDiscoveryPersonaSnapshotPayload(value: unknown): DiscoveryPersonaSnapshotPayload | null {
  const payload = record(value), projectionRow = payload ? record(payload.projection) : null
  if (!payload || !exact(payload, ["schemaVersion", "status", "purpose", "factCount", "canonicalUtf8Bytes", "digest", "projection"])
    || payload.schemaVersion !== DISCOVERY_PERSONA_EVENT_SCHEMA || payload.status !== "accepted" || payload.purpose !== "discovery"
    || !Number.isSafeInteger(payload.factCount) || Number(payload.factCount) < 0 || Number(payload.factCount) > DISCOVERY_PERSONA_FACT_LIMIT
    || !Number.isSafeInteger(payload.canonicalUtf8Bytes) || Number(payload.canonicalUtf8Bytes) < 0 || Number(payload.canonicalUtf8Bytes) > DISCOVERY_PERSONA_BYTE_LIMIT
    || typeof payload.digest !== "string" || !/^[a-f0-9]{64}$/.test(payload.digest) || !projectionRow
    || !exact(projectionRow, ["schemaVersion", "purpose", "facts"]) || projectionRow.schemaVersion !== DISCOVERY_PERSONA_PROJECTION_SCHEMA
    || projectionRow.purpose !== "discovery" || !Array.isArray(projectionRow.facts)
    || projectionRow.facts.length > DISCOVERY_PERSONA_FACT_LIMIT) return null
  const facts: DiscoveryPersonaFact[] = []
  for (const value of projectionRow.facts) {
    const fact = record(value)
    if (!fact || !exact(fact, ["factId", "key", "label", "category", "source", "value", "normalizedValue", "updatedAt"])) return null
    const { factId, key, label, category, source, value: exactValue, normalizedValue } = fact
    const updatedAt = iso(fact.updatedAt)
    if (!string(factId) || !string(key) || !string(label) || !string(category) || !string(source)
      || !string(exactValue) || !string(normalizedValue) || normalizedValue !== normalized(exactValue)
      || updatedAt === null || updatedAt !== fact.updatedAt) return null
    facts.push({ factId, key, label, category, source, value: exactValue, normalizedValue, updatedAt })
  }
  if (facts.length !== payload.factCount || new Set(facts.map(fact => fact.factId)).size !== facts.length
    || new Set(facts.map(fact => fact.key + "\u0000" + fact.normalizedValue)).size !== facts.length
    || facts.some((fact, index) => index > 0 && factOrder(facts[index - 1]!, fact) >= 0)) return null
  const projection: DiscoveryPersonaProjection = { schemaVersion: DISCOVERY_PERSONA_PROJECTION_SCHEMA, purpose: "discovery", facts }
  const canonical = canonicalDiscoveryPersonaProjection(projection)
  if (Buffer.byteLength(canonical, "utf8") !== payload.canonicalUtf8Bytes
    || createHash("sha256").update(canonical, "utf8").digest("hex") !== payload.digest) return null
  return payload as DiscoveryPersonaSnapshotPayload
}

export function parseDiscoveryPersonaOverflowPayload(value: unknown): DiscoveryPersonaOverflowPayload | null {
  const payload = record(value)
  if (!payload || !exact(payload, ["schemaVersion", "status", "purpose", "reason", "observedFactCount", "factLimit", "byteLimit", "canonicalUtf8Bytes"])
    || payload.schemaVersion !== DISCOVERY_PERSONA_EVENT_SCHEMA || payload.status !== "overflow" || payload.purpose !== "discovery"
    || (payload.reason !== "fact_limit" && payload.reason !== "byte_limit") || !Number.isSafeInteger(payload.observedFactCount)
    || Number(payload.observedFactCount) < 0 || payload.factLimit !== DISCOVERY_PERSONA_FACT_LIMIT || payload.byteLimit !== DISCOVERY_PERSONA_BYTE_LIMIT) return null
  if (payload.reason === "fact_limit" && (Number(payload.observedFactCount) <= DISCOVERY_PERSONA_FACT_LIMIT || payload.canonicalUtf8Bytes !== null)) return null
  if (payload.reason === "byte_limit" && (Number(payload.observedFactCount) > DISCOVERY_PERSONA_FACT_LIMIT
    || !Number.isSafeInteger(payload.canonicalUtf8Bytes) || Number(payload.canonicalUtf8Bytes) <= DISCOVERY_PERSONA_BYTE_LIMIT)) return null
  return payload as DiscoveryPersonaOverflowPayload
}
