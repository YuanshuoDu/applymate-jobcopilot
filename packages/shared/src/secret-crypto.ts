import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms'

const PREFIX = 'enc:v1:'
const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16
const DATA_KEY_TTL_MS = 5 * 60_000
const KMS_CONTEXT = { App: 'ApplyMate', Purpose: 'credential' }

type SecretEnvelope = {
  version: 1
  algorithm: 'aes-256-gcm'
  keyId: string
  wrappedKey?: string
  iv: string
  tag: string
  ciphertext: string
  context: string
}

type CachedDataKey = {
  key: Buffer
  wrappedKey?: string
  keyId: string
  expiresAt: number
}

let kmsClient: KMSClient | null = null
let cachedDataKey: CachedDataKey | null = null

/** True when a value is an application-encrypted credential envelope. */
export function isEncryptedSecret(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX)
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
  const envelope: SecretEnvelope = {
    version: 1,
    algorithm: 'aes-256-gcm',
    keyId: dataKey.keyId,
    ...(dataKey.wrappedKey ? { wrappedKey: dataKey.wrappedKey } : {}),
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    context,
  }
  return `${PREFIX}${Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url')}`
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
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64url').toString('utf8')
    const parsed = JSON.parse(raw) as Partial<SecretEnvelope>
    if (
      parsed.version !== 1
      || parsed.algorithm !== 'aes-256-gcm'
      || typeof parsed.keyId !== 'string'
      || typeof parsed.iv !== 'string'
      || typeof parsed.tag !== 'string'
      || typeof parsed.ciphertext !== 'string'
      || typeof parsed.context !== 'string'
      || (parsed.wrappedKey !== undefined && typeof parsed.wrappedKey !== 'string')
    ) throw new Error('Invalid credential envelope')
    const iv = Buffer.from(parsed.iv, 'base64url')
    const tag = Buffer.from(parsed.tag, 'base64url')
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Invalid credential envelope sizes')
    return parsed as SecretEnvelope
  } catch (error) {
    throw new Error('Invalid encrypted credential', { cause: error })
  }
}

async function getEncryptionKey(): Promise<CachedDataKey> {
  if (cachedDataKey && cachedDataKey.expiresAt > Date.now()) return cachedDataKey

  const kmsKeyId = process.env.CREDENTIAL_KMS_KEY_ID?.trim()
  if (!kmsKeyId) {
    if (process.env.NODE_ENV === 'production') throw new Error('CREDENTIAL_KMS_KEY_ID is required in production')
    const localKey = readLocalKey()
    cachedDataKey = { key: localKey, keyId: 'local-development-key', expiresAt: Date.now() + DATA_KEY_TTL_MS }
    return cachedDataKey
  }

  const response = await getKmsClient().send(new GenerateDataKeyCommand({
    KeyId: kmsKeyId,
    KeySpec: 'AES_256',
    EncryptionContext: KMS_CONTEXT,
  }))
  if (!response.Plaintext || !response.CiphertextBlob) throw new Error('KMS did not return a data key')
  cachedDataKey = {
    key: Buffer.from(response.Plaintext),
    wrappedKey: Buffer.from(response.CiphertextBlob).toString('base64'),
    keyId: response.KeyId ?? kmsKeyId,
    expiresAt: Date.now() + DATA_KEY_TTL_MS,
  }
  return cachedDataKey
}

async function getDecryptionKey(envelope: SecretEnvelope): Promise<Buffer> {
  if (envelope.keyId === 'local-development-key') return readLocalKey()
  if (!envelope.wrappedKey) throw new Error('Encrypted credential has no wrapped data key')
  const response = await getKmsClient().send(new DecryptCommand({
    CiphertextBlob: Buffer.from(envelope.wrappedKey, 'base64'),
    KeyId: process.env.CREDENTIAL_KMS_KEY_ID?.trim() || envelope.keyId,
    EncryptionContext: KMS_CONTEXT,
  }))
  if (!response.Plaintext) throw new Error('KMS did not return a plaintext data key')
  return Buffer.from(response.Plaintext)
}

function getKmsClient(): KMSClient {
  if (!kmsClient) {
    const region = process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim()
    if (!region) throw new Error('AWS_REGION is required for credential KMS encryption')
    kmsClient = new KMSClient({ region })
  }
  return kmsClient
}

function readLocalKey(): Buffer {
  const value = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim()
  if (!value) throw new Error('CREDENTIAL_ENCRYPTION_KEY is required outside production')
  const key = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64')
  if (key.length !== 32) throw new Error('CREDENTIAL_ENCRYPTION_KEY must be 32 bytes')
  return key
}
