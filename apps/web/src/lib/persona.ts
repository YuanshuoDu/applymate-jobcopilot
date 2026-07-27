import { db } from '@/lib/db'
import type { ResumeContent } from '@/lib/types'

export interface PersonaField {
  key:        string
  category:   string  // "personal" | "work" | "contact" | "education" | "preferences"
  label:      string
  value:      string
  confidence: number
  source:     string  // "resume" | "ai_derived" | "manual" | "form_scan"
  updatedAt:  string
  consentAt?: string  // explicit user confirmation before saving an application answer
}

export const PERSONA_CATEGORIES = ['personal', 'work', 'contact', 'education', 'preferences'] as const
export type PersonaCategory = typeof PERSONA_CATEGORIES[number]

// Special-category data is not needed to tailor a job application. Keeping it
// out of the profile is the safest default under GDPR's data-minimisation rule.
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

export async function buildPersona(userId: string): Promise<string> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      name: true, email: true, phone: true, location: true,
      linkedin: true, github: true, preferences: true,
      personaFields: true,
    },
  })

  if (!user) throw new Error('User not found')

  const resume = await db.resume.findFirst({
    where: { userId, isDefault: true },
    select: { content: true },
  })

  const lines: string[] = []
  const personaFields = (user.personaFields ?? []) as unknown as PersonaField[]

  // Contact
  lines.push(`NAME: ${user.name || 'N/A'}`)
  lines.push(`EMAIL: ${user.email}`)
  if (user.phone) lines.push(`PHONE: ${user.phone}`)
  if (user.location) lines.push(`LOCATION: ${user.location}`)
  if (user.linkedin) lines.push(`LINKEDIN: ${user.linkedin}`)
  if (user.github) lines.push(`GITHUB: ${user.github}`)

  // Preferences (skip fields already covered by personaFields)
  const prefs = user.preferences as Record<string, unknown> | null
  if (prefs) {
    lines.push('')
    lines.push('PREFERENCES:')
    if (prefs.targetRoles) lines.push(`Target Roles: ${prefs.targetRoles}`)
    if (prefs.targetLocations) lines.push(`Target Locations: ${prefs.targetLocations}`)
    if (prefs.salaryExpectation) lines.push(`Salary Expectation: ${prefs.salaryExpectation}`)
    if (prefs.workAuthorization) lines.push(`Work Authorization: ${prefs.workAuthorization}`)
    if (prefs.openToRelocation !== undefined) lines.push(`Open to Relocation: ${prefs.openToRelocation ? 'Yes' : 'No'}`)
  }

  // Persona Fields (learned from previous form fills — deduplicated vs preferences)
  if (personaFields.length > 0) {
    const prefKeys = new Set(['salaryExpectation', 'workAuthorization', 'openToRelocation'])
    const newFields = personaFields.filter(f => !prefKeys.has(f.key))
    if (newFields.length > 0) {
      lines.push('')
      lines.push('KNOWN ANSWERS (from previous applications):')
      for (const f of newFields) {
        lines.push(`- [${f.category}] ${f.label}: ${f.value}`)
      }
    }
  }

  // Resume
  if (resume?.content) {
    const r = resume.content as unknown as ResumeContent
    lines.push('')
    lines.push('RESUME:')
    if (r.summary) lines.push(`SUMMARY: ${r.summary}`)
    if (r.skills?.length) lines.push(`SKILLS: ${r.skills.join(', ')}`)
    if (r.experience?.length) {
      lines.push('EXPERIENCE:')
      for (const e of r.experience) {
        lines.push(`- ${e.role} at ${e.company} (${e.period})`)
        for (const b of (e.bullets ?? [])) lines.push(`  • ${b}`)
      }
    }
    if (r.education?.length) {
      lines.push('EDUCATION:')
      for (const e of r.education) lines.push(`- ${e.degree} — ${e.institution} (${e.year})`)
    }
    if (r.languages?.length) {
      lines.push('LANGUAGES:')
      for (const l of r.languages) lines.push(`- ${l.lang}: ${l.level}`)
    }
    if (r.projects?.length) {
      lines.push('PROJECTS:')
      for (const p of r.projects) {
        lines.push(`- ${p.name}${p.role ? ` / ${p.role}` : ''}${p.period ? ` (${p.period})` : ''}`)
        for (const b of p.bullets ?? []) lines.push(`  • ${b}`)
      }
    }
    if (r.certifications?.length) {
      lines.push('CERTIFICATIONS:')
      for (const c of r.certifications) lines.push(`- ${c.name} — ${c.issuer} (${c.date})`)
    }
  }

  return lines.join('\n')
}
