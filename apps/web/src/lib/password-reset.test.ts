import { describe, expect, it } from 'vitest'
import {
  hashPasswordResetToken,
  isValidEmail,
  normalizeEmail,
  passwordResetIdentifier,
  userIdFromPasswordResetIdentifier,
} from './password-reset'

describe('password reset helpers', () => {
  it('normalizes email addresses before lookup', () => {
    expect(normalizeEmail('  Candidate@Example.COM ')).toBe('candidate@example.com')
    expect(isValidEmail('candidate@example.com')).toBe(true)
  })

  it('stores a one-way token hash and a namespaced user identifier', () => {
    const token = 'm'.repeat(43)
    const identifier = passwordResetIdentifier('user_123')

    expect(hashPasswordResetToken(token)).not.toBe(token)
    expect(userIdFromPasswordResetIdentifier(identifier)).toBe('user_123')
    expect(userIdFromPasswordResetIdentifier('candidate@example.com')).toBeNull()
  })
})
