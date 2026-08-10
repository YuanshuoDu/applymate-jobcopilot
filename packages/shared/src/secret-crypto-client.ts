/**
 * Browser-safe credential envelope check.
 *
 * Encryption and decryption remain in secret-crypto.ts, which is server-only
 * because it uses node:crypto and the AWS KMS client.
 */
const ENCRYPTED_SECRET_PREFIX = 'enc:v1:'

export function isEncryptedSecret(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_SECRET_PREFIX)
}
