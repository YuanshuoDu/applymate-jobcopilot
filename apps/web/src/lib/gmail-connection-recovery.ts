type GmailConnectionRecoveryInput = {
  existingConnectionUserId: string
  currentUserId: string
  googleLoginUserId: string | null | undefined
  transferRequested?: boolean
}

/**
 * A stale Gmail integration can be recovered from a repaired Google login, or
 * moved after the user explicitly requested transfer before OAuth started.
 */
export function canRecoverStaleGmailConnection({
  existingConnectionUserId,
  currentUserId,
  googleLoginUserId,
  transferRequested = false,
}: GmailConnectionRecoveryInput): boolean {
  return transferRequested || (existingConnectionUserId !== currentUserId && googleLoginUserId === currentUserId)
}
