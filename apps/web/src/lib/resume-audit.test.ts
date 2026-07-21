import { describe, expect, it } from 'vitest'
import { auditResume } from './resume-audit'

const baseResume = {
  contact: { name: 'Ada Lovelace', email: 'ada@example.com', location: 'Dublin' },
  summary: 'Software engineer focused on reliable web applications.',
  experience: [{ company: 'Example Ltd', role: 'Engineer', period: '2023–Present', bullets: ['Built internal tools.'] }],
  education: [], skills: ['TypeScript', 'React'],
}

describe('auditResume', () => {
  it('passes a complete, factual-looking resume without unverified metrics', () => {
    const result = auditResume(baseResume)
    expect(result.ready).toBe(true)
    expect(result.findings.find(finding => finding.id === 'evidence')?.severity).toBe('pass')
  })

  it('requests confirmation for measurable claims without calling them false', () => {
    const result = auditResume({ ...baseResume, summary: 'Increased activation by 35% for 20k users.' })
    const evidence = result.findings.find(finding => finding.id === 'evidence')
    expect(evidence?.severity).toBe('needs-confirmation')
    expect(evidence?.detail).toContain('personal contribution')
  })

  it('flags invalid contact and duplicate skills', () => {
    const result = auditResume({ ...baseResume, contact: { ...baseResume.contact, email: 'invalid' }, skills: ['React', 'react'] })
    expect(result.ready).toBe(false)
    expect(result.findings.map(finding => finding.id)).toEqual(expect.arrayContaining(['contact', 'duplicates']))
  })
})
