import { describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const findReauth = vi.hoisted(() => vi.fn())
vi.mock('@/lib/db', () => ({ db: { adminReauthGrant: { findFirst: findReauth } } }))

describe('admin WebAuthn helpers', () => {
  it('derives a stable RP configuration from explicit environment settings', async () => {
    const oldOrigin = process.env.WEBAUTHN_ORIGIN
    const oldRpId = process.env.WEBAUTHN_RP_ID
    process.env.WEBAUTHN_ORIGIN = 'https://admin.example'
    process.env.WEBAUTHN_RP_ID = 'admin.example'
    const { webAuthnSettings } = await import('./webauthn')
    expect(webAuthnSettings(new Request('https://wrong.example/admin'))).toEqual({ origin: 'https://admin.example', rpID: 'admin.example', rpName: 'ApplyMate' })
    if (oldOrigin === undefined) delete process.env.WEBAUTHN_ORIGIN
    else process.env.WEBAUTHN_ORIGIN = oldOrigin
    if (oldRpId === undefined) delete process.env.WEBAUTHN_RP_ID
    else process.env.WEBAUTHN_RP_ID = oldRpId
  })

  it('accepts only a non-expired hashed reauth cookie', async () => {
    const { ADMIN_REAUTH_COOKIE, hashReauthToken, hasFreshAdminReauth } = await import('./webauthn')
    findReauth.mockResolvedValue({ id: 'grant-1' })
    const request = new Request('https://admin.example/api', { headers: { cookie: `${ADMIN_REAUTH_COOKIE}=token-1` } })
    expect(await hasFreshAdminReauth(request, 'admin-1')).toBe(true)
    expect(findReauth).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: 'admin-1', tokenHash: hashReauthToken('token-1') }) }))
    findReauth.mockResolvedValue(null)
    expect(await hasFreshAdminReauth(request, 'admin-1')).toBe(false)
  })

  it('sets a strict, http-only reauth cookie', async () => {
    const { setReauthCookie } = await import('./webauthn')
    const response = NextResponse.json({ ok: true })
    setReauthCookie(response, 'token-2')
    const cookie = response.headers.get('set-cookie')
    expect(cookie).toContain('applymate-admin-reauth=token-2')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=strict')
  })
})
