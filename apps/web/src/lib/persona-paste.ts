import type { PersonaField } from '@/lib/persona'
import type { ResumeContent } from '@/lib/types'

const MAX_VALUE_LENGTH = 2_000

function clean(value: unknown, max = MAX_VALUE_LENGTH) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : ''
}

function field(key: string, label: string, value: string, category: PersonaField['category'], updatedAt: string): PersonaField | null {
  const safeValue = clean(value)
  if (!safeValue) return null
  return { key, label: clean(label, 120), value: safeValue, category, confidence: 0.85, source: 'manual', updatedAt }
}

/** Convert parsed text into a reviewable, non-contact Persona draft. */
export function personaFieldsFromResumeContent(content: ResumeContent, updatedAt = new Date().toISOString()): PersonaField[] {
  const fields: Array<PersonaField | null> = []
  fields.push(field('pasted_summary', 'Professional summary', content.summary, 'work', updatedAt))
  fields.push(field('pasted_skills', 'Skills', content.skills.join(', '), 'work', updatedAt))
  for (const [index, item] of content.experience.entries()) {
    fields.push(field(
      `pasted_experience_${index}`,
      `${clean(item.role, 80) || 'Experience'} · ${clean(item.company, 80) || 'Company'}`,
      [item.period, ...item.bullets].filter(Boolean).join('\n'),
      'work', updatedAt,
    ))
  }
  for (const [index, item] of content.education.entries()) {
    fields.push(field(
      `pasted_education_${index}`,
      `${clean(item.degree, 100) || 'Education'} · ${clean(item.institution, 100) || 'Institution'}`,
      item.year,
      'education', updatedAt,
    ))
  }
  for (const [index, item] of (content.languages ?? []).entries()) {
    fields.push(field(`pasted_language_${index}`, clean(item.lang, 100) || 'Language', item.level, 'work', updatedAt))
  }
  for (const [index, item] of (content.certifications ?? []).entries()) {
    fields.push(field(
      `pasted_certification_${index}`,
      clean(item.name, 120) || 'Certification',
      [item.issuer, item.date].filter(Boolean).join(' · '),
      'education', updatedAt,
    ))
  }
  for (const [index, item] of (content.projects ?? []).entries()) {
    fields.push(field(
      `pasted_project_${index}`,
      clean(item.name, 120) || 'Project',
      [item.role, item.period, ...item.bullets].filter(Boolean).join('\n'),
      'work', updatedAt,
    ))
  }
  return fields.filter((value): value is PersonaField => Boolean(value))
}
