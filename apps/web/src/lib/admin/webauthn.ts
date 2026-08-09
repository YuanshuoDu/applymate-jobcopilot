import { createHash, randomBytes } from 'node:crypto'
import type { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const ADMIN_REAUTH_COOKIE = 'applymate-admin-reauth'
export const ADMIN_REAUTH_TTL_SECONDS = 15 * 60
export const ADMIN_WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000

const supportedTransports = ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'] as const
export type StoredAuthenticatorTransport = (typeof supportedTransports)[number]

export function webAuthnSettings(request: Request) {
  const origin = process.env.WEBAUTHN_ORIGIN ?? process.env.AUTH_CANONICAL_URL ?? new URL(request.url).origin
  return {
    origin,
    rpID: process.env.WEBAUTHN_RP_ID ?? new URL(origin).hostname,
    rpName: process.env.WEBAUTHN_RP_NAME ?? 'ApplyMate',
  }
}

export function newChallenge() {
  return randomBytes(32).toString('base64url')
}

export function newReauthToken() {
  return randomBytes(32).toString('base64url')
}

export function hashReauthToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export function cookieValue(request: Request, name: string) {
  const cookies = request.headers.get('cookie')?.split(';') ?? []
  const prefix = `${name}=`
  const value = cookies.find((cookie) => cookie.trim().startsWith(prefix))?.trim().slice(prefix.length)
  if (!value) return null
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

export function setReauthCookie(response: NextResponse, token: string) {
  response.cookies.set({
    name: ADMIN_REAUTH_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: ADMIN_REAUTH_TTL_SECONDS,
  })
}

export function validTransports(values: readonly string[]) {
  return values.filter((value): value is StoredAuthenticatorTransport => supportedTransports.includes(value as StoredAuthenticatorTransport))
}

export function credentialIdBytes(credentialId: string) {
  return Buffer.from(credentialId, 'base64url')
}

export async function hasFreshAdminReauth(request: Request | undefined, userId: string) {
  if (!request) return true
  const token = cookieValue(request, ADMIN_REAUTH_COOKIE)
  if (!token) return false
  const grant = await db.adminReauthGrant.findFirst({
    where: { userId, tokenHash: hashReauthToken(token), expiresAt: { gt: new Date() } },
    select: { id: true },
  })
  return Boolean(grant)
}
