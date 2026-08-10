import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { credentialContext, decryptSecret, encryptSecret, isEncryptedSecret, maskStoredSecret } from './secret-crypto.js'

const originalNodeEnv = process.env.NODE_ENV
const originalLocalKey = process.env.CREDENTIAL_ENCRYPTION_KEY
const testKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

describe('credential envelope encryption', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test'
    process.env.CREDENTIAL_ENCRYPTION_KEY = testKey
  })

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
    if (originalLocalKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY
    else process.env.CREDENTIAL_ENCRYPTION_KEY = originalLocalKey
  })

  it('round-trips a secret without storing the plaintext', async () => {
    const context = credentialContext('user:user_1:provider:openai')
    const encrypted = await encryptSecret('sk-live-example', context)

    expect(isEncryptedSecret(encrypted)).toBe(true)
    expect(encrypted).not.toContain('sk-live-example')
    await expect(decryptSecret(encrypted, context)).resolves.toBe('sk-live-example')
    expect(maskStoredSecret(encrypted)).toBe('••••')
  })

  it('rejects ciphertext used in a different credential scope', async () => {
    const encrypted = await encryptSecret('secret', credentialContext('user:user_1:provider:openai'))

    await expect(decryptSecret(encrypted, credentialContext('user:user_2:provider:openai')))
      .rejects.toThrow('Credential context mismatch')
  })

  it('keeps legacy plaintext readable during the migration window', async () => {
    await expect(decryptSecret('legacy-secret', credentialContext('legacy'))).resolves.toBe('legacy-secret')
    expect(isEncryptedSecret('legacy-secret')).toBe(false)
  })
})
