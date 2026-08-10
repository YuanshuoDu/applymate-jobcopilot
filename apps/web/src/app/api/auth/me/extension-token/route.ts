/**
 * GET /api/auth/me/extension-token
 * Dashboard → Extension auth bridge.
 * Requires a valid NextAuth session. Returns a 30-day JWT for the extension.
 */
import { NextResponse } from 'next/server'
import { safeAuth } from '@/lib/safe-auth'
import { SignJWT } from 'jose'
import { db } from '@/lib/db'
import { getAuthJwtSecret } from '@/lib/auth-secret'

const JWT_SECRET = getAuthJwtSecret()

export async function GET() {
  const session = await safeAuth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, email: true, name: true, plan: true, accountStatus: true },
  })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }
  if (user.accountStatus === 'suspended') {
    return NextResponse.json({ error: 'Account suspended' }, { status: 403 })
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
