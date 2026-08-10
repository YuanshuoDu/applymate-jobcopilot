import { describe, expect, it } from 'vitest'
import { safeAccentColor, safeTemplateOptions } from './template-options'

describe('template option sanitization', () => {
  it('allows only literal palette colors or the product CSS token', () => {
    expect(safeAccentColor('url(https://attacker.example/x)', '#185FA5')).toBe('#185FA5')
    expect(safeAccentColor('#2e6b4f')).toBe('#2e6b4f')
  })

  it('rejects CSS functions in persisted options', () => {
    expect(safeTemplateOptions({ accentColor: 'url(https://attacker.example/x)' })).toBeNull()
  })
})
