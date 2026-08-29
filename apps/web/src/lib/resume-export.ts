import type { Resume } from '@/lib/types'

function safeFilename(value: string) {
  return (value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim().slice(0, 80) || 'Resume') + '.pdf'
}

export function resumePdfFilename(name: string, applicantName?: string) {
  const cleanName = name.replace(/^tailored\s+for\s+/i, '').trim()
  const cleanApplicant = applicantName?.trim() ?? ''
  const filenameBase = !cleanName
    ? cleanApplicant
    : cleanApplicant && !cleanName.toLowerCase().startsWith(cleanApplicant.toLowerCase())
      ? `${cleanApplicant} - ${cleanName}`
      : cleanName
  return safeFilename(filenameBase)
}

export async function downloadResumePdf(resume: Resume): Promise<void> {
  const [{ pdf }, { renderResumeDoc }, { saveAs }] = await Promise.all([
    import('@react-pdf/renderer'),
    import('@/lib/resume-pdf'),
    import('file-saver'),
  ])
  const document = await renderResumeDoc(resume)
  const blob = await pdf(document as never).toBlob()
  saveAs(blob, resumePdfFilename(resume.name, resume.content.contact?.name))
}
