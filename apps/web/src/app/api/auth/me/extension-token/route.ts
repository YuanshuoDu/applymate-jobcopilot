/**
 * GET /api/auth/me/extension-token
 * Dashboard → Extension auth bridge.
 * Requires a valid NextAuth session. Returns a 30-day JWT for the extension.
 */
import { NextResponse } from 'next/server'
import { safeAuth } from '@/lib/safe-auth'
import { SignJWT } from 'jose'
import { db } from '@/lib/db'
import { EXTENSION_TOKEN_AUDIENCE, EXTENSION_TOKEN_ISSUER, getAuthJwtSecret } from '@/lib/auth-secret'

const JWT_SECRET = getAuthJwtSecret()

export async function GET() {
  const session = await safeAuth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const user = await db.user.findUnique({ where: { id: session.user.id } })
  if (!user || user.accountStatus === 'suspended') {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const token = await new SignJWT({
    sub:   user.id,
    email: user.email,
    name:  user.name ?? '',
    plan:  user.plan,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(EXTENSION_TOKEN_ISSUER)
    .setAudience(EXTENSION_TOKEN_AUDIENCE)
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
