import { Buffer } from "node:buffer"

import { validateRoleResult, RoleResultValidationError, type ArtifactVersionReference, type RoleEvidence, type StructuredRole, type StructuredRoleResult } from "./role-results.js"
import type { ObservedEvidenceIndex } from "./child-evidence.js"

export const MAX_EVIDENCE_BYTES = 8 * 1024

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
  return ""
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
    const validated = validateRoleResult(parsed, role)
    const normalized = normalizeStructuredResult(validated, index)
    if (!normalized) return invalid("evidence_binding_invalid")
    const rebound = validateRoleResult(normalized, role)
    const serialized = JSON.stringify(rebound)
    if (serialized === undefined) return invalid()
    if (Buffer.byteLength(serialized, "utf8") > MAX_EVIDENCE_BYTES) return invalid("result_too_large")
    return { kind: "valid", result: rebound }
  } catch (error: unknown) {
    return invalid(validationFailureCategory(error))
  }
}
