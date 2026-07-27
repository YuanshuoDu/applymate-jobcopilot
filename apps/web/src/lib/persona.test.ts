import { describe, expect, it } from 'vitest'
import { validatePersonaField } from './persona'

describe('validatePersonaField', () => {
  const valid = { key: 'notice_period', label: 'Notice period', value: 'One month', category: 'work' }

  it('allows a bounded, non-sensitive application answer', () => {
    expect(validatePersonaField(valid)).toBeNull()
  })

  it('rejects special-category data to minimise stored Persona data', () => {
    expect(validatePersonaField({ ...valid, key: 'disability_status', label: 'Disability status' })).toContain('Sensitive')
  })

  it('rejects invalid categories and oversized values', () => {
    expect(validatePersonaField({ ...valid, category: 'other' })).toContain('category')
    expect(validatePersonaField({ ...valid, value: 'a'.repeat(2_001) })).toContain('2,000')
  })
})
