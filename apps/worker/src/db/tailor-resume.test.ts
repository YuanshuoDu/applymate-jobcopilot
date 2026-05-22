import { describe, it, expect } from 'vitest'
import { tailorResumeKeywords } from './tailor-resume.js'

describe('tailorResumeKeywords', () => {
  it('adds missing keywords to skills', () => {
    const result = tailorResumeKeywords(
      { personalInfo: { fullName: 'Jane' }, skills: [{ name: 'React' }] },
      'TypeScript, Docker'
    )
    const names = (result.skills ?? []).map(s => typeof s === 'string' ? s : s.name ?? '')
    expect(names).toContain('TypeScript')
    expect(names).toContain('Docker')
    expect(names).toContain('React')
  })

  it('does not duplicate keyword already in resume', () => {
    const result = tailorResumeKeywords(
      { personalInfo: { fullName: 'Jane' }, skills: [{ name: 'React' }] },
      'React, TypeScript'
    )
    const names = (result.skills ?? []).map(s => typeof s === 'string' ? s : s.name ?? '')
    expect(names.filter(n => n === 'React')).toHaveLength(1)
    expect(names).toContain('TypeScript')
  })

  it('returns original when keywords is empty string', () => {
    const original = { personalInfo: { fullName: 'Jane' } }
    const result = tailorResumeKeywords(original, '')
    expect(result).toBe(original)
  })

  it('creates skills array when none exists', () => {
    const result = tailorResumeKeywords({ personalInfo: { fullName: 'Jane' } }, 'Go, Python')
    const names = (result.skills ?? []).map(s => typeof s === 'string' ? s : s.name ?? '')
    expect(names).toContain('Go')
    expect(names).toContain('Python')
  })

  it('case-insensitive dedup — typescript vs TypeScript', () => {
    const result = tailorResumeKeywords(
      { summary: 'Expert in typescript development' },
      'TypeScript, React'
    )
    const names = (result.skills ?? []).map(s => typeof s === 'string' ? s : s.name ?? '')
    expect(names).not.toContain('TypeScript') // already in summary (case-insensitive)
    expect(names).toContain('React')
  })
})
