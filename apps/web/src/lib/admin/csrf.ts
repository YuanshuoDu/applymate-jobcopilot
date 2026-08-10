import { NextResponse } from 'next/server'

export type AdminWriteValidation = { ok: true } | { ok: false; status: 403 | 400; code: 'CSRF_ORIGIN_MISMATCH' | 'IDEMPOTENCY_KEY_REQUIRED' }

export function validateAdminWrite(request: Request) {
  const origin = request.headers.get('origin')
  const host = request.headers.get('host')
  const idempotencyKey = request.headers.get('idempotency-key')
  if (!origin || !host || new URL(origin).host !== host) {
    return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 })
  }
  if (!idempotencyKey || idempotencyKey.length > 128) {
    return NextResponse.json({ error: 'Idempotency-Key is required' }, { status: 400 })
  }
  return null
}

export function validateAdminWriteRequest(request: Request): AdminWriteValidation {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) return { ok: true }
  const configuredOrigin = originFrom(process.env.AUTH_CANONICAL_URL) ?? originFrom(process.env.NEXTAUTH_URL) ?? originFrom(request.url)
  const requestOrigin = originFrom(request.headers.get('origin') ?? request.headers.get('referer') ?? undefined)
  return configuredOrigin && requestOrigin === configuredOrigin
    ? { ok: true }
    : { ok: false, status: 403, code: 'CSRF_ORIGIN_MISMATCH' }
}

function originFrom(value: string | null | undefined): string | null {
  if (!value) return null
  try { return new URL(value).origin } catch { return null }
}
