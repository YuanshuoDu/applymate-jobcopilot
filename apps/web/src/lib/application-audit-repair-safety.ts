import { isDeepStrictEqual } from 'node:util'
import { sanitizeProposedValue } from './application-audit'
import type { ApplicationAuditTarget } from './types'

/** Reject replacements that validation would truncate, trim, or drop fields from. */
export function sanitizeLosslessProposedValue(target: ApplicationAuditTarget, value: unknown): unknown | null {
  try {
    const sanitized = sanitizeProposedValue(target, value)
    return sanitized !== null && isDeepStrictEqual(sanitized, value) ? sanitized : null
  } catch {
    return null
  }
}
