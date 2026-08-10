import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const authPages = ['RegisterPage.tsx', 'LoginPage.tsx']
const conflictingBackgroundStyles = /background:\s*'linear-gradient\(135deg, #EEF2FF 0%, #F5F3FF 35%, #EDE9FE 65%, #F0F9FF 100%\)',\s*backgroundAttachment:\s*'fixed'/

describe('auth page background styles', () => {
  it.each(authPages)('does not mix background shorthand with background attachment in %s', page => {
    const source = readFileSync(resolve(__dirname, page), 'utf8')

    expect(source).not.toMatch(conflictingBackgroundStyles)
  })
})
