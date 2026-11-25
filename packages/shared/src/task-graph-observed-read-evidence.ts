import { Buffer } from "node:buffer"
import { createDurableDiscoveryAssembly, invalidateDurableDiscoveryAssembly, isPlainJson, MAX_DURABLE_DISCOVERY_BYTES,
  parseDurableDiscoveryReference, reduceDurableDiscoveryChunk, type DurableDiscoveryAssembly,
  type DurableDiscoveryReference } from "./task-graph-durable-discovery.js"
import { redactJobReadOutput } from "./task-graph-job-read-redaction.js"
import { createObservedJobFacts, invalidateObservedJobFact, observedEvidenceKey, recordDiscoveryEvidenceAtomically, recordReadEvidence,
  type ObservedEvidenceWriteIndex, type ObservedJobFacts } from "./task-graph-observed-job-facts.js"
import { isTaskGraphEvidenceToolName } from "./task-graph-verification-digest.js"

type Row = Record<string, unknown>
export type TaskGraphRestoredToolObservation = Readonly<{ toolCallId: string; toolName: string; input: unknown; output: unknown; failed: boolean }>
type ObservedReadEvidence = Readonly<{ id: string; kind: "job" | "persona" | "resume" | "source"; ref: string; source: string }>
export type TaskGraphObservedReadEvidenceIndex = ObservedEvidenceWriteIndex & {
  durableDiscoveries: Map<string, DurableDiscoveryAssembly>
  durableDiscoveryJobRefs: Map<string, readonly string[]>
  durableDiscoveryBytes: number
}
const MAX_EVIDENCE_ENTRIES = 50
const MAX_EVIDENCE_BYTES = 8 * 1024
const MAX_DISCOVERY_EVIDENCE_BYTES = 32 * 1024
const MAX_RESTORED_OBSERVATIONS = 256
const MAX_LIVE_DISCOVERY_BYTES = MAX_DURABLE_DISCOVERY_BYTES
const RESTORED_TOOL_KEYS = ["toolCallId", "toolName", "input", "status", "output", "errorCode"] as const
const RESTORED_TOOL_NAMES = new Set(["jobs.search", "jobs.get", "jobs.discover", "tool_results.read", "persona.retrieve", "resume.get_base",
  "application.get_state", "cover_letter.draft", "artifact.version.read", "artifact.review", "scheduled.application.prepare"])

function plainRecord(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
      ? Object.getOwnPropertySymbols(value).length === 0 ? value as Row : undefined : undefined
  } catch { return undefined }
}

function boundedText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 ? value : undefined
}

export function createTaskGraphObservedReadEvidenceIndex(): TaskGraphObservedReadEvidenceIndex {
  return { entries: new Map<string, ObservedReadEvidence>(), discoveryEntries: new Set(), conflicts: new Set(),
    jobFacts: createObservedJobFacts(), durableDiscoveries: new Map(), durableDiscoveryJobRefs: new Map(), durableDiscoveryBytes: 0 }
}

function isTaskGraphReadEvidenceToolName(toolName: string): boolean {
  return isTaskGraphEvidenceToolName(toolName)
}

function parseTaskGraphRestoredToolObservation(value: unknown): TaskGraphRestoredToolObservation {
  const row = plainRecord(value)
  if (!row || typeof row.id !== "string" || row.id.trim() !== row.id || row.id.length === 0 || row.id.length > 256) {
    throw new Error("child_resume_evidence_invalid")
  }
  const content = plainRecord(row.content)
  if (!content || Object.keys(content).length !== RESTORED_TOOL_KEYS.length
    || Object.keys(content).some(key => !(RESTORED_TOOL_KEYS as readonly string[]).includes(key))) throw new Error("child_resume_evidence_invalid")
  const validText = (item: unknown): item is string => typeof item === "string" && item.trim() === item && item.length > 0 && item.length <= 256
  if (!validText(content.toolCallId) || !validText(content.toolName) || !RESTORED_TOOL_NAMES.has(content.toolName)
    || !isPlainJson(content.input) || !isPlainJson(content.output)
    || (content.status !== "completed" && content.status !== "failed")
    || (content.status === "completed" ? content.errorCode !== null : !validText(content.errorCode))) throw new Error("child_resume_evidence_invalid")
  const encoded = JSON.stringify(content)
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_EVIDENCE_BYTES) throw new Error("child_resume_evidence_limit")
  return { toolCallId: content.toolCallId, toolName: content.toolName, input: content.input, output: content.output, failed: content.status === "failed" }
}

export function parseTaskGraphRestoredToolObservations(values: readonly unknown[]): readonly TaskGraphRestoredToolObservation[] {
  if (!Array.isArray(values) || values.length > MAX_RESTORED_OBSERVATIONS) throw new Error("child_resume_evidence_invalid")
  return values.map(parseTaskGraphRestoredToolObservation)
}

function validateDiscoveryOutput(output: unknown): unknown {
  const safe = redactJobReadOutput("jobs.discover", output)
  if (safe === "[REDACTED]") throw new Error("child_resume_evidence_invalid")
  return safe
}

function invalidateDiscoveryEvidence(index: TaskGraphObservedReadEvidenceIndex, reference: string): void {
  for (const id of index.durableDiscoveryJobRefs.get(reference) ?? []) {
    const key = observedEvidenceKey("job", id)
    index.entries.delete(key); index.discoveryEntries.delete(key); index.conflicts.add(key)
    invalidateObservedJobFact(index.jobFacts, id)
  }
  index.durableDiscoveryJobRefs.delete(reference)
}

function invalidateDurableDiscovery(index: TaskGraphObservedReadEvidenceIndex, assembly: DurableDiscoveryAssembly, releasedBytes?: number): undefined {
  const released = releasedBytes ?? invalidateDurableDiscoveryAssembly(assembly)
  if (index.durableDiscoveries.get(assembly.reference.ref) === assembly) index.durableDiscoveryBytes -= released
  invalidateDiscoveryEvidence(index, assembly.reference.ref)
}

function restoreDurableDiscovery(reference: DurableDiscoveryReference, observations: readonly TaskGraphRestoredToolObservation[], after: number): unknown {
  const assembly = createDurableDiscoveryAssembly(reference)
  let completed: unknown
  for (let index = after + 1; index < observations.length; index += 1) {
    const observation = observations[index]!
    if (observation.toolName !== "tool_results.read") continue
    const inputRef = plainRecord(observation.input)?.referenceId, outputRef = plainRecord(observation.output)?.ref
    if (inputRef !== reference.ref && outputRef !== reference.ref || observation.failed) continue
    const reduction = reduceDurableDiscoveryChunk(assembly, observation.output, observation.input)
    if (reduction.kind === "invalid") throw new Error("child_resume_evidence_invalid")
    if (reduction.kind === "complete") completed = reduction.value
  }
  if (completed === undefined) throw new Error("child_resume_evidence_invalid")
  return completed
}

/** Rehydrates the exact six-tool read evidence index from canonical observations. */
export function hydrateTaskGraphObservedReadEvidence(index: TaskGraphObservedReadEvidenceIndex,
  observations: readonly unknown[]): void {
  if (index.conflicts.size > 0) {
    throw new Error("child_resume_evidence_invalid")
  }
  const restored = parseTaskGraphRestoredToolObservations(observations)
  for (const [position, observation] of restored.entries()) {
    recordTaskGraphObservedReadObservation(index, observation, restored, position)
  }
}

export function recordTaskGraphObservedReadObservation(index: TaskGraphObservedReadEvidenceIndex,
  observation: TaskGraphRestoredToolObservation, observations: readonly TaskGraphRestoredToolObservation[], position: number): boolean {
  if (observation.failed || !isTaskGraphReadEvidenceToolName(observation.toolName)) return false
  const reference = observation.toolName === "jobs.discover" ? parseDurableDiscoveryReference(observation.output) : undefined
  const output = observation.toolName === "jobs.discover"
    ? reference ? restoreDurableDiscovery(reference, observations, position) : validateDiscoveryOutput(observation.output)
    : observation.output
  const conflictCount = index.conflicts.size
  recordTaskGraphObservedReadOutput(index, observation.toolName, output, observation.input)
  if (index.conflicts.size !== conflictCount || index.conflicts.size > 0) throw new Error("child_resume_evidence_conflict")
  return true
}

/** Adds a successful live read-tool result; non-read tools return false for Worker-specific handling. */
export function recordTaskGraphObservedReadOutput(index: TaskGraphObservedReadEvidenceIndex, toolName: string,
  output: unknown, request?: unknown): boolean {
  if (!isTaskGraphReadEvidenceToolName(toolName)) return false
  try {
    const value = plainRecord(output)
    if (!value) return true
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
        return true
      }
      const jobsOutput = plainRecord(validateDiscoveryOutput(output))
      if (jobsOutput && Array.isArray(jobsOutput.jobs)) recordDiscoveryEvidenceAtomically(index, jobsOutput.jobs, MAX_EVIDENCE_ENTRIES, MAX_DISCOVERY_EVIDENCE_BYTES)
      return true
    }
    if (toolName === "tool_results.read") {
      const outputRef = value.ref, inputRef = plainRecord(request)?.referenceId
      const assembly = index.durableDiscoveries.get(typeof outputRef === "string" ? outputRef : "")
        ?? index.durableDiscoveries.get(typeof inputRef === "string" ? inputRef : "")
      if (!assembly) return true
      const live = index.durableDiscoveries.get(assembly.reference.ref) === assembly
      const maxBufferedBytes = live ? MAX_LIVE_DISCOVERY_BYTES - index.durableDiscoveryBytes + assembly.bytesStored : undefined
      const reduction = reduceDurableDiscoveryChunk(assembly, output, request, maxBufferedBytes)
      if (live) index.durableDiscoveryBytes += reduction.addedBytes - reduction.releasedBytes
      if (reduction.kind === "invalid") { invalidateDurableDiscovery(index, assembly, 0); return true }
      if (reduction.kind === "complete") {
        let safe: Row | undefined
        try {
          safe = plainRecord(validateDiscoveryOutput(reduction.value))
          if (!safe || !Array.isArray(safe.jobs)) throw new Error("child_resume_evidence_invalid")
        } catch { invalidateDurableDiscovery(index, assembly); return true }
        recordDiscoveryEvidenceAtomically(index, safe.jobs, MAX_EVIDENCE_ENTRIES, MAX_DISCOVERY_EVIDENCE_BYTES)
        index.durableDiscoveryJobRefs.set(assembly.reference.ref, safe.jobs.map(item => boundedText(plainRecord(item)?.id)).filter((id): id is string => Boolean(id)))
      }
      return true
    }
    if (toolName === "jobs.search") {
      if (Array.isArray(value.jobs)) for (const item of value.jobs) recordReadEvidence(index, item, "job", "jobs.read", MAX_EVIDENCE_ENTRIES, MAX_EVIDENCE_BYTES)
      return true
    }
    if (toolName === "jobs.get") { recordReadEvidence(index, value.job, "job", "jobs.read", MAX_EVIDENCE_ENTRIES, MAX_EVIDENCE_BYTES); return true }
    if (toolName === "persona.retrieve") {
      if (Array.isArray(value.facts)) for (const item of value.facts) recordReadEvidence(index, item, "persona", "persona.retrieve", MAX_EVIDENCE_ENTRIES, MAX_EVIDENCE_BYTES)
      return true
    }
    recordReadEvidence(index, value.resume, "resume", "resume.get_base", MAX_EVIDENCE_ENTRIES, MAX_EVIDENCE_BYTES, false)
    return true
  } catch (error) {
    if (toolName === "jobs.discover" && error instanceof Error && error.message === "child_discovery_evidence_limit") throw error
    return true
  }
}
