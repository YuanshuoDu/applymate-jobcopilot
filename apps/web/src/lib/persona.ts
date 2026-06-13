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
