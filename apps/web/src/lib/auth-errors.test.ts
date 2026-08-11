import { describe, expect, it } from 'vitest'
import { credentialsSignInMessage } from './auth-errors'

describe('credentials sign-in errors', () => {
  it('keeps credential failures generic', () => {
    expect(credentialsSignInMessage('CredentialsSignin')).toBe('Invalid email or password.')
  })

  it('does not mislabel service failures as bad credentials', () => {
    expect(credentialsSignInMessage('CallbackRouteError')).toBe('Sign-in is temporarily unavailable. Please try again.')
    expect(credentialsSignInMessage('Configuration')).toBe('Sign-in is temporarily unavailable. Please try again.')
    expect(credentialsSignInMessage(undefined)).toBe('Sign-in is temporarily unavailable. Please try again.')
  })
})
