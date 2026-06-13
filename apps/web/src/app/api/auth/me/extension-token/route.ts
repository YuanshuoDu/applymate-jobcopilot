/**
 * GET /api/auth/me/extension-token
 * Dashboard → Extension auth bridge.
 * Requires a valid NextAuth session. Returns a 30-day JWT for the extension.
 */
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { SignJWT } from 'jose'
import { db } from '@/lib/db'

const JWT_SECRET = new TextEncoder().encode(
  process.env.AUTH_SECRET ?? 'fallback-secret-change-this',
)

export async function GET() {
  const session = await auth()
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const user = await db.user.findUnique({ where: { email: session.user.email } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const token = await new SignJWT({
    sub:   user.id,
    email: user.email,
    name:  user.name ?? '',
    plan:  user.plan,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(JWT_SECRET)

  return NextResponse.json({
    token,
    user: {
      id:    user.id,
      email: user.email,
      name:  user.name,
      plan:  user.plan,
    },
  })
}
