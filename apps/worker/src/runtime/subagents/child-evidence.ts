import { Buffer } from "node:buffer"

import { parseArtifactReference, ROLE_RESULT_SCHEMA, validateRoleResult, type RoleEvidence, type StructuredRole, type StructuredRoleResult } from "./role-results.js"
import { artifactReferenceKey, artifactResultKey, MAX_EVIDENCE_BYTES, parseAndBindStructuredResultOutcome } from "./child-structured-result-outcome.js"
import { createDurableDiscoveryAssembly, invalidateDurableDiscoveryAssembly, isPlainJson, MAX_DURABLE_DISCOVERY_BYTES, parseDurableDiscoveryReference, reduceDurableDiscoveryChunk, type DurableDiscoveryAssembly, type DurableDiscoveryReference } from "./child-durable-discovery.js"
import type { ContextSeedBlock } from "../context/step-context-builder.js"
import { redactJobReadOutput } from "../tools/job-read-output-redaction.js"

const MAX_EVIDENCE_ENTRIES = 50
// Accommodates 50 canonical IDs and 80-character sources after JSON escaping.
const MAX_DISCOVERY_EVIDENCE_BYTES = 32 * 1024
const MAX_EVIDENCE_FIELD_LENGTH = 256
const MAX_RESTORED_OBSERVATIONS = 256
const MAX_LIVE_DISCOVERY_BYTES = MAX_DURABLE_DISCOVERY_BYTES
const RESTORED_TOOL_KEYS = ["toolCallId", "toolName", "input", "status", "output", "errorCode"] as const
const RESTORED_READ_TOOLS = new Set(["jobs.search", "jobs.get", "jobs.discover", "persona.retrieve", "resume.get_base", "application.get_state", "tool_results.read", "cover_letter.draft", "artifact.version.read", "artifact.review"])
type ObservedEvidenceKind = "job" | "persona" | "resume"
type RestoredObservation = { readonly toolName: string; readonly input: unknown; readonly output: unknown; readonly failed: boolean }

export type ObservedEvidenceIndex = {
  readonly entries: Map<string, RoleEvidence>
  readonly discoveryEntries: Set<string>
  readonly conflicts: Set<string>
  readonly artifactResults: Map<string, StructuredRoleResult>
  readonly artifactReads: Set<string>
  readonly durableDiscoveries: Map<string, DurableDiscoveryAssembly>
  readonly durableDiscoveryJobRefs: Map<string, readonly string[]>
  durableDiscoveryBytes: number
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
      ? Object.getOwnPropertySymbols(value).length === 0 ? value as Record<string, unknown> : undefined
      : undefined
  } catch { return undefined }
}

function boundedText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_EVIDENCE_FIELD_LENGTH ? value : undefined
}

function evidenceKey(kind: string, ref: string): string { return `${kind}\u0000${ref}` }

export function createObservedEvidenceIndex(): ObservedEvidenceIndex { return { entries: new Map(), discoveryEntries: new Set(), conflicts: new Set(), artifactResults: new Map(), artifactReads: new Set(), durableDiscoveries: new Map(), durableDiscoveryJobRefs: new Map(), durableDiscoveryBytes: 0 } }

function restoredObservation(value: ContextSeedBlock): RestoredObservation {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.id !== "string" || value.id.trim() !== value.id || value.id.length === 0 || value.id.length > MAX_EVIDENCE_FIELD_LENGTH) throw new Error("child_resume_evidence_invalid")
  const content = plainRecord(value.content)
  if (!content || Object.keys(content).length !== RESTORED_TOOL_KEYS.length || Object.keys(content).some(key => !(RESTORED_TOOL_KEYS as readonly string[]).includes(key))) throw new Error("child_resume_evidence_invalid")
  const validText = (item: unknown): item is string => typeof item === "string" && item.trim() === item && item.length > 0 && item.length <= MAX_EVIDENCE_FIELD_LENGTH
  if (!validText(content.toolCallId) || !validText(content.toolName) || !RESTORED_READ_TOOLS.has(content.toolName)
    || !isPlainJson(content.input) || !isPlainJson(content.output)
    || (content.status !== "completed" && content.status !== "failed")
    || (content.status === "completed" ? content.errorCode !== null : !validText(content.errorCode))) throw new Error("child_resume_evidence_invalid")
  const encoded = JSON.stringify(content)
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_EVIDENCE_BYTES) throw new Error("child_resume_evidence_limit")
  return { toolName: content.toolName, input: content.input, output: content.output, failed: content.status === "failed" }
}

function validateDiscoveryOutput(output: unknown): unknown { const safe = redactJobReadOutput("jobs.discover", output); if (safe === "[REDACTED]") throw new Error("child_resume_evidence_invalid"); return safe }

function invalidateDiscoveryEvidence(index: ObservedEvidenceIndex, reference: string): void {
  for (const id of index.durableDiscoveryJobRefs.get(reference) ?? []) {
    const key = evidenceKey("job", id)
    index.entries.delete(key); index.discoveryEntries.delete(key); index.conflicts.add(key)
  }
  index.durableDiscoveryJobRefs.delete(reference)
}

function invalidateDurableDiscovery(index: ObservedEvidenceIndex, assembly: DurableDiscoveryAssembly, releasedBytes?: number): undefined {
  const released = releasedBytes ?? invalidateDurableDiscoveryAssembly(assembly)
  if (index.durableDiscoveries.get(assembly.reference.ref) === assembly) index.durableDiscoveryBytes -= released
  invalidateDiscoveryEvidence(index, assembly.reference.ref)
}

function restoreDurableDiscovery(reference: DurableDiscoveryReference, observations: readonly RestoredObservation[], after: number): unknown {
  const assembly = createDurableDiscoveryAssembly(reference); let completed: unknown
  for (let i = after + 1; i < observations.length; i += 1) {
    const observation = observations[i]!
    if (observation.toolName !== "tool_results.read") continue
    const inputRef = plainRecord(observation.input)?.referenceId
    const outputRef = plainRecord(observation.output)?.ref
    if (inputRef !== reference.ref && outputRef !== reference.ref) continue
    if (observation.failed) continue
    const reduction = reduceDurableDiscoveryChunk(assembly, observation.output, observation.input)
    if (reduction.kind === "invalid") throw new Error("child_resume_evidence_invalid")
    if (reduction.kind === "complete") completed = reduction.value
  }
  if (completed === undefined) throw new Error("child_resume_evidence_invalid")
  return completed
}

/** Rehydrates only server-shaped read results from a durable child attempt. */
export function hydrateObservedEvidence(index: ObservedEvidenceIndex, observations: readonly ContextSeedBlock[]): void {
  if (!Array.isArray(observations) || observations.length > MAX_RESTORED_OBSERVATIONS || index.conflicts.size > 0) throw new Error("child_resume_evidence_invalid")
  const restoredObservations = observations.map(restoredObservation)
  for (const [position, restored] of restoredObservations.entries()) {
    if (restored.failed) continue
    const reference = restored.toolName === "jobs.discover" ? parseDurableDiscoveryReference(restored.output) : undefined
    const output = restored.toolName === "jobs.discover"
      ? reference ? restoreDurableDiscovery(reference, restoredObservations, position) : validateDiscoveryOutput(restored.output)
      : restored.output
    const conflictCount = index.conflicts.size
    recordReadToolOutput(index, restored.toolName, output)
    if (index.conflicts.size !== conflictCount || index.conflicts.size > 0) throw new Error("child_resume_evidence_conflict")
  }
}

function addObservedEvidence(index: ObservedEvidenceIndex, kind: ObservedEvidenceKind, ref: string, source: string, discovery = false): void {
  const key = evidenceKey(kind, ref)
  if (index.conflicts.has(key)) return
  const existing = index.entries.get(key)
  if (existing) {
    if (existing.source !== source) { index.entries.delete(key); index.discoveryEntries.delete(key); index.conflicts.add(key) }
    return
  }
  const current = [...index.entries].filter(([entryKey]) => index.discoveryEntries.has(entryKey) === discovery).map(([, entry]) => entry)
  if (current.length >= MAX_EVIDENCE_ENTRIES) { if (!discovery) return; throw new Error("child_discovery_evidence_limit") }
  const entry: RoleEvidence = { id: `read:${kind}:${ref}`, kind, ref, source }
  const serialized = JSON.stringify([...current, entry])
  const maxBytes = discovery ? MAX_DISCOVERY_EVIDENCE_BYTES : MAX_EVIDENCE_BYTES
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maxBytes) { if (!discovery) return; throw new Error("child_discovery_evidence_limit") }
  index.entries.set(key, entry)
  if (discovery) index.discoveryEntries.add(key)
}

function recordDiscoveryEvidenceAtomically(index: ObservedEvidenceIndex, jobs: readonly unknown[]): void {
  const staged: ObservedEvidenceIndex = { ...index, entries: new Map(index.entries), discoveryEntries: new Set(index.discoveryEntries), conflicts: new Set(index.conflicts) }
  for (const item of jobs) {
    const job = plainRecord(item)
    const ref = boundedText(job?.id)
    if (ref) addObservedEvidence(staged, "job", ref, boundedText(job?.source) ?? "jobs.read", true)
  }
  index.entries.clear(); staged.entries.forEach((value, key) => index.entries.set(key, value))
  index.discoveryEntries.clear(); staged.discoveryEntries.forEach(key => index.discoveryEntries.add(key))
  index.conflicts.clear(); staged.conflicts.forEach(key => index.conflicts.add(key))
}

function recordReadEvidence(index: ObservedEvidenceIndex, item: unknown, kind: ObservedEvidenceKind, fallback: string, useItemSource = true): void {
  const evidence = plainRecord(item)
  const ref = boundedText(evidence?.id)
  if (ref) addObservedEvidence(index, kind, ref, useItemSource ? boundedText(evidence?.source) ?? fallback : fallback)
}

export function recordReadToolOutput(index: ObservedEvidenceIndex, toolName: string, output: unknown, request?: unknown): void {
  try {
    const value = plainRecord(output)
    if (!value) return
    if (toolName === "cover_letter.draft") {
      recordArtifactToolResult(index, {
        schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef: value.artifactRef,
      })
      return
    }
    if (toolName === "artifact.review") {
      recordArtifactToolResult(index, {
        schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer", status: "completed", artifactRef: value.artifactRef,
        reviewStatus: value.status, reviewHash: value.reviewHash,
      })
      return
    }
    if (toolName === "artifact.version.read") {
      if (!Object.prototype.hasOwnProperty.call(value, "content")) return
      try { index.artifactReads.add(artifactReferenceKey(parseArtifactReference(value.artifactRef))) } catch { return }
      return
    }
    if (toolName === "jobs.discover") {
      let reference: DurableDiscoveryReference | undefined
      try { reference = parseDurableDiscoveryReference(output) } catch {
        const ref = value.$ref
        if (typeof ref === "string") { const pending = index.durableDiscoveries.get(ref); if (pending) invalidateDurableDiscovery(index, pending) }
        throw new Error("child_resume_evidence_invalid")
      }
      if (reference) {
        const previous = index.durableDiscoveries.get(reference.ref)
        if (previous) {
          if (previous.reference.byteCount !== reference.byteCount || previous.reference.sha256 !== reference.sha256) invalidateDurableDiscovery(index, previous)
        } else if (index.durableDiscoveries.size < MAX_RESTORED_OBSERVATIONS) index.durableDiscoveries.set(reference.ref, createDurableDiscoveryAssembly(reference))
        return
      }
      const jobsOutput = plainRecord(validateDiscoveryOutput(output))
      if (!jobsOutput || !Array.isArray(jobsOutput.jobs)) return
      recordDiscoveryEvidenceAtomically(index, jobsOutput.jobs)
      return
    }
    if (toolName === "tool_results.read") {
      const outputRef = value.ref
      const inputRef = plainRecord(request)?.referenceId
      const assembly = index.durableDiscoveries.get(typeof outputRef === "string" ? outputRef : "")
        ?? index.durableDiscoveries.get(typeof inputRef === "string" ? inputRef : "")
      if (!assembly) return
      const live = index.durableDiscoveries.get(assembly.reference.ref) === assembly
      const maxBufferedBytes = live ? MAX_LIVE_DISCOVERY_BYTES - index.durableDiscoveryBytes + assembly.bytesStored : undefined
      const reduction = reduceDurableDiscoveryChunk(assembly, output, request, maxBufferedBytes)
      if (live) index.durableDiscoveryBytes += reduction.addedBytes - reduction.releasedBytes
      if (reduction.kind === "invalid") { invalidateDurableDiscovery(index, assembly, 0); return }
      if (reduction.kind === "complete") {
        let safe: Record<string, unknown> | undefined
        try {
          safe = plainRecord(validateDiscoveryOutput(reduction.value))
          if (!safe || !Array.isArray(safe.jobs)) throw new Error("child_resume_evidence_invalid")
        } catch { invalidateDurableDiscovery(index, assembly); return }
        recordDiscoveryEvidenceAtomically(index, safe.jobs)
        index.durableDiscoveryJobRefs.set(assembly.reference.ref, safe.jobs.map(item => boundedText(plainRecord(item)?.id)).filter((id): id is string => Boolean(id)))
      }
      return
    }
    if (toolName === "jobs.search") {
      if (!Array.isArray(value.jobs)) return
      for (const item of value.jobs) recordReadEvidence(index, item, "job", "jobs.read")
      return
    }
    if (toolName === "jobs.get") return recordReadEvidence(index, value.job, "job", "jobs.read")
    if (toolName === "persona.retrieve") {
      if (Array.isArray(value.facts)) for (const item of value.facts) recordReadEvidence(index, item, "persona", "persona.retrieve")
      return
    }
    if (toolName === "resume.get_base") return recordReadEvidence(index, value.resume, "resume", "resume.get_base", false)
  } catch (error) {
    if (toolName === "jobs.discover" && error instanceof Error && error.message === "child_discovery_evidence_limit") throw error
  }
}

export { artifactReferenceKey }

function recordArtifactToolResult(index: ObservedEvidenceIndex, value: unknown): void {
  const validated = validateRoleResult(value)
  if (validated.role !== "writer" && validated.role !== "reviewer") return
  const key = artifactResultKey(validated)
  const previous = index.artifactResults.get(key)
  if (previous && JSON.stringify(previous) !== JSON.stringify(validated)) index.artifactResults.delete(key)
  else index.artifactResults.set(key, validated)
}

export function parseAndBindStructuredResult<T extends StructuredRole>(value: string, role: T, index: ObservedEvidenceIndex): Extract<StructuredRoleResult, { role: T }> | undefined {
  const outcome = parseAndBindStructuredResultOutcome(value, role, index)
  return outcome.kind === "valid" ? outcome.result : undefined
}
