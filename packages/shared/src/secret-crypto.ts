import { DefaultAzureCredential } from '@azure/identity'
import { CryptographyClient, KeyClient } from '@azure/keyvault-keys'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const PREFIX = 'enc:v2:'
const LEGACY_PREFIX = 'enc:v1:'
const ALGORITHM = 'aes-256-gcm'
const WRAP_ALGORITHM = 'RSA-OAEP-256'
const IV_BYTES = 12
const TAG_BYTES = 16
const DATA_KEY_BYTES = 32
const DATA_KEY_TTL_MS = 5 * 60_000

type SecretEnvelopeBase = {
  algorithm: 'aes-256-gcm'
  iv: string
  tag: string
  ciphertext: string
  context: string
}

type LegacyEnvelope = SecretEnvelopeBase & {
  version: 1
  keyId: string
  wrappedKey?: string
}

type AzureEnvelope = SecretEnvelopeBase & {
  version: 2
  provider: 'azure-key-vault'
  wrapAlgorithm: 'RSA-OAEP-256'
  keyId: string
  wrappedKey: string
}

type SecretEnvelope = LegacyEnvelope | AzureEnvelope

type CachedDataKey = {
  key: Buffer
  wrappedKey?: string
  keyId: string
  expiresAt: number
}

type AzureKeyConfig = {
  vaultUrl: string
  keyName: string
}

let azureCredential: DefaultAzureCredential | null = null
const cryptographyClients = new Map<string, CryptographyClient>()
let cachedDataKey: CachedDataKey | null = null

/** True when a value is an application-encrypted credential envelope. */
export function isEncryptedSecret(value: unknown): boolean {
  return typeof value === 'string' && (value.startsWith(PREFIX) || value.startsWith(LEGACY_PREFIX))
}

/** Build stable authenticated-data scopes shared by Web and Worker. */
export function credentialContext(scope: string): string {
  return `applymate:credential:${scope}`
}

/** Encrypt a credential without exposing its plaintext to the database. */
export async function encryptSecret(value: string, context: string): Promise<string> {
  if (!value) throw new Error('Cannot encrypt an empty credential')
  const dataKey = await getEncryptionKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, dataKey.key, iv)
  cipher.setAAD(Buffer.from(context, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const envelope: AzureEnvelope | LegacyEnvelope = dataKey.wrappedKey
    ? {
        version: 2,
        provider: 'azure-key-vault',
        wrapAlgorithm: WRAP_ALGORITHM,
        keyId: dataKey.keyId,
        wrappedKey: dataKey.wrappedKey,
        algorithm: ALGORITHM,
        iv: iv.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        context,
      }
    : {
        version: 1,
        keyId: dataKey.keyId,
        algorithm: ALGORITHM,
        iv: iv.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        context,
      }
  return `${envelope.version === 2 ? PREFIX : LEGACY_PREFIX}${Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url')}`
}

/** Decrypt an encrypted credential, while preserving legacy plaintext during migration. */
export async function decryptSecret(value: string | null | undefined, context: string): Promise<string | null> {
  if (!value) return null
  if (!isEncryptedSecret(value)) return value

  const envelope = parseEnvelope(value)
  if (envelope.context !== context) throw new Error('Credential context mismatch')
  const key = await getDecryptionKey(envelope)
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, 'base64url'))
  decipher.setAAD(Buffer.from(context, 'utf8'))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
    decipher.final(),
  ])
  return plaintext.toString('utf8')
}

/** Mask a stored value without ever treating ciphertext as a user-visible key. */
export function maskStoredSecret(value: string | null | undefined): string | null {
  if (!value) return null
  if (isEncryptedSecret(value)) return '••••'
  return value.length <= 8 ? '••••' : `••••${value.slice(-4)}`
}

function parseEnvelope(value: string): SecretEnvelope {
  try {
    const prefixLength = value.startsWith(PREFIX) ? PREFIX.length : LEGACY_PREFIX.length
    const raw = Buffer.from(value.slice(prefixLength), 'base64url').toString('utf8')
    const parsed = JSON.parse(raw) as Partial<AzureEnvelope> & Partial<LegacyEnvelope>
    if (
      (parsed.version !== 1 && parsed.version !== 2)
      || parsed.algorithm !== ALGORITHM
      || typeof parsed.keyId !== 'string'
      || typeof parsed.iv !== 'string'
      || typeof parsed.tag !== 'string'
      || typeof parsed.ciphertext !== 'string'
      || typeof parsed.context !== 'string'
    ) throw new Error('Invalid credential envelope')
    const iv = Buffer.from(parsed.iv, 'base64url')
    const tag = Buffer.from(parsed.tag, 'base64url')
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Invalid credential envelope sizes')
    if (parsed.version === 2) {
      if (parsed.provider !== 'azure-key-vault' || parsed.wrapAlgorithm !== WRAP_ALGORITHM || typeof parsed.wrappedKey !== 'string') {
        throw new Error('Invalid Azure credential envelope')
      }
    } else if (parsed.wrappedKey !== undefined && typeof parsed.wrappedKey !== 'string') {
      throw new Error('Invalid legacy credential envelope')
    }
    return parsed as unknown as SecretEnvelope
  } catch (error) {
    throw new Error('Invalid encrypted credential', { cause: error })
  }
}

async function getEncryptionKey(): Promise<CachedDataKey> {
  if (cachedDataKey && cachedDataKey.expiresAt > Date.now()) return cachedDataKey
  const azureConfig = getAzureKeyConfig()
  if (!azureConfig) {
    const localKey = readLocalKey()
    cachedDataKey = { key: localKey, keyId: 'local-development-key', expiresAt: Date.now() + DATA_KEY_TTL_MS }
    return cachedDataKey
  }

  const dataKey = randomBytes(DATA_KEY_BYTES)
  const client = await getCryptographyClient()
  const response = await client.wrapKey(WRAP_ALGORITHM, dataKey)
  const keyId = response.keyID ?? client.keyID
  if (!response.result || !keyId) throw new Error('Azure Key Vault did not return a wrapped data key')
  cachedDataKey = {
    key: dataKey,
    wrappedKey: Buffer.from(response.result).toString('base64'),
    keyId,
    expiresAt: Date.now() + DATA_KEY_TTL_MS,
  }
  return cachedDataKey
}

async function getDecryptionKey(envelope: SecretEnvelope): Promise<Buffer> {
  if (envelope.keyId === 'local-development-key') return readLocalKey()
  if (envelope.version === 1) {
    throw new Error('Legacy AWS-encrypted credential cannot be decrypted after Azure migration; re-enter the credential')
  }

  const client = await getCryptographyClient(envelope.keyId)
  const response = await client.unwrapKey(WRAP_ALGORITHM, Buffer.from(envelope.wrappedKey, 'base64'))
  if (!response.result || response.result.length !== DATA_KEY_BYTES) throw new Error('Azure Key Vault returned an invalid data key')
  return Buffer.from(response.result)
}

async function getCryptographyClient(keyId?: string): Promise<CryptographyClient> {
  const config = getAzureKeyConfig()
  if (!config) throw new Error('Azure Key Vault configuration is required')
  const credential = getAzureCredential()
  let resolvedKeyId = keyId?.trim()
  if (resolvedKeyId) {
    const configuredOrigin = new URL(config.vaultUrl).origin
    const envelopeUrl = new URL(resolvedKeyId)
    if (envelopeUrl.origin !== configuredOrigin || !envelopeUrl.pathname.startsWith('/keys/')) {
      throw new Error('Encrypted credential references an untrusted Azure Key Vault key')
    }
  } else {
    const key = await new KeyClient(config.vaultUrl, credential).getKey(config.keyName)
    resolvedKeyId = key.id
  }
  if (!resolvedKeyId) throw new Error('Azure Key Vault credential key was not found')
  const existing = cryptographyClients.get(resolvedKeyId)
  if (existing) return existing
  const client = new CryptographyClient(resolvedKeyId, credential)
  cryptographyClients.set(resolvedKeyId, client)
  return client
}

function getAzureKeyConfig(): AzureKeyConfig | null {
  const vaultUrl = process.env.AZURE_KEY_VAULT_URL?.trim()
  const keyName = process.env.AZURE_KEY_NAME?.trim()
  if (!vaultUrl && !keyName) {
    if (process.env.NODE_ENV === 'production') throw new Error('AZURE_KEY_VAULT_URL and AZURE_KEY_NAME are required in production')
    return null
  }
  if (!vaultUrl || !keyName) throw new Error('AZURE_KEY_VAULT_URL and AZURE_KEY_NAME must be configured together')
  let parsed: URL
  try {
    parsed = new URL(vaultUrl)
  } catch {
    throw new Error('AZURE_KEY_VAULT_URL must be a valid HTTPS URL')
  }
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/') throw new Error('AZURE_KEY_VAULT_URL must be a vault HTTPS origin')
  return { vaultUrl: parsed.origin, keyName }
}

function getAzureCredential(): DefaultAzureCredential {
  if (!azureCredential) {
    const servicePrincipalValues = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'].map(name => process.env[name]?.trim())
    if (servicePrincipalValues.some(Boolean) && servicePrincipalValues.some(value => !value)) {
      throw new Error('AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET must be configured together')
    }
    azureCredential = new DefaultAzureCredential()
  }
  return azureCredential
}

function readLocalKey(): Buffer {
  const value = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim()
  if (!value) throw new Error('CREDENTIAL_ENCRYPTION_KEY is required outside production')
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64')
  if (key.length !== DATA_KEY_BYTES) throw new Error('CREDENTIAL_ENCRYPTION_KEY must be 32 bytes')
  return key
}
