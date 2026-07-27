import { db } from '@/lib/db'
import type { ResumeContent } from '@/lib/types'

export interface PersonaField {
  key: string
  category: string
  label: string
  value: string
  confidence: number
  source: string
  updatedAt: string
  consentAt?: string
}

export const PERSONA_CATEGORIES = ['personal', 'work', 'contact', 'education', 'preferences'] as const
export type PersonaCategory = typeof PERSONA_CATEGORIES[number]

export interface PersonaProfile {
  identity: string[]
  preferences: string[]
  summaries: string[]
  experience: string[]
  skills: string[]
  languages: string[]
  education: string[]
  certifications: string[]
  projects: string[]
  applicationAnswers: PersonaField[]
  sourceResumeCount: number
  updatedAt: string | null
}

const SENSITIVE_FIELD = /(?:gender|sex|pronoun|birth|date[_ ]?of[_ ]?birth|age|race|ethnic|religion|faith|politic|union|health|medical|disab|veteran|criminal|passport|national[_ ]?id)/i
const UNNECESSARY_IDENTIFIER = /(?:bank|iban|swift|bic|tax|social[_ ]?security|ssn|national[_ ]?insurance)/i

export function validatePersonaField(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'Each persona field must be an object.'
  const field = value as Partial<PersonaField>
  if (!field.key || !/^[a-z0-9_]{1,80}$/i.test(field.key)) return 'Persona field key must use letters, numbers, or underscores.'
  if (!field.label || typeof field.label !== 'string' || field.label.length > 120) return 'Persona field label is required and must be 120 characters or fewer.'
  if (!field.value || typeof field.value !== 'string' || field.value.length > 2_000) return 'Persona field value is required and must be 2,000 characters or fewer.'
  if (!PERSONA_CATEGORIES.includes(field.category as PersonaCategory)) return 'Persona field category is invalid.'
  if (SENSITIVE_FIELD.test(`${field.key} ${field.label}`)) return 'Sensitive personal data is not stored in Persona.'
  if (UNNECESSARY_IDENTIFIER.test(`${field.key} ${field.label}`)) return 'Financial and government identifiers are not stored in Persona.'
  return null
}

function unique(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map(value => value?.trim()).filter((value): value is string => Boolean(value)))]
}

function labeled(label: string, value?: string | null): string | undefined {
  return value?.trim() ? `${label}: ${value.trim()}` : undefined
}

function factsFromResume(content: ResumeContent) {
  return {
    identity: [labeled('NAME', content.contact.name), labeled('EMAIL', content.contact.email), labeled('PHONE', content.contact.phone), labeled('LOCATION', content.contact.location), labeled('LINKEDIN', content.contact.linkedin), labeled('GITHUB', content.contact.github), labeled('WEBSITE', content.contact.website)],
    summaries: [content.summary],
    experience: content.experience.flatMap(item => [`${item.role} · ${item.company}${item.period ? ` (${item.period})` : ''}`, ...item.bullets.map(bullet => `↳ ${bullet}`)]),
    skills: content.skills,
    languages: (content.languages ?? []).map(item => `${item.lang} · ${item.level}`),
    education: content.education.map(item => `${item.degree} · ${item.institution}${item.year ? ` (${item.year})` : ''}`),
    certifications: (content.certifications ?? []).map(item => `${item.name} · ${item.issuer}${item.date ? ` (${item.date})` : ''}`),
    projects: (content.projects ?? []).flatMap(item => [`${item.name}${item.role ? ` · ${item.role}` : ''}${item.period ? ` (${item.period})` : ''}`, ...item.bullets.map(bullet => `↳ ${bullet}`)]),
  }
}

/**
 * Persona's factual base intentionally uses every original/base resume, never
 * AI-adapted copies. This prevents a previous tailoring hallucination from
 * becoming evidence for later applications.
 */
export async function getPersonaProfile(userId: string): Promise<PersonaProfile> {
  const [user, resumes] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { name: true, email: true, phone: true, location: true, linkedin: true, github: true, preferences: true, personaFields: true } }),
    db.resume.findMany({ where: { userId, kind: 'base' }, select: { content: true, updatedAt: true } }),
  ])
  if (!user) throw new Error('User not found')

  const resumeFacts = resumes.map(resume => factsFromResume(resume.content as unknown as ResumeContent))
  const preferences = user.preferences as Record<string, unknown> | null
  const answers = ((user.personaFields ?? []) as unknown as PersonaField[]).filter(field => !validatePersonaField(field))
  const latest = resumes.reduce<Date | null>((value, resume) => !value || resume.updatedAt > value ? resume.updatedAt : value, null)

  return {
    identity: unique([labeled('NAME', user.name), labeled('EMAIL', user.email), labeled('PHONE', user.phone), labeled('LOCATION', user.location), labeled('LINKEDIN', user.linkedin), labeled('GITHUB', user.github), ...resumeFacts.flatMap(fact => fact.identity)]),
    preferences: unique([preferences?.targetRoles as string | undefined, preferences?.targetLocations as string | undefined, preferences?.salaryExpectation as string | undefined, preferences?.workAuthorization as string | undefined, preferences?.openToRelocation === true ? 'Open to relocation' : undefined]),
    summaries: unique(resumeFacts.flatMap(fact => fact.summaries)),
    experience: unique(resumeFacts.flatMap(fact => fact.experience)), skills: unique(resumeFacts.flatMap(fact => fact.skills)), languages: unique(resumeFacts.flatMap(fact => fact.languages)),
    education: unique(resumeFacts.flatMap(fact => fact.education)), certifications: unique(resumeFacts.flatMap(fact => fact.certifications)), projects: unique(resumeFacts.flatMap(fact => fact.projects)),
    applicationAnswers: answers, sourceResumeCount: resumes.length, updatedAt: latest?.toISOString() ?? null,
  }
}

export function personaContext(profile: PersonaProfile): string {
  const sections: Array<[string, string[]]> = [
    ['JOB PREFERENCES', profile.preferences], ['SUMMARIES', profile.summaries], ['EXPERIENCE', profile.experience], ['LANGUAGES', profile.languages], ['EDUCATION', profile.education], ['CERTIFICATIONS', profile.certifications], ['PROJECTS', profile.projects],
    ['CONFIRMED APPLICATION ANSWERS', profile.applicationAnswers.map(field => `[${field.category}] ${field.label}: ${field.value}`)],
  ]
  return [
    ...profile.identity,
    profile.skills.length ? `SKILLS: ${profile.skills.join(', ')}` : '',
    ...sections.filter(([, values]) => values.length > 0).map(([title, values]) => `${title}:\n${values.map(value => `- ${value}`).join('\n')}`),
  ].filter(Boolean).join('\n\n')
}

export async function buildPersona(userId: string): Promise<string> {
  return personaContext(await getPersonaProfile(userId))
}
