import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  keyId: 'https://applymate.vault.azure.net/keys/applymate-credential-key/v1',
  getKey: vi.fn(),
  wrapKey: vi.fn(),
  unwrapKey: vi.fn(),
  dataKey: undefined as Buffer | undefined,
}))

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('@azure/keyvault-keys', () => ({
  KeyClient: vi.fn().mockImplementation(() => ({ getKey: mocks.getKey })),
  CryptographyClient: vi.fn().mockImplementation(() => ({
    keyID: mocks.keyId,
    wrapKey: mocks.wrapKey,
    unwrapKey: mocks.unwrapKey,
  })),
}))

import { credentialContext, decryptSecret, encryptSecret } from './secret-crypto.js'

const originalEnv = {
  nodeEnv: process.env.NODE_ENV,
  vaultUrl: process.env.AZURE_KEY_VAULT_URL,
  keyName: process.env.AZURE_KEY_NAME,
  tenantId: process.env.AZURE_TENANT_ID,
  clientId: process.env.AZURE_CLIENT_ID,
  clientSecret: process.env.AZURE_CLIENT_SECRET,
}

describe('Azure Key Vault credential encryption', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production'
    process.env.AZURE_KEY_VAULT_URL = 'https://applymate.vault.azure.net'
    process.env.AZURE_KEY_NAME = 'applymate-credential-key'
    delete process.env.AZURE_TENANT_ID
    delete process.env.AZURE_CLIENT_ID
    delete process.env.AZURE_CLIENT_SECRET
    mocks.getKey.mockResolvedValue({ id: mocks.keyId })
    mocks.wrapKey.mockImplementation((_algorithm: string, key: Uint8Array) => {
      mocks.dataKey = Buffer.from(key)
      return { result: Buffer.from('wrapped-data-key'), keyID: mocks.keyId }
    })
    mocks.unwrapKey.mockImplementation(() => ({ result: mocks.dataKey ?? Buffer.alloc(32) }))
  })

  it('wraps the AES data key in Azure and round-trips a v2 envelope', async () => {
    const context = credentialContext('user:user_1:provider:openai')
    const encrypted = await encryptSecret('sk-azure-example', context)

    expect(encrypted.startsWith('enc:v2:')).toBe(true)
    expect(mocks.getKey).toHaveBeenCalledWith('applymate-credential-key')
    expect(mocks.wrapKey).toHaveBeenCalledWith('RSA-OAEP-256', expect.any(Buffer))
    await expect(decryptSecret(encrypted, context)).resolves.toBe('sk-azure-example')
    expect(mocks.unwrapKey).toHaveBeenCalledWith('RSA-OAEP-256', expect.any(Buffer))
  })

  it('rejects legacy AWS envelopes instead of attempting an unsafe fallback', async () => {
    const context = credentialContext('legacy')
    const payload = Buffer.from(JSON.stringify({
      version: 1,
      keyId: 'aws-kms-key',
      wrappedKey: Buffer.from('legacy').toString('base64'),
      algorithm: 'aes-256-gcm',
      iv: Buffer.alloc(12).toString('base64url'),
      tag: Buffer.alloc(16).toString('base64url'),
      ciphertext: Buffer.from('legacy').toString('base64url'),
      context,
    })).toString('base64url')

    await expect(decryptSecret(`enc:v1:${payload}`, context))
      .rejects.toThrow('Legacy AWS-encrypted credential cannot be decrypted after Azure migration')
  })
})

afterAll(() => {
  process.env.NODE_ENV = originalEnv.nodeEnv
  for (const [name, value] of Object.entries({
    AZURE_KEY_VAULT_URL: originalEnv.vaultUrl,
    AZURE_KEY_NAME: originalEnv.keyName,
    AZURE_TENANT_ID: originalEnv.tenantId,
    AZURE_CLIENT_ID: originalEnv.clientId,
    AZURE_CLIENT_SECRET: originalEnv.clientSecret,
  })) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})
