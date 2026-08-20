/**
 * Browser-safe credential envelope check.
 *
 * Encryption and decryption remain in secret-crypto.ts, which is server-only
 * because it uses node:crypto and the Azure Key Vault client.
 */
const ENCRYPTED_SECRET_PREFIXES = ['enc:v1:', 'enc:v2:']

export function isEncryptedSecret(value: unknown): boolean {
  return typeof value === 'string' && ENCRYPTED_SECRET_PREFIXES.some(prefix => value.startsWith(prefix))
}
