import { auditMatchesCurrentMaterials } from './application-materials'
import type { StoredApplicationAudit } from './application-audit'
import type { CoverLetter, Job, Resume } from './types'

export type ApplicationExportSnapshot = { job: Job; resume: Resume; coverLetter: CoverLetter | null; audit: StoredApplicationAudit }

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function readJson(path: string): Promise<unknown> {
  const response = await fetch(path, { cache: 'no-store' })
  if (!response.ok) throw new Error('Application materials could not be loaded.')
  return response.json()
}

/** Read a candidate-owned audited set. The legacy timestamp fallback matches the UI predicate. */
export async function readApplicationExportSnapshot(jobId: string, userId: string): Promise<ApplicationExportSnapshot> {
  if (!jobId.trim() || !userId.trim()) throw new Error('Application materials could not be verified.')
  const root = `/api/jobs/${encodeURIComponent(jobId)}`
  const [rawJob, rawAudit] = await Promise.all([readJson(root), readJson(`${root}/audit-application`)])
  if (!object(rawJob) || rawJob.id !== jobId || rawJob.userId !== userId || typeof rawJob.finalResumeId !== 'string' || !rawJob.finalResumeId.trim()
    || !(rawJob.finalCoverLetterId === null || typeof rawJob.finalCoverLetterId === 'string' && !!rawJob.finalCoverLetterId.trim())
    || !object(rawAudit) || !object(rawAudit.audit) || rawAudit.audit.verdict !== 'pass' || typeof rawAudit.audit.auditedAt !== 'string') {
    throw new Error('Application materials could not be verified.')
  }
  const [rawResume, rawLetters] = await Promise.all([
    readJson(`/api/resume/${encodeURIComponent(rawJob.finalResumeId)}`),
    rawJob.finalCoverLetterId === null ? Promise.resolve(null) : readJson(`${root}/cover-letters`),
  ])
  if (!object(rawResume) || rawResume.id !== rawJob.finalResumeId || rawResume.userId !== userId
    || !object(rawResume.content) || typeof rawResume.updatedAt !== 'string') throw new Error('Application materials could not be verified.')
  let letter: CoverLetter | null = null
  if (rawJob.finalCoverLetterId !== null) {
    if (!Array.isArray(rawLetters)) throw new Error('Selected cover letter could not be loaded.')
    const matches = rawLetters.filter(value => object(value) && value.id === rawJob.finalCoverLetterId)
    if (matches.length !== 1 || !object(matches[0]) || matches[0].userId !== userId || matches[0].jobId !== jobId
      || typeof matches[0].updatedAt !== 'string' || typeof matches[0].content !== 'string') throw new Error('Selected cover letter could not be loaded.')
    letter = matches[0] as unknown as CoverLetter
  }
  const audit = rawAudit as unknown as StoredApplicationAudit
  if (!auditMatchesCurrentMaterials(audit, rawJob.finalResumeId, rawJob.finalCoverLetterId as string | null,
    rawResume.updatedAt, letter?.updatedAt ?? null, false)) throw new Error('Application materials changed. Check them again before downloading.')
  return { job: rawJob as unknown as Job, resume: rawResume as unknown as Resume, coverLetter: letter, audit }
}

/** Compare actual rendered bytes' inputs, bindings and audit; tolerate JSON object key ordering. */
export function sameApplicationExportSnapshot(a: ApplicationExportSnapshot, b: ApplicationExportSnapshot): boolean {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    return value
  }
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}
