import { parseArtifactReference, ROLE_RESULT_SCHEMA, validateRoleResult, type PrepareResult, type StructuredRole, type StructuredRoleResult } from "./role-results.js"
import { artifactReferenceKey, artifactResultKey, parseAndBindStructuredResultOutcome, scheduledPrepareIdentityKey } from "./child-structured-result-outcome.js"
import type { ContextSeedBlock } from "../context/step-context-builder.js"
import type { ScheduledPrepareReference } from "./child-scheduled-prepare-reference.js"
import { createTaskGraphObservedReadEvidenceIndex, parseTaskGraphRestoredToolObservations,
  recordTaskGraphObservedReadObservation, recordTaskGraphObservedReadOutput,
  type TaskGraphObservedReadEvidenceIndex, type TaskGraphRestoredToolObservation } from "@jobcopilot/shared/task-graph-read-observations"

const MAX_EVIDENCE_FIELD_LENGTH = 256
export type ScheduledPrepareToolBinding = Readonly<{ toolCallId: string; taskId: string; attemptCount: number; reference?: ScheduledPrepareReference }>
type ScheduledPrepareReceipt = Readonly<{ toolCallId: string; result: PrepareResult; reference?: ScheduledPrepareReference }>

export type ObservedEvidenceIndex = TaskGraphObservedReadEvidenceIndex & Readonly<{
  artifactResults: Map<string, StructuredRoleResult>
  scheduledPrepareResults: Map<string, ScheduledPrepareReceipt>
  scheduledPrepareResultConflicts: Set<string>
  artifactReads: Set<string>
}>
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

export function createObservedEvidenceIndex(): ObservedEvidenceIndex { return { ...createTaskGraphObservedReadEvidenceIndex(), artifactResults: new Map(), scheduledPrepareResults: new Map(), scheduledPrepareResultConflicts: new Set(), artifactReads: new Set() } }

/** Rehydrates only server-shaped read results from a durable child attempt. */
export function hydrateObservedEvidence(index: ObservedEvidenceIndex, observations: readonly ContextSeedBlock[], prepareScope?: Pick<ScheduledPrepareToolBinding, "taskId" | "attemptCount">): void {
  if (!Array.isArray(observations) || index.conflicts.size > 0) throw new Error("child_resume_evidence_invalid")
  const restoredObservations: readonly TaskGraphRestoredToolObservation[] = parseTaskGraphRestoredToolObservations(observations)
  for (const [position, restored] of restoredObservations.entries()) {
    if (restored.failed) continue
    if (recordTaskGraphObservedReadObservation(index, restored, restoredObservations, position)) continue
    const conflictCount = index.conflicts.size
    const binding = restored.toolName === "scheduled.application.prepare" && prepareScope
      ? { toolCallId: restored.toolCallId, ...prepareScope } : undefined
    if (restored.toolName === "scheduled.application.prepare" && (!binding || plainRecord(restored.output)?.taskId !== binding.taskId
      || plainRecord(restored.output)?.attemptCount !== binding.attemptCount)) continue
    recordReadToolOutput(index, restored.toolName, restored.output, restored.input, binding)
    if (index.conflicts.size !== conflictCount || index.conflicts.size > 0) throw new Error("child_resume_evidence_conflict")
  }
}

export function recordReadToolOutput(index: ObservedEvidenceIndex, toolName: string, output: unknown, request?: unknown, prepareBinding?: ScheduledPrepareToolBinding): void {
  if (recordTaskGraphObservedReadOutput(index, toolName, output, request)) return
  try {
    const value = plainRecord(output)
    if (!value) return
    if (toolName === "scheduled.application.prepare") { recordScheduledPrepareResult(index, output, prepareBinding); return }
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
    }
  } catch {
    return
  }
}
function recordScheduledPrepareResult(index: ObservedEvidenceIndex, output: unknown, binding: ScheduledPrepareToolBinding | undefined): void {
  if (!binding || !boundedText(binding.toolCallId) || !boundedText(binding.taskId) || !Number.isSafeInteger(binding.attemptCount) || binding.attemptCount < 1) return
  const identity = scheduledPrepareIdentityKey(binding.taskId, binding.attemptCount)
  let result: PrepareResult
  try { result = validateRoleResult(output, "prepare") } catch { index.scheduledPrepareResultConflicts.add(identity); index.scheduledPrepareResults.delete(identity); return }
  if (result.taskId !== binding.taskId || result.attemptCount !== binding.attemptCount) {
    index.scheduledPrepareResultConflicts.add(identity); index.scheduledPrepareResults.delete(identity); return
  }
  const previous = index.scheduledPrepareResults.get(identity)
  if (previous && (previous.toolCallId !== binding.toolCallId || JSON.stringify(previous.result) !== JSON.stringify(result)
    || JSON.stringify(previous.reference) !== JSON.stringify(binding.reference))) {
    index.scheduledPrepareResultConflicts.add(identity); index.scheduledPrepareResults.delete(identity); return
  }
  if (!index.scheduledPrepareResultConflicts.has(identity)) index.scheduledPrepareResults.set(identity, {
    toolCallId: binding.toolCallId, result, ...(binding.reference ? { reference: binding.reference } : {}),
  })
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
