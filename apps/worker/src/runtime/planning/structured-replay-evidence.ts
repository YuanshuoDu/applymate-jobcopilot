import { Buffer } from "node:buffer"

import { validateRoleResult } from "../subagents/role-results.js"

const MAX_STRUCTURED_RESULT_BYTES = 8 * 1024
const MAX_EVIDENCE_FIELD_LENGTH = 256

function boundedNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(value.length) && value.length <= MAX_EVIDENCE_FIELD_LENGTH
}

export function validateBoundStructuredEvidence(value: unknown): boolean {
  try {
    const result = validateRoleResult(value)
    const seen = new Set<string>()
    for (const evidence of result.evidence) {
      if (evidence.kind !== "job" && evidence.kind !== "persona" && evidence.kind !== "resume") return false
      if (!boundedNonEmptyString(evidence.id) || !boundedNonEmptyString(evidence.ref) || !boundedNonEmptyString(evidence.source)) return false
      if (evidence.id !== `read:${evidence.kind}:${evidence.ref}` || seen.has(evidence.id)) return false
      seen.add(evidence.id)
    }
    const encoded = JSON.stringify(result)
    return encoded !== undefined && Buffer.byteLength(encoded, "utf8") <= MAX_STRUCTURED_RESULT_BYTES
  } catch {
    return false
  }
}
