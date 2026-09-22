import { describe, expect, it } from 'vitest'
import { diffResumeText, formatResumeChangeValue } from './resume-change-diff'

describe('resume change diff', () => {
  it('highlights a cross-word replacement rather than treating the whole paragraph as changed', () => {
    const diff = diffResumeText('Managed delivery timelines for distributed teams.', 'Managed complex delivery timelines for distributed teams.')
    expect(diff.before.some(chunk => chunk.type === 'removed' && chunk.text.includes('complex'))).toBe(false)
    expect(diff.after.some(chunk => chunk.type === 'added' && chunk.text.includes('complex'))).toBe(true)
    expect(diff.after.some(chunk => chunk.type === 'same' && chunk.text.includes('delivery'))).toBe(true)
  })

  it('formats structured audit replacements as readable editor text', () => {
    const value = formatResumeChangeValue('experience', [{
      role: 'Product Owner', company: 'Acme', period: '2024 – Present', bullets: ['Owned delivery across two teams.'],
    }])
    expect(value).toContain('Product Owner · Acme · 2024 – Present')
    expect(value).toContain('• Owned delivery across two teams.')
  })

  it('keeps skills changes easy to compare line by line', () => {
    expect(formatResumeChangeValue('skills', ['React', 'Azure'])).toBe('React\nAzure')
  })
})
