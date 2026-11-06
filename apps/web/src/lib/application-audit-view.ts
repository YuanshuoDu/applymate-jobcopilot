import type { StoredApplicationAudit } from './application-audit'

export type ApplicationAuditView =
  | { state: 'none' | 'pending' | 'failed' | 'stale' | 'unavailable'; record: null }
  | { state: 'complete'; record: StoredApplicationAudit }

/** Treat in-flight, invalid and malformed responses as non-passing states. */
export function parseApplicationAuditView(value: unknown): ApplicationAuditView {
  if (value === null) return { state: 'none', record: null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'unavailable', record: null }
  const row = value as Record<string, unknown>
  if (row.state === 'pending' || row.state === 'failed' || row.state === 'stale' || row.state === 'unavailable') return { state: row.state, record: null }
  const audit = row.audit
  if (typeof row.resumeId !== 'string' || !row.resumeId || !(row.coverLetterId === null || typeof row.coverLetterId === 'string')
    || !audit || typeof audit !== 'object' || Array.isArray(audit)) return { state: 'unavailable', record: null }
  const details = audit as Record<string, unknown>
  if (!['pass', 'needs_review', 'blocked'].includes(String(details.verdict)) || typeof details.auditedAt !== 'string'
    || !Number.isFinite(Date.parse(details.auditedAt)) || !Array.isArray(details.findings)) return { state: 'unavailable', record: null }
  return { state: 'complete', record: value as StoredApplicationAudit }
}
