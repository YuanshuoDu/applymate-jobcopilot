import { isApplicationPdfUnsupportedCharactersError } from '@/lib/application-pdf-errors'
// apps/web/src/lib/bundle.ts
// M9: Client-side ZIP bundle download — resume + cover letter + meta.json
import type { Resume, CoverLetter, Job } from '@/lib/types'
import { readApplicationExportSnapshot, sameApplicationExportSnapshot, type ApplicationExportSnapshot } from './application-export-snapshot'

export class BundleError extends Error {}

export type LocalApplicationPack = { folderPath: string; opened: boolean; resumeFile?: string; coverLetterFile?: string }

/** Creates the audited PDFs on the desktop host, rather than a browser ZIP. */
export async function exportApplicationPackLocally(jobId: string, openFolder = false): Promise<LocalApplicationPack> {
  const response = await fetch(`/api/jobs/${jobId}/export-local`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ openFolder, openOnly: openFolder }),
  })
  const data = await response.json().catch(() => ({})) as Partial<LocalApplicationPack> & { error?: string }
  if (!response.ok || !data.folderPath) throw new BundleError(data.error ?? 'Could not create the local application pack')
  return { folderPath: data.folderPath, opened: Boolean(data.opened) }
}

function safe(s: string): string {
  const name = s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim().slice(0, 80)
  // Dot-only ZIP path components can escape the destination on extraction.
  return name && !/^[.\s]+$/.test(name) ? name : 'Untitled'
}

function buildMeta(job: Job, resume: Resume, coverLetter: CoverLetter | null): object {
  return {
    exportedAt:  new Date().toISOString(),
    exportedBy:  'ApplyMate v1',
    appliedAt:   job.appliedAt ?? null,
    company:     job.company,
    role:        job.role,
    jobUrl:      job.url ?? null,
    direction:   null,
    resume:      { id: resume.id, name: resume.name, templateId: resume.templateId, updatedAt: resume.updatedAt },
    coverLetter: coverLetter ? { id: coverLetter.id, tone: coverLetter.tone, createdAt: coverLetter.createdAt } : null,
  }
}

/** Capture and check the selected audited documents before saving to the browser. */
export async function downloadAuditedApplicationBundle(jobId: string, userId: string, isCurrent: () => boolean): Promise<void> {
  if (!isCurrent()) throw new BundleError('Application session changed. Please try again.')
  const snapshot = await readApplicationExportSnapshot(jobId, userId)
  if (!isCurrent()) throw new BundleError('Application session changed. Please try again.')
  const { blob, filename, save } = await renderJobBundle(snapshot)
  if (!isCurrent()) throw new BundleError('Application session changed. Please try again.')
  const latest = await readApplicationExportSnapshot(jobId, userId)
  if (!isCurrent() || !sameApplicationExportSnapshot(snapshot, latest)) throw new BundleError('Application materials changed. Check them again before downloading.')
  save(blob, filename)
}

async function renderJobBundle({ job, resume, coverLetter }: ApplicationExportSnapshot): Promise<{ blob: Blob; filename: string; save: (blob: Blob, filename: string) => void }> {
  // 4. Lazy-load heavy deps
  const [{ pdf }, { default: JSZip }, { default: saveAs }] = await Promise.all([
    import('@react-pdf/renderer'),
    import('jszip'),
    import('file-saver'),
  ])

  // 5. Render Resume PDF
  const { renderResumeDoc } = await import('@/lib/resume-pdf')
  let resumeBlob: Blob
  try {
    const ResumeDoc = await renderResumeDoc(resume)
    resumeBlob = await pdf(ResumeDoc as never).toBlob()
  } catch (e) {
    if (isApplicationPdfUnsupportedCharactersError(e)) throw e
    throw new BundleError(`Couldn't render Resume PDF — open the editor and save again (${(e as Error).message ?? 'unknown error'})`)
  }

  // 6. Render CoverLetter PDF (if any)
  let coverBlob: Blob | null = null
  if (coverLetter) {
    try {
      const { renderCoverLetterDoc } = await import('@/lib/cover-letter-pdf')
      const applicant = {
        name:     (resume.content as { contact?: { name?: string } }).contact?.name ?? '',
        email:    (resume.content as { contact?: { email?: string } }).contact?.email,
        phone:    (resume.content as { contact?: { phone?: string } }).contact?.phone,
        location: (resume.content as { contact?: { location?: string } }).contact?.location,
        linkedin: (resume.content as { contact?: { linkedin?: string } }).contact?.linkedin,
      }
      const CLDoc = await renderCoverLetterDoc(
        coverLetter.content,
        resume.templateId,
        resume.templateOptions,
        applicant,
        { company: job.company, role: job.role },
      )
      coverBlob = await pdf(CLDoc as never).toBlob()
    } catch (e) {
      if (isApplicationPdfUnsupportedCharactersError(e)) throw e
      throw new BundleError(`Couldn't render CoverLetter PDF — open the editor and save again (${(e as Error).message ?? 'unknown error'})`)
    }
  }

  // 7. Build ZIP
  const zip    = new JSZip()
  const folder = zip.folder(`${safe(job.company)}/${safe(job.role)}`)!
  folder.file('Resume.pdf', resumeBlob)
  if (coverBlob) folder.file('CoverLetter.pdf', coverBlob)
  folder.file('meta.json', JSON.stringify(buildMeta(job, resume, coverLetter), null, 2))

  // 8. Save
  const dateStr = new Date().toISOString().slice(0, 10)
  const blob    = await zip.generateAsync({ type: 'blob' })
  return { blob, filename: `${safe(job.company)}_${safe(job.role)}_${dateStr}.zip`, save: saveAs }
}
