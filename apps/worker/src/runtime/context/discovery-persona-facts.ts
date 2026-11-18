import { createHash } from "node:crypto"
import {
  DISCOVERY_PERSONA_BYTE_LIMIT, DISCOVERY_PERSONA_FACT_LIMIT, DISCOVERY_PERSONA_PROJECTION_SCHEMA,
  buildDiscoveryPersonaProjection, canonicalDiscoveryPersonaProjection, compareDiscoveryPersonaFacts,
  normalizeDiscoveryPersonaValue, utf8ByteLength,
  type DiscoveryPersonaFact, type DiscoveryPersonaFactRow, type DiscoveryPersonaProjection,
} from "@jobcopilot/shared"

export {
  DISCOVERY_PERSONA_BYTE_LIMIT, DISCOVERY_PERSONA_FACT_LIMIT, DISCOVERY_PERSONA_PROJECTION_SCHEMA,
  canonicalDiscoveryPersonaProjection,
} from "@jobcopilot/shared"
export type {
  DiscoveryPersonaFact, DiscoveryPersonaFactRow, DiscoveryPersonaProjection,
} from "@jobcopilot/shared"

export const DISCOVERY_PERSONA_EVENT_SCHEMA = "applymate.discovery-persona.v1" as const

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

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}
function exact(recordValue: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(recordValue).sort().join(",") === [...keys].sort().join(",")
}
function iso(value: unknown): string | null {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null
}
function string(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 }

export function projectDiscoveryPersonaFacts(rows: readonly DiscoveryPersonaFactRow[]): DiscoveryPersonaProjectionResult {
  const built = buildDiscoveryPersonaProjection(rows)
  if (built.kind === "overflow") return { kind: "overflow", payload: {
    schemaVersion: DISCOVERY_PERSONA_EVENT_SCHEMA, status: "overflow", purpose: "discovery", reason: built.reason,
    observedFactCount: built.observedFactCount, factLimit: DISCOVERY_PERSONA_FACT_LIMIT, byteLimit: DISCOVERY_PERSONA_BYTE_LIMIT,
    canonicalUtf8Bytes: built.canonicalUtf8Bytes,
  } }
  return { kind: "accepted", payload: { schemaVersion: DISCOVERY_PERSONA_EVENT_SCHEMA, status: "accepted", purpose: "discovery",
    factCount: built.factCount, canonicalUtf8Bytes: built.canonicalUtf8Bytes,
    digest: createHash("sha256").update(built.canonicalJson, "utf8").digest("hex"), projection: built.projection } }
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
      || !string(exactValue) || !string(normalizedValue) || normalizedValue !== normalizeDiscoveryPersonaValue(exactValue)
      || updatedAt === null || updatedAt !== fact.updatedAt) return null
    facts.push({ factId, key, label, category, source, value: exactValue, normalizedValue, updatedAt })
  }
  if (facts.length !== payload.factCount || new Set(facts.map(fact => fact.factId)).size !== facts.length
    || new Set(facts.map(fact => fact.key + "\u0000" + fact.normalizedValue)).size !== facts.length
    || facts.some((fact, index) => index > 0 && compareDiscoveryPersonaFacts(facts[index - 1]!, fact) >= 0)) return null
  const projection: DiscoveryPersonaProjection = { schemaVersion: DISCOVERY_PERSONA_PROJECTION_SCHEMA, purpose: "discovery", facts }
  const canonical = canonicalDiscoveryPersonaProjection(projection)
  if (utf8ByteLength(canonical) !== payload.canonicalUtf8Bytes
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
