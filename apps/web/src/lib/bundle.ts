// apps/web/src/lib/bundle.ts
// M9: Client-side ZIP bundle download — resume + cover letter + meta.json
import type { Resume, CoverLetter, Job } from '@/lib/types'

export class BundleError extends Error {}

function safe(s: string): string {
  return (s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim().slice(0, 80)) || 'Untitled'
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

export async function downloadJobBundle(jobId: string): Promise<void> {
  // 1. Fetch job with final assets
  const jobRes = await fetch(`/api/jobs/${jobId}`)
  if (!jobRes.ok) throw new BundleError('Could not load job')
  const job: Job = await jobRes.json()

  if (!job.finalResumeId) throw new BundleError('No final resume selected')

  // 2. Fetch final resume
  const resumeRes = await fetch(`/api/resume/${job.finalResumeId}`)
  if (!resumeRes.ok) throw new BundleError('Could not load resume')
  const resume: Resume = await resumeRes.json()

  // 3. Fetch final cover letter (if any)
  let coverLetter: CoverLetter | null = null
  if (job.finalCoverLetterId) {
    try {
      const clRes = await fetch(`/api/jobs/${jobId}/cover-letters`)
      if (!clRes.ok) {
        console.warn('[bundle] Could not fetch cover letters:', clRes.status)
      } else {
        const cls: CoverLetter[] = await clRes.json()
        coverLetter = cls.find(c => c.id === job.finalCoverLetterId) ?? null
      }
    } catch (e) {
      console.warn('[bundle] Network error fetching cover letters:', e)
    }
  }

  // 4. Lazy-load heavy deps
  const [{ pdf }, { default: JSZip }, { saveAs }] = await Promise.all([
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
  saveAs(blob, `${safe(job.company)}_${safe(job.role)}_${dateStr}.zip`)
}
