export function isRecoverableAuthSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('JWTSessionError')
    || message.includes('no matching decryption secret')
}
