import { describe, expect, it } from 'vitest'
import { sanitizeLosslessProposedValue } from './application-audit-repair-safety'

describe('lossless audit corrections', () => {
  it('accepts complete valid values regardless of object key order', () => {
    const experience = [{ bullets: ['Built systems.'], period: '2020–2022', role: 'Engineer', company: 'Acme' }]
    expect(sanitizeLosslessProposedValue('experience', experience)).toEqual(experience)
    expect(sanitizeLosslessProposedValue('summary', 'A valid summary.')).toBe('A valid summary.')
  })

  it('rejects normalization that shortens text or discards fields', () => {
    expect(sanitizeLosslessProposedValue('summary', 'x'.repeat(12_001))).toBeNull()
    expect(sanitizeLosslessProposedValue('summary', ' padded ')).toBeNull()
    expect(sanitizeLosslessProposedValue('experience', [{ company: 'Acme', role: 'Engineer', period: '2020', bullets: ['Built'], extra: 'do not erase' }])).toBeNull()
    expect(sanitizeLosslessProposedValue('contact', { name: 'Ada', pronouns: 'they/them' })).toBeNull()
    expect(sanitizeLosslessProposedValue('skills', ['x'.repeat(2_001)])).toBeNull()
  })

  it('fails closed on malformed replacements', () => {
    expect(sanitizeLosslessProposedValue('experience', [{ company: 'Acme' }])).toBeNull()
    expect(sanitizeLosslessProposedValue('skills', ['valid', null])).toBeNull()
    expect(sanitizeLosslessProposedValue('summary', null)).toBeNull()
  })
})
