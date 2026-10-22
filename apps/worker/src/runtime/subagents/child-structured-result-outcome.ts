import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { redactSensitiveValue } from "@jobcopilot/shared"

import { roleResultOutputSchema, validateRoleResult, RoleResultValidationError, type ArtifactVersionReference, type PrepareResult, type RoleEvidence, type StructuredRole, type StructuredRoleResult } from "./role-results.js"
import { parseScheduledPrepareReference, type ScheduledPrepareReference } from "./child-scheduled-prepare-reference.js"
import type { ObservedEvidenceIndex } from "./child-evidence.js"

export const MAX_EVIDENCE_BYTES = 8 * 1024
const PREPARE_REFERENCE_SCHEMA = { type: "object", properties: {
  $ref: { type: "string", pattern: "^tool-result-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" },
  sizeBytes: { type: "integer", minimum: 1, maximum: 1048576 }, sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
}, required: ["$ref", "sizeBytes", "sha256"], additionalProperties: false }

export function structuredResultOutputSchema(role: StructuredRole): Record<string, unknown> {
  const result = roleResultOutputSchema(role)
  return role === "prepare" ? { anyOf: [result, PREPARE_REFERENCE_SCHEMA] } : result
}

export type StructuredOutputFailureCategory =
  | "missing_final_output"
  | "result_too_large"
  | "result_shape_invalid"
  | "evidence_binding_invalid"

export type StructuredResultParseOutcome<T extends StructuredRole> =
  | { readonly kind: "valid"; readonly result: Extract<StructuredRoleResult, { role: T }> }
  | { readonly kind: "invalid"; readonly category?: StructuredOutputFailureCategory }

function invalid<T extends StructuredRole>(category?: StructuredOutputFailureCategory): StructuredResultParseOutcome<T> {
  return category ? { kind: "invalid", category } : { kind: "invalid" }
}

function validationFailureCategory(error: unknown): StructuredOutputFailureCategory | undefined {
  if (!(error instanceof RoleResultValidationError)) return undefined
  if (error.code === "missing_evidence") return "evidence_binding_invalid"
  if (error.code === "invalid_shape" || error.code === "missing_id" || error.code === "invalid_score") return "result_shape_invalid"
  return undefined
}

function evidenceKey(kind: string, ref: string): string { return `${kind}\u0000${ref}` }

export function artifactReferenceKey(value: ArtifactVersionReference): string {
  return `${value.artifactId}:${value.version}:${value.contentHash}:${value.sourceDigest}`
}

export function artifactResultKey(value: StructuredRoleResult): string {
  if (value.role === "writer") return `writer:${value.artifactRef.artifactId}:${value.artifactRef.version}:${value.artifactRef.contentHash}:${value.artifactRef.sourceDigest}`
  if (value.role === "reviewer") return `reviewer:${value.artifactRef.artifactId}:${value.artifactRef.version}:${value.artifactRef.contentHash}:${value.artifactRef.sourceDigest}:${value.reviewStatus}:${value.reviewHash}`
  if (value.role === "prepare") return scheduledPrepareToolReceiptKey(value)
  return ""
}

/** Stable lookup key for the exact successful registered Prepare tool output. */
export function scheduledPrepareToolReceiptKey(value: PrepareResult): string {
  return `scheduled.application.prepare:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`
}

export function scheduledPrepareIdentityKey(taskId: string, attemptCount: number): string { return `${taskId}\u0000${attemptCount}` }

function structurallyEqualJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((entry, index) => structurallyEqualJson(entry, right[index]))
  }
  const leftKeys = Object.keys(left), rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length && leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key)
    && structurallyEqualJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
}

function normalizeRegisteredPrepareReceipt(value: unknown, index: ObservedEvidenceIndex): { result: PrepareResult; referenceBound: boolean } | undefined {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) return undefined
  let reference: ScheduledPrepareReference | undefined
  try { reference = parseScheduledPrepareReference(value) } catch { /* Inline receipts use the existing comparison below. */ }
  let match: { result: PrepareResult; referenceBound: boolean } | undefined
  for (const [identity, receipt] of index.scheduledPrepareResults) {
    if (index.scheduledPrepareResultConflicts.has(identity) || !receipt.toolCallId || receipt.toolCallId.trim() !== receipt.toolCallId) continue
    let canonical: PrepareResult
    try { canonical = validateRoleResult(receipt.result, "prepare") } catch { continue }
    if (scheduledPrepareIdentityKey(canonical.taskId, canonical.attemptCount) !== identity) continue
    const matchesReference = Boolean(reference && receipt.reference && structurallyEqualJson(reference, receipt.reference))
    if (reference ? !matchesReference : !structurallyEqualJson(value, canonical) && !structurallyEqualJson(value, redactSensitiveValue(canonical))) continue
    if (match) return undefined
    match = { result: canonical, referenceBound: matchesReference }
  }
  return match
}

function normalizeStructuredResult(value: StructuredRoleResult, index: ObservedEvidenceIndex): StructuredRoleResult | undefined {
  if (value.role === "writer") {
    let latestVersion = 0
    let hasConflictingReference = false
    const referencesByVersion = new Map<number, string>()
    for (const observed of index.artifactResults.values()) {
      if (observed.role !== "writer" || observed.artifactRef.artifactId !== value.artifactRef.artifactId) continue
      const reference = artifactReferenceKey(observed.artifactRef)
      const previous = referencesByVersion.get(observed.artifactRef.version)
      if (previous !== undefined && previous !== reference) hasConflictingReference = true
      else referencesByVersion.set(observed.artifactRef.version, reference)
      latestVersion = Math.max(latestVersion, observed.artifactRef.version)
    }
    if (hasConflictingReference || latestVersion !== value.artifactRef.version) return undefined
    return index.artifactResults.get(artifactResultKey(value))
  }
  if (value.role === "reviewer") {
    if (!index.artifactReads.has(artifactReferenceKey(value.artifactRef))) return undefined
    return index.artifactResults.get(artifactResultKey(value))
  }
  if (value.role === "prepare") {
    const identity = scheduledPrepareIdentityKey(value.taskId, value.attemptCount)
    const receipt = index.scheduledPrepareResults.get(identity)
    return !index.scheduledPrepareResultConflicts.has(identity) && receipt?.toolCallId
      && JSON.stringify(receipt.result) === JSON.stringify(value) ? receipt.result : undefined
  }
  const canonicalByModelId = new Map<string, string>()
  const seenCanonical = new Set<string>()
  const evidence: RoleEvidence[] = []
  for (const item of value.evidence) {
    const key = evidenceKey(item.kind, item.ref)
    const observed = index.entries.get(key)
    if (!observed || index.conflicts.has(key) || seenCanonical.has(observed.id)) return undefined
    seenCanonical.add(observed.id)
    canonicalByModelId.set(item.id, observed.id)
    evidence.push(observed)
  }
  const rewriteEvidenceIds = (ids: readonly string[]): string[] | undefined => {
    const rewritten = ids.map(id => canonicalByModelId.get(id))
    return rewritten.every((id): id is string => typeof id === "string") ? rewritten : undefined
  }
  if (value.role === "scout") {
    const candidates = []
    for (const candidate of value.candidates) {
      const jobKey = evidenceKey("job", candidate.jobId)
      const observedJob = index.entries.get(jobKey)
      if (!observedJob || index.conflicts.has(jobKey) || candidate.source !== observedJob.source) return undefined
      const evidenceIds = rewriteEvidenceIds(candidate.evidenceIds)
      if (!evidenceIds) return undefined
      candidates.push({ ...candidate, evidenceIds })
    }
    return { ...value, candidates, evidence }
  }
  const findings = []
  for (const finding of value.findings) {
    const evidenceIds = rewriteEvidenceIds(finding.evidenceIds)
    if (!evidenceIds) return undefined
    findings.push({ ...finding, evidenceIds })
  }
  return { ...value, findings, evidence }
}

/** Parses, binds and bounds one output, retaining only a closed stage category. */
export function parseAndBindStructuredResultOutcome<T extends StructuredRole>(
  value: unknown,
  role: T,
  index: ObservedEvidenceIndex,
): StructuredResultParseOutcome<T> {
  if (typeof value !== "string") return invalid("missing_final_output")
  if (Buffer.byteLength(value, "utf8") > MAX_EVIDENCE_BYTES) return invalid("result_too_large")
  let parsed: unknown
  try { parsed = JSON.parse(value) as unknown } catch (error: unknown) {
    return error instanceof SyntaxError ? invalid("result_shape_invalid") : invalid()
  }
  try {
    const prepareReceipt = role === "prepare" ? normalizeRegisteredPrepareReceipt(parsed, index) : undefined
    const validated = prepareReceipt?.result ?? validateRoleResult(parsed, role)
    const normalized = prepareReceipt?.result ?? normalizeStructuredResult(validated, index)
    if (!normalized) return invalid("evidence_binding_invalid")
    const rebound = validateRoleResult(normalized, role)
    const serialized = JSON.stringify(rebound)
    if (serialized === undefined) return invalid()
    if (Buffer.byteLength(serialized, "utf8") > MAX_EVIDENCE_BYTES && !prepareReceipt?.referenceBound) return invalid("result_too_large")
    return { kind: "valid", result: rebound }
  } catch (error: unknown) {
    return invalid(validationFailureCategory(error))
  }
}
