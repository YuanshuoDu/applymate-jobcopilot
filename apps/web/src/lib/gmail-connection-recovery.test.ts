import { describe, expect, it } from 'vitest'
import { canRecoverStaleGmailConnection } from './gmail-connection-recovery'

describe('canRecoverStaleGmailConnection', () => {
  it('recovers a legacy Gmail connection once the matching Google login belongs to the current user', () => {
    expect(canRecoverStaleGmailConnection({
      existingConnectionUserId: 'demo-user',
      currentUserId: 'real-user',
      googleLoginUserId: 'real-user',
    })).toBe(true)
  })

  it('does not allow another account to take a Gmail connection', () => {
    expect(canRecoverStaleGmailConnection({
      existingConnectionUserId: 'other-user',
      currentUserId: 'current-user',
      googleLoginUserId: 'other-user',
    })).toBe(false)
  })

  it('allows an explicit transfer after the user authorizes the Gmail OAuth flow', () => {
    expect(canRecoverStaleGmailConnection({
      existingConnectionUserId: 'old-user',
      currentUserId: 'new-user',
      googleLoginUserId: 'different-google-login',
      transferRequested: true,
    })).toBe(true)
  })
})
