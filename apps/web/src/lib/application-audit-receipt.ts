// Server-only: import this module from route handlers, never from client audit UI.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { getAuthJwtSecret } from '@/lib/auth-secret'
import { auditActivityText, type StoredApplicationAudit } from '@/lib/application-audit'
import type { ApplicationAudit } from '@/lib/types'

type Scope = { userId: string; jobId: string }
type Versions = Pick<StoredApplicationAudit, 'resumeUpdatedAt' | 'coverLetterUpdatedAt'>

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
  }
  return value
}

function signature(scope: Scope, stored: StoredApplicationAudit): string {
  // Domain separation prevents a receipt being confused with any other use of
  // the auth secret. Sign the complete result, not only its pass/fail verdict.
  const payload = canonical({
    purpose: 'applymate.application-audit', version: 1,
    userId: scope.userId, jobId: scope.jobId,
    resumeId: stored.resumeId, coverLetterId: stored.coverLetterId,
    resumeUpdatedAt: stored.resumeUpdatedAt ?? null,
    coverLetterUpdatedAt: stored.coverLetterUpdatedAt ?? null,
    audit: stored.audit,
  })
  return createHmac('sha256', getAuthJwtSecret()).update(JSON.stringify(payload)).digest('hex')
}

/** Only independent server audit writers can mint a downloadable audit record. */
export function signedAuditActivityText(
  scope: Scope,
  resumeId: string,
  coverLetterId: string | null,
  audit: ApplicationAudit,
  versions: Versions = {},
): string {
  const stored: StoredApplicationAudit = { resumeId, coverLetterId, audit, ...versions }
  const receipt = { version: 1 as const, signature: signature(scope, stored) }
  return auditActivityText(resumeId, coverLetterId, audit, { ...versions, receipt })
}

/** Legacy, forged, or altered activity records must be audited again. */
export function verifyApplicationAuditReceipt(scope: Scope, stored: StoredApplicationAudit | null): stored is StoredApplicationAudit {
  if (!stored || stored.receipt?.version !== 1 || !/^[a-f0-9]{64}$/.test(stored.receipt.signature)) return false
  try {
    return timingSafeEqual(Buffer.from(stored.receipt.signature, 'hex'), Buffer.from(signature(scope, stored), 'hex'))
  } catch {
    return false
  }
}
