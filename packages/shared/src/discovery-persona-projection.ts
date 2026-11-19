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
export type DiscoveryPersonaFactRow = Readonly<{
  id: unknown; key: unknown; category: unknown; value: unknown; normalizedValue: unknown; source: unknown
  evidence: unknown; updatedAt: unknown
}>
export type DiscoveryPersonaProjectionBuildResult =
  | { readonly kind: "accepted"; readonly projection: DiscoveryPersonaProjection; readonly canonicalJson: string
      readonly canonicalUtf8Bytes: number; readonly factCount: number }
  | { readonly kind: "overflow"; readonly reason: "fact_limit"; readonly observedFactCount: number; readonly canonicalUtf8Bytes: null }
  | { readonly kind: "overflow"; readonly reason: "byte_limit"; readonly observedFactCount: number; readonly canonicalUtf8Bytes: number }

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}
function string(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 }

export function normalizeDiscoveryPersonaValue(value: string): string {
  return value.trim().toLowerCase()
}

export function compareDiscoveryPersonaFacts(left: DiscoveryPersonaFact, right: DiscoveryPersonaFact): number {
  return left.key < right.key ? -1 : left.key > right.key ? 1
    : left.normalizedValue < right.normalizedValue ? -1 : left.normalizedValue > right.normalizedValue ? 1
      : left.factId < right.factId ? -1 : left.factId > right.factId ? 1 : 0
}

function iso(value: unknown): string | null {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null
}

export function canonicalDiscoveryPersonaProjection(projection: DiscoveryPersonaProjection): string {
  return JSON.stringify({ schemaVersion: projection.schemaVersion, purpose: projection.purpose,
    facts: [...projection.facts].sort(compareDiscoveryPersonaFacts).map(fact => ({ factId: fact.factId, key: fact.key, label: fact.label,
      category: fact.category, source: fact.source, value: fact.value, normalizedValue: fact.normalizedValue, updatedAt: fact.updatedAt })) })
}

const utf8Encoder = new TextEncoder()
export function utf8ByteLength(value: string): number { return utf8Encoder.encode(value).byteLength }

export function buildDiscoveryPersonaProjection(
  rows: readonly DiscoveryPersonaFactRow[],
): DiscoveryPersonaProjectionBuildResult {
  if (rows.length > DISCOVERY_PERSONA_FACT_LIMIT) return {
    kind: "overflow", reason: "fact_limit", observedFactCount: rows.length, canonicalUtf8Bytes: null,
  }
  const facts: DiscoveryPersonaFact[] = []
  for (const row of rows) {
    const key = row.key, updatedAt = iso(row.updatedAt), evidence = record(row.evidence)
    if (!string(row.id) || !string(key) || !string(row.category) || !string(row.value)
      || !string(row.normalizedValue) || row.normalizedValue !== normalizeDiscoveryPersonaValue(row.value)
      || !string(row.source) || updatedAt === null) {
      throw new TypeError("Confirmed discovery fact is malformed")
    }
    facts.push({ factId: row.id, key, label: typeof evidence?.label === "string" && string(evidence.label) ? evidence.label : key,
      category: row.category, source: row.source, value: row.value, normalizedValue: row.normalizedValue, updatedAt })
  }
  facts.sort(compareDiscoveryPersonaFacts)
  if (new Set(facts.map(fact => fact.factId)).size !== facts.length
    || new Set(facts.map(fact => `${fact.key}\u0000${fact.normalizedValue}`)).size !== facts.length) {
    throw new TypeError("Confirmed discovery facts are not unique")
  }
  const projection: DiscoveryPersonaProjection = { schemaVersion: DISCOVERY_PERSONA_PROJECTION_SCHEMA, purpose: "discovery", facts }
  const canonicalJson = canonicalDiscoveryPersonaProjection(projection)
  const canonicalUtf8Bytes = utf8ByteLength(canonicalJson)
  if (canonicalUtf8Bytes > DISCOVERY_PERSONA_BYTE_LIMIT) return {
    kind: "overflow", reason: "byte_limit", observedFactCount: facts.length, canonicalUtf8Bytes,
  }
  return { kind: "accepted", projection, canonicalJson, canonicalUtf8Bytes, factCount: facts.length }
}
