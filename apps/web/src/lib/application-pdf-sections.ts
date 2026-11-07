import type { ResumeContent } from './types'

const DEFAULT_ORDER = ['summary', 'experience', 'projects', 'skills', 'certifications', 'education', 'languages']

/** Mirror the preview: explicit order hides omitted built-in sections; custom sections are appended. */
export function applicationPdfSectionOrder(content: ResumeContent): string[] {
  const base = content.sectionOrder ?? DEFAULT_ORDER
  return [...base, ...(content.custom ?? []).map(section => section.id).filter(id => !base.includes(id))]
}
