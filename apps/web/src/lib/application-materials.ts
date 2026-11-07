import type { StoredApplicationAudit } from './application-audit'

/** Presentation only. Submission authorization is always owned by the Agent. */
export function auditMatchesCurrentMaterials(
  record: StoredApplicationAudit | null,
  resumeId: string | null,
  coverLetterId: string | null,
  resumeUpdatedAt: string | null,
  coverLetterUpdatedAt: string | null,
  dirty: boolean,
): boolean {
  if (dirty || !record || !resumeId || record.resumeId !== resumeId || record.coverLetterId !== coverLetterId) return false
  const auditedAt = Date.parse(record.audit.auditedAt)
  const resumeAt = resumeUpdatedAt ? Date.parse(resumeUpdatedAt) : NaN
  if (!Number.isFinite(auditedAt) || !Number.isFinite(resumeAt)) return false
  if (record.resumeUpdatedAt ? record.resumeUpdatedAt !== resumeUpdatedAt : auditedAt < resumeAt) return false
  if (coverLetterId) {
    const letterAt = coverLetterUpdatedAt ? Date.parse(coverLetterUpdatedAt) : NaN
    if (!Number.isFinite(letterAt)) return false
    if (record.coverLetterUpdatedAt ? record.coverLetterUpdatedAt !== coverLetterUpdatedAt : auditedAt < letterAt) return false
  }
  return true
}
