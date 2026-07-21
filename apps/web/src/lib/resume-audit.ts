import type { ResumeContent } from '@/lib/types'

export type ResumeAuditSeverity = 'pass' | 'attention' | 'needs-confirmation'

export interface ResumeAuditFinding {
  id: string
  severity: ResumeAuditSeverity
  title: string
  detail: string
}

export interface ResumeAuditResult {
  findings: ResumeAuditFinding[]
  ready: boolean
}

const CLAIM_PATTERN = /\b\d+(?:[.,]\d+)?\s*(?:%|x|\+|users?|customers?|people|engineers?|projects?|teams?|hours?|days?|€|\$|£|k|m)\b/i
const HYPE_PATTERN = /\b(?:best|world[- ]class|industry[- ]leading|unmatched|guaranteed|revolutionary|expert)\b/i
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const URL_PATTERN = /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(?:\/\S*)?$/i

function resumeText(content: ResumeContent): string[] {
  return [
    content.summary,
    ...content.experience.flatMap(item => [item.company, item.role, item.period, ...(item.bullets ?? [])]),
    ...content.projects?.flatMap(item => [item.name, item.role ?? '', item.period ?? '', ...(item.bullets ?? [])]) ?? [],
    ...content.certifications?.flatMap(item => [item.name, item.issuer, item.date]) ?? [],
  ].filter(Boolean)
}

/**
 * Runs explainable, local checks. It intentionally never labels a claim as
 * false: only the candidate can verify whether a resume fact is true.
 */
export function auditResume(content: ResumeContent): ResumeAuditResult {
  const findings: ResumeAuditFinding[] = []
  const text = resumeText(content)
  const claims = text.filter(line => CLAIM_PATTERN.test(line))
  const hype = text.filter(line => HYPE_PATTERN.test(line))
  const normalizedSkills = (content.skills ?? []).map(skill => skill.trim().toLocaleLowerCase()).filter(Boolean)
  const duplicateSkills = [...new Set(normalizedSkills.filter((skill, index) => normalizedSkills.indexOf(skill) !== index))]

  if (claims.length > 0) findings.push({
    id: 'evidence', severity: 'needs-confirmation', title: 'Verify measurable claims',
    detail: `${claims.length} quantified claim${claims.length === 1 ? '' : 's'} found. Keep each only if you can explain its source, scope, and your personal contribution.`,
  })
  else findings.push({ id: 'evidence', severity: 'pass', title: 'Metrics requiring confirmation', detail: 'No quantified claims were detected.' })

  if (hype.length > 0) findings.push({
    id: 'hype', severity: 'attention', title: 'Replace absolute or inflated wording',
    detail: 'Use specific evidence instead of claims such as “expert”, “best”, or “industry-leading”.',
  })
  else findings.push({ id: 'hype', severity: 'pass', title: 'Professional wording', detail: 'No obvious inflated or absolute claims detected.' })

  const contact = content.contact ?? { name: '', email: '', location: '' }
  const badContact = !contact.name.trim() || !EMAIL_PATTERN.test(contact.email.trim()) ||
    [contact.linkedin, contact.github, contact.website].filter(Boolean).some(url => !URL_PATTERN.test(url!.trim()))
  findings.push(badContact
    ? { id: 'contact', severity: 'attention', title: 'Check contact details', detail: 'Use your real name and a valid email. Any LinkedIn, GitHub, or website link should be complete and reachable.' }
    : { id: 'contact', severity: 'pass', title: 'Contact details look usable', detail: 'Name, email, and optional profile links pass format checks.' })

  if ((content.experience ?? []).some(item => !item.company.trim() || !item.role.trim() || !item.period.trim())) findings.push({
    id: 'experience', severity: 'attention', title: 'Complete experience dates and roles',
    detail: 'Every experience entry should have a company, role, and accurate date range so recruiters can verify the timeline.',
  })
  else findings.push({ id: 'experience', severity: 'pass', title: 'Experience entries are complete', detail: 'Each experience entry includes company, role, and period.' })

  if (duplicateSkills.length > 0) findings.push({
    id: 'duplicates', severity: 'attention', title: 'Remove repeated skills',
    detail: `Repeated skill${duplicateSkills.length === 1 ? '' : 's'}: ${duplicateSkills.join(', ')}. Keep one clear entry for each.`,
  })
  else findings.push({ id: 'duplicates', severity: 'pass', title: 'Skills are not duplicated', detail: 'No repeated skill names were detected.' })

  return { findings, ready: !findings.some(finding => finding.severity === 'attention') }
}
