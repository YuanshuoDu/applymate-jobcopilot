import { describe, expect, it } from 'vitest'
import { ApplicationPdfUnsupportedCharactersError, isApplicationPdfUnsupportedCharactersError } from './application-pdf-errors'

describe('PDF export errors', () => {
  it('recognizes unsupported text without treating unrelated errors as unsupported characters', () => {
    expect(isApplicationPdfUnsupportedCharactersError(new ApplicationPdfUnsupportedCharactersError())).toBe(true)
    expect(isApplicationPdfUnsupportedCharactersError(new Error('other'))).toBe(false)
    expect(isApplicationPdfUnsupportedCharactersError(null)).toBe(false)
  })
})
