import { NextRequest } from 'next/server'
import { err, ok } from '@/lib/api-helpers'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const email = typeof body.email === 'string' ? body.email.trim() : ''
  if (!email) return err('email is required')
  if (!/\S+@\S+\.\S+/.test(email)) return err('Invalid email address')

  console.log('[forgot-password] reset requested for', email)
  // TODO: wire up email sending

  return ok({ ok: true })
}
