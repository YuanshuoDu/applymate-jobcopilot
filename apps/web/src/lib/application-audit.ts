import type { ApplicationAudit, ApplicationAuditFinding, ApplicationAuditTarget } from '@/lib/types'

export const AUDIT_ACTIVITY_PREFIX = '[Auditor] application-audit '

export type StoredApplicationAudit = {
  resumeId: string
  coverLetterId: string | null
  resumeUpdatedAt?: string
  coverLetterUpdatedAt?: string
  audit: ApplicationAudit
}

const TARGETS = new Set<ApplicationAuditTarget>([
  'contact', 'summary', 'skills', 'experience', 'education', 'languages', 'projects', 'certifications', 'cover_letter',
])

export function isApplicationAuditTarget(value: unknown): value is ApplicationAuditTarget {
  return typeof value === 'string' && TARGETS.has(value as ApplicationAuditTarget)
}

/** Keep older audit records actionable while new audits return an exact target. */
export function targetForAuditFinding(finding: ApplicationAuditFinding): ApplicationAuditTarget | undefined {
  if (finding.area === 'cover_letter') return 'cover_letter'
  if (finding.area === 'job_match') return undefined
  if (finding.target && finding.target !== 'cover_letter') return finding.target

  const text = `${finding.title} ${finding.evidence} ${finding.action}`.toLowerCase()
  if (/(email|phone|location|linkedin|github|website|contact details|full name)/.test(text)) return 'contact'
  if (/(skill|technology|tooling|platform|framework)/.test(text)) return 'skills'
  if (/(experience|employer|employment|company|role|title|date|duration|job history)/.test(text)) return 'experience'
  if (/(education|degree|university|college|qualification)/.test(text)) return 'education'
  if (/(language|fluent|proficiency)/.test(text)) return 'languages'
  if (/(project|portfolio|repository)/.test(text)) return 'projects'
  if (/(certification|certificate|credential)/.test(text)) return 'certifications'
  return 'summary'
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, max = 2_000) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

function textArray(value: unknown, maxItems = 50) {
  if (!Array.isArray(value)) return null
  const values = value.map(item => text(item)).filter((item): item is string => Boolean(item)).slice(0, maxItems)
  return values.length === value.length ? values : null
}

function objectArray(value: unknown, fields: string[], maxItems = 30) {
  if (!Array.isArray(value)) return null
  const values: Array<Record<string, unknown>> = []
  for (const item of value.slice(0, maxItems)) {
    if (!record(item)) return null
    const next: Record<string, unknown> = {}
    for (const field of fields) {
      if (item[field] === undefined) continue
      if (field === 'bullets') {
        const bullets = textArray(item[field], 20)
        if (!bullets) return null
        next[field] = bullets
      } else {
        const valueText = text(item[field])
        if (valueText) next[field] = valueText
      }
    }
    if (Object.keys(next).length === 0) return null
    values.push(next)
  }
  return values.length === value.length ? values : null
}

function requiredObjectArray(value: unknown, fields: string[], required: string[]) {
  const values = objectArray(value, fields)
  if (!values || values.some(item => required.some(field => !item[field]))) return null
  return values
}

/** Validate AI-generated replacements before they can reach a persisted resume. */
export function sanitizeProposedValue(target: ApplicationAuditTarget, value: unknown): unknown | null {
  if (target === 'summary' || target === 'cover_letter') return text(value, 12_000)
  if (target === 'skills') return textArray(value)
  if (target === 'languages') return requiredObjectArray(value, ['lang', 'level'], ['lang', 'level'])
  if (target === 'experience') return requiredObjectArray(value, ['company', 'role', 'period', 'bullets'], ['company', 'role', 'period', 'bullets'])
  if (target === 'education') return requiredObjectArray(value, ['institution', 'degree', 'year'], ['institution', 'degree', 'year'])
  if (target === 'projects') return requiredObjectArray(value, ['name', 'role', 'period', 'url', 'bullets'], ['name', 'bullets'])
  if (target === 'certifications') return requiredObjectArray(value, ['name', 'issuer', 'date', 'url'], ['name', 'issuer', 'date'])
  if (target === 'contact' && record(value)) {
    const next: Record<string, string> = {}
    for (const field of ['name', 'email', 'location', 'linkedin', 'github', 'website', 'phone']) {
      const valueText = text(value[field], 500)
      if (valueText) next[field] = valueText
    }
    return Object.keys(next).length ? next : null
  }
  return null
}

export function auditActivityText(
  resumeId: string,
  coverLetterId: string | null,
  audit: ApplicationAudit,
  versions: Pick<StoredApplicationAudit, 'resumeUpdatedAt' | 'coverLetterUpdatedAt'> = {},
) {
  return `${AUDIT_ACTIVITY_PREFIX}${JSON.stringify({ resumeId, coverLetterId, ...versions, audit })}`
}

export function parseStoredApplicationAudit(textValue: string): StoredApplicationAudit | null {
  if (!textValue.startsWith(AUDIT_ACTIVITY_PREFIX)) return null
  try {
    const stored = JSON.parse(textValue.slice(AUDIT_ACTIVITY_PREFIX.length)) as StoredApplicationAudit
    if (!stored.resumeId || stored.coverLetterId === undefined || !stored.audit?.verdict || !Array.isArray(stored.audit.findings)) return null
    return stored
  } catch {
    return null
  }
}
