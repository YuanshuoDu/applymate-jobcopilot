/**
 * Tailor a resume's skills section to include missing JD keywords.
 * Improves ATS keyword matching without altering other resume content.
 */
import type { ResumeContent } from './resume-pdf.js'

/**
 * Inject missing JD keywords into the resume skills section.
 * Only adds keywords not already mentioned anywhere in the resume.
 * Returns a modified copy — never mutates the original.
 *
 * @param content   Base resume content
 * @param keywords  Comma-separated ATS keywords from Job.keywords
 */
export function tailorResumeKeywords(
  content: ResumeContent,
  keywords: string,
): ResumeContent {
  if (!keywords.trim()) return content

  const kwList = keywords
    .split(',')
    .map(k => k.trim())
    .filter(Boolean)

  if (!kwList.length) return content

  // Build a searchable string from entire resume for dedup
  const resumeText = JSON.stringify(content).toLowerCase()

  const missing = kwList.filter(k => !resumeText.includes(k.toLowerCase()))
  if (!missing.length) return content

  const existingSkills = content.skills ?? []
  const newSkills = [
    ...existingSkills,
    ...missing.map(k => ({ name: k })),
  ]

  return { ...content, skills: newSkills }
}
