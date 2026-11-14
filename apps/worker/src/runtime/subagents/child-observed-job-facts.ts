import { Buffer } from "node:buffer"
import { normalizeAgentLocation } from "@jobcopilot/shared"
import type { RoleEvidence } from "./role-results.js"

const MAX_JOB_FACTS = 100
const MAX_EVIDENCE_FIELD_LENGTH = 256

export type ObservedJobLocationFact = Readonly<{
  source: string | null
  location: string | null
  locationEvidenceStatus: "verified" | "missing" | "conflicting"
}>
export type ObservedJobFacts = Readonly<{
  facts: Map<string, ObservedJobLocationFact>
  conflicts: Set<string>
}>
export type ObservedEvidenceWriteIndex = Readonly<{
  entries: Map<string, RoleEvidence>
  discoveryEntries: Set<string>
  conflicts: Set<string>
  jobFacts: ObservedJobFacts
}>
type ObservedEvidenceKind = "job" | "persona" | "resume"

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}

function boundedText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_EVIDENCE_FIELD_LENGTH ? value : undefined
}

export function observedEvidenceKey(kind: string, ref: string): string { return `${kind}\u0000${ref}` }

export function createObservedJobFacts(): ObservedJobFacts { return { facts: new Map(), conflicts: new Set() } }

export function recordObservedJobFact(facts: ObservedJobFacts, id: string, source: unknown, location: unknown): void {
  const validSource = source === null || typeof source === "string" && source.trim().length > 0 && source.length <= MAX_EVIDENCE_FIELD_LENGTH
  const normalizedLocation = typeof location === "string" && location.length <= 500 ? normalizeAgentLocation(location) : null
  const status = normalizedLocation ? "verified" : "missing"
  const observed: ObservedJobLocationFact = {
    source: validSource && typeof source === "string" ? source : null,
    location: status === "verified" ? normalizedLocation : null,
    locationEvidenceStatus: status,
  }
  const previous = facts.facts.get(id)
  if (!previous) {
    if (facts.facts.size < MAX_JOB_FACTS) facts.facts.set(id, observed)
    return
  }
  if (previous.locationEvidenceStatus === "conflicting") return
  if (previous.source !== observed.source || previous.location !== observed.location) {
    facts.conflicts.add(id)
    facts.facts.set(id, { source: null, location: null, locationEvidenceStatus: "conflicting" })
  }
}

export function invalidateObservedJobFact(facts: ObservedJobFacts, id: string): void {
  facts.conflicts.add(id)
  facts.facts.set(id, { source: null, location: null, locationEvidenceStatus: "conflicting" })
}

export function observedJobLocationProjection(facts: ObservedJobFacts, id: string): Readonly<{
  observedLocation: string | null
  locationEvidenceStatus: "verified" | "missing" | "conflicting"
}> {
  if (facts.conflicts.has(id)) return { observedLocation: null, locationEvidenceStatus: "conflicting" }
  const fact = facts.facts.get(id)
  if (!fact || fact.locationEvidenceStatus !== "verified" || !fact.location) {
    return { observedLocation: null, locationEvidenceStatus: "missing" }
  }
  return { observedLocation: fact.location, locationEvidenceStatus: "verified" }
}

export function addObservedEvidence(
  index: ObservedEvidenceWriteIndex,
  kind: ObservedEvidenceKind,
  ref: string,
  source: string,
  discovery: boolean,
  maxEntries: number,
  maxBytes: number,
): void {
  const key = observedEvidenceKey(kind, ref)
  if (index.conflicts.has(key)) return
  const existing = index.entries.get(key)
  if (existing) {
    if (existing.source !== source) { index.entries.delete(key); index.discoveryEntries.delete(key); index.conflicts.add(key) }
    return
  }
  const current = [...index.entries].filter(([entryKey]) => index.discoveryEntries.has(entryKey) === discovery).map(([, entry]) => entry)
  if (current.length >= maxEntries) { if (!discovery) return; throw new Error("child_discovery_evidence_limit") }
  const entry: RoleEvidence = { id: `read:${kind}:${ref}`, kind, ref, source }
  const serialized = JSON.stringify([...current, entry])
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maxBytes) { if (!discovery) return; throw new Error("child_discovery_evidence_limit") }
  index.entries.set(key, entry)
  if (discovery) index.discoveryEntries.add(key)
}

export function recordReadEvidence(
  index: ObservedEvidenceWriteIndex,
  item: unknown,
  kind: ObservedEvidenceKind,
  fallback: string,
  maxEntries: number,
  maxBytes: number,
  useItemSource = true,
): void {
  const evidence = plainRecord(item), ref = boundedText(evidence?.id)
  if (!evidence || !ref) return
  const source = useItemSource ? boundedText(evidence.source) ?? fallback : fallback
  addObservedEvidence(index, kind, ref, source, false, maxEntries, maxBytes)
  const key = observedEvidenceKey(kind, ref)
  if (kind === "job" && (index.entries.has(key) || index.conflicts.has(key))) {
    const actualSource = Object.hasOwn(evidence, "observedSource") ? evidence.observedSource : evidence.source
    recordObservedJobFact(index.jobFacts, ref, actualSource, evidence.location)
  }
}

export function recordDiscoveryEvidenceAtomically(
  index: ObservedEvidenceWriteIndex,
  jobs: readonly unknown[],
  maxEntries: number,
  maxBytes: number,
): void {
  const staged: ObservedEvidenceWriteIndex = {
    ...index,
    entries: new Map(index.entries), discoveryEntries: new Set(index.discoveryEntries), conflicts: new Set(index.conflicts),
    jobFacts: { facts: new Map(index.jobFacts.facts), conflicts: new Set(index.jobFacts.conflicts) },
  }
  for (const item of jobs) {
    const job = plainRecord(item), ref = boundedText(job?.id)
    if (!job || !ref) continue
    const source = boundedText(job.source) ?? "jobs.read"
    addObservedEvidence(staged, "job", ref, source, true, maxEntries, maxBytes)
    const key = observedEvidenceKey("job", ref)
    if (staged.entries.has(key) || staged.conflicts.has(key)) recordObservedJobFact(staged.jobFacts, ref, job.source, job.location)
  }
  index.entries.clear(); staged.entries.forEach((value, key) => index.entries.set(key, value))
  index.discoveryEntries.clear(); staged.discoveryEntries.forEach(key => index.discoveryEntries.add(key))
  index.conflicts.clear(); staged.conflicts.forEach(key => index.conflicts.add(key))
  index.jobFacts.facts.clear(); staged.jobFacts.facts.forEach((value, key) => index.jobFacts.facts.set(key, value))
  index.jobFacts.conflicts.clear(); staged.jobFacts.conflicts.forEach(key => index.jobFacts.conflicts.add(key))
}
