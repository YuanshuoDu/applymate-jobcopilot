import { describe, expect, it } from 'vitest'
import { normalizeEmail } from './auth-identifiers'

describe('normalizeEmail', () => {
  it('trims and case-folds an email used as an account identifier', () => {
    expect(normalizeEmail('  Member@Example.COM ')).toBe('member@example.com')
  })
})
