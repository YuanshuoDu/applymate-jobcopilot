import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findUser: vi.fn(), findResumes: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.findUser }, resume: { findMany: mocks.findResumes } } }))

import { getPersonaProfile, validatePersonaField } from './persona'

describe('validatePersonaField', () => {
  const valid = { key: 'notice_period', label: 'Notice period', value: 'One month', category: 'work' }

  it('allows a bounded, non-sensitive application answer', () => {
    expect(validatePersonaField(valid)).toBeNull()
  })

  it('rejects special-category data to minimise stored Persona data', () => {
    expect(validatePersonaField({ ...valid, key: 'disability_status', label: 'Disability status' })).toContain('Sensitive')
  })

  it('rejects financial and government identifiers that are not needed for applications', () => {
    expect(validatePersonaField({ ...valid, key: 'iban', label: 'IBAN' })).toContain('identifiers')
  })

  it('rejects invalid categories and oversized values', () => {
    expect(validatePersonaField({ ...valid, category: 'other' })).toContain('category')
    expect(validatePersonaField({ ...valid, value: 'a'.repeat(2_001) })).toContain('2,000')
  })
})

describe('getPersonaProfile', () => {
  beforeEach(() => {
    mocks.findUser.mockReset(); mocks.findResumes.mockReset()
    mocks.findUser.mockResolvedValue({ name: 'Ada Lovelace', email: 'ada@example.com', phone: null, location: 'London', linkedin: null, github: null, preferences: { workAuthorization: 'UK right to work' }, personaFields: [
      { key: 'notice_period', label: 'Notice period', value: 'One month', category: 'work', confidence: 1, source: 'form_scan', updatedAt: '2026-07-01' },
      { key: 'gender', label: 'Gender', value: 'Female', category: 'personal', confidence: 1, source: 'form_scan', updatedAt: '2026-07-01' },
    ] })
    mocks.findResumes.mockResolvedValue([{ updatedAt: new Date('2026-07-02'), content: {
      contact: { name: 'Ada Lovelace', email: 'ada@example.com', location: 'London' }, summary: 'Platform engineer', skills: ['TypeScript'], experience: [{ role: 'Engineer', company: 'ApplyMate', period: '2024-now', bullets: ['Built APIs'] }], education: [{ degree: 'BSc', institution: 'London University', year: '2020' }], certifications: [{ name: 'AWS', issuer: 'Amazon', date: '2025' }], languages: [{ lang: 'English', level: 'Native' }], projects: [{ name: 'Persona', bullets: ['Designed the profile'] }],
    } }])
  })

  it('aggregates all original resume facts and only valid confirmed answers', async () => {
    const profile = await getPersonaProfile('user_1')

    expect(mocks.findResumes).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user_1', kind: 'base' } }))
    expect(profile).toMatchObject({ sourceResumeCount: 1, skills: ['TypeScript'], certifications: ['AWS · Amazon (2025)'] })
    expect(profile.experience).toContain('Engineer · ApplyMate (2024-now)')
    expect(profile.applicationAnswers).toEqual([expect.objectContaining({ key: 'notice_period' })])
  })
})
