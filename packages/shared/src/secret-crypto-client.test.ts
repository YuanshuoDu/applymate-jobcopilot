import { describe, expect, it } from 'vitest'
import { isEncryptedSecret } from './secret-crypto-client.js'

describe('browser-safe encrypted secret check', () => {
  it('recognizes encrypted credential envelopes without loading crypto', () => {
    expect(isEncryptedSecret('enc:v1:payload')).toBe(true)
    expect(isEncryptedSecret('enc:v2:payload')).toBe(true)
    expect(isEncryptedSecret('legacy-secret')).toBe(false)
    expect(isEncryptedSecret(null)).toBe(false)
  })
})
