import type { ResumeContent } from '@/lib/types'

export interface PersonaContactFields {
  name?: boolean
  email?: boolean
  phone?: boolean
  location?: boolean
  linkedin?: boolean
}

type PersonaContactField = keyof PersonaContactFields

const PERSONA_CONTACT_FIELDS: PersonaContactField[] = ['name', 'email', 'phone', 'location', 'linkedin']

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function fillMissingResumeContactFields(
  content: ResumeContent,
  profile: Partial<Record<PersonaContactField, unknown>>,
): { merged: ResumeContent; persona: PersonaContactFields } {
  const merged: ResumeContent = { ...content, contact: { ...content.contact } }
  const persona: PersonaContactFields = {}

  for (const field of PERSONA_CONTACT_FIELDS) {
    const resumeValue = merged.contact[field]
    const profileValue = profile[field]

    if (hasText(resumeValue) || !hasText(profileValue)) continue

    merged.contact[field] = profileValue.trim()
    persona[field] = true
  }

  return { merged, persona }
}
