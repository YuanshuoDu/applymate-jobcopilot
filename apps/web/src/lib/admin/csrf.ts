import { NextResponse } from 'next/server'

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
