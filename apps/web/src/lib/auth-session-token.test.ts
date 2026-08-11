import { describe, expect, it } from 'vitest'
import {
  refreshEmailOnlySessionToken,
  refreshExistingSessionToken,
  sessionTokenEmail,
  sessionTokenUserId,
} from './auth-session-token'

const activeUser = { accountStatus: 'active', authVersion: 1, plan: 'pro' }

describe('refreshExistingSessionToken', () => {
  it('reads one verified identity from either current or legacy claims', () => {
    expect(sessionTokenUserId({ id: 'user_current', sub: 'user_current' })).toBe('user_current')
    expect(sessionTokenUserId({ sub: 'user_legacy' })).toBe('user_legacy')
  })

  it('rejects conflicting or missing session identities', () => {
    expect(sessionTokenUserId({ id: 'user_1', sub: 'user_2' })).toBeNull()
    expect(sessionTokenUserId({ email: 'candidate@example.com' })).toBeNull()
  })

  it('normalizes the signed email retained by an identity-less legacy token', () => {
    expect(sessionTokenEmail({ email: ' Candidate@Example.com ' })).toBe('candidate@example.com')
    expect(sessionTokenEmail({ email: '' })).toBeNull()
  })

  it('normalizes an active legacy Auth.js subject into the application id claim', () => {
    const token = { sub: 'user_legacy', email: 'candidate@example.com' }

    expect(refreshExistingSessionToken(token, activeUser)).toEqual({
      sub: 'user_legacy',
      id: 'user_legacy',
      email: 'candidate@example.com',
      authVersion: 1,
      plan: 'pro',
    })
  })

  it('preserves a current session identity and refreshes current account claims', () => {
    const token = { id: 'user_current', sub: 'user_current', authVersion: 1, plan: 'free' }

    expect(refreshExistingSessionToken(token, activeUser)).toEqual({
      id: 'user_current',
      sub: 'user_current',
      authVersion: 1,
      plan: 'pro',
    })
  })

  it('upgrades an active email-only legacy token to the current user id', () => {
    const token = { email: 'candidate@example.com' }

    expect(refreshEmailOnlySessionToken(token, { id: 'user_legacy', ...activeUser })).toEqual({
      id: 'user_legacy',
      email: 'candidate@example.com',
      authVersion: 1,
      plan: 'pro',
    })
  })

  it.each([
    [{ email: 'candidate@example.com' }, { id: 'user_legacy', accountStatus: 'suspended', authVersion: 1, plan: 'pro' }],
    [{ email: 'candidate@example.com' }, { id: 'user_legacy', accountStatus: 'active', authVersion: 2, plan: 'pro' }],
    [{ id: 'user_1', email: 'candidate@example.com' }, { id: 'user_legacy', ...activeUser }],
  ])('never upgrades an unsafe or identity-conflicting email token: %o', (token, user) => {
    expect(refreshEmailOnlySessionToken(token, user)).toEqual({})
  })

  it.each([
    [{ sub: 'user_1', authVersion: 1 }, { accountStatus: 'suspended', authVersion: 1, plan: 'pro' }],
    [{ sub: 'user_1', authVersion: 1 }, { accountStatus: 'active', authVersion: 2, plan: 'pro' }],
    [{ id: 'user_1', sub: 'user_2', authVersion: 1 }, activeUser],
    [{ email: 'candidate@example.com' }, activeUser],
  ])('invalidates unsafe or revoked token state: %o', (token, user) => {
    expect(refreshExistingSessionToken(token, user)).toEqual({})
  })
})
