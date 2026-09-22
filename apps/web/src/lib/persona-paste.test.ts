import { describe, expect, it } from 'vitest'
import { personaFieldsFromResumeContent } from './persona-paste'

describe('personaFieldsFromResumeContent', () => {
  it('creates reviewable work and education facts without importing contact data', () => {
    const fields = personaFieldsFromResumeContent({
      contact: { name: 'Candidate', email: 'candidate@example.com', location: 'Dublin' },
      summary: 'Product owner with delivery experience.',
      experience: [{ company: 'Example', role: 'Product Owner', period: '2021 – Present', bullets: ['Owned delivery planning.'] }],
      education: [{ institution: 'University', degree: 'MSc Computer Science', year: '2020' }],
      skills: ['Agile', 'SQL'],
      languages: [{ lang: 'English', level: 'Fluent' }],
    }, '2026-09-22T10:00:00.000Z')

    expect(fields.map(field => field.key)).toEqual([
      'pasted_summary', 'pasted_skills', 'pasted_experience_0', 'pasted_education_0', 'pasted_language_0',
    ])
    expect(fields.every(field => field.consentAt === undefined)).toBe(true)
    expect(fields.some(field => field.value.includes('candidate@example.com'))).toBe(false)
  })

  it('truncates a generated field to the Persona validation limit', () => {
    const fields = personaFieldsFromResumeContent({
      contact: { name: '', email: '', location: '' }, summary: 'x'.repeat(2_500), experience: [], education: [], skills: [],
    })
    expect(fields[0]?.value).toHaveLength(2_000)
  })
})
