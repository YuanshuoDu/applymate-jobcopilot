import type { StoredApplicationAudit } from './application-audit'
import type { CoverLetter, Job, Resume } from './types'

type PackJob = Pick<Job, 'id' | 'company' | 'role' | 'url'>

export { hasCurrentApplicationPackAudit } from './application-audit'

function safeName(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim().replace(/\s+/g, ' ').slice(0, 70) || 'Untitled'
}

/** Render the already-authorized snapshot in memory; no host filesystem or browser is needed. */
export async function renderApplicationPack(
  job: PackJob,
  resume: Resume,
  coverLetter: CoverLetter | null,
  audit: StoredApplicationAudit,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; filename: string }> {
  const [{ renderToBuffer }, { default: JSZip }, { renderResumeDoc }, { renderCoverLetterDoc }] = await Promise.all([
    import('@react-pdf/renderer'), import('jszip'), import('./resume-pdf'), import('./cover-letter-pdf'),
  ])
  const resumeDocument = await renderResumeDoc(resume)
  const resumePdf = await renderToBuffer(resumeDocument as Parameters<typeof renderToBuffer>[0])
  const zip = new JSZip()
  zip.file('Resume.pdf', resumePdf)
  if (coverLetter) {
    const contact = resume.content.contact
    const document = await renderCoverLetterDoc(
      coverLetter.content, resume.templateId, resume.templateOptions,
      { ...contact, name: contact?.name || resume.name },
      { company: job.company, role: job.role },
    )
    zip.file('CoverLetter.pdf', await renderToBuffer(document as Parameters<typeof renderToBuffer>[0]))
  }
  zip.file('meta.json', JSON.stringify({
    exportedAt: new Date().toISOString(),
    job: { id: job.id, company: job.company, role: job.role, url: job.url },
    resume: { id: resume.id, updatedAt: resume.updatedAt },
    coverLetter: coverLetter ? { id: coverLetter.id, updatedAt: coverLetter.updatedAt } : null,
    audit: { verdict: audit.audit.verdict, auditedAt: audit.audit.auditedAt },
  }, null, 2))
  return {
    bytes: new Uint8Array(await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })),
    filename: `${safeName(job.company)}_${safeName(job.role)}_application-pack.zip`,
  }
}
