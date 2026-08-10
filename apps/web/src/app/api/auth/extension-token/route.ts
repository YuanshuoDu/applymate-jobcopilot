/**
 * POST /api/auth/extension-token
 * Chrome Extension 专用登录接口
 * 验证邮箱密码后返回可用于 Bearer 认证的长效 JWT
 */
import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { SignJWT } from 'jose'
import { db } from '@/lib/db'
import { normalizeEmail } from '@/lib/auth-identifiers'
import { EXTENSION_TOKEN_AUDIENCE, EXTENSION_TOKEN_ISSUER, getAuthJwtSecret } from '@/lib/auth-secret'
import { checkAuthRateLimit } from '@/lib/auth-rate-limit'

const JWT_SECRET = getAuthJwtSecret()

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || typeof body.email !== 'string' || typeof body.password !== 'string') {
    return NextResponse.json({ error: 'email and password required' }, { status: 400 })
  }

  const email = normalizeEmail(body.email)
  if (!email) return NextResponse.json({ error: 'email and password required' }, { status: 400 })

  const rate = await checkAuthRateLimit(req, 'extension-token', email, { ipLimit: 20, identityLimit: 8, windowMs: 15 * 60_000 })
  if (!rate.ok) {
    return NextResponse.json(
      { error: rate.unavailable ? 'Authentication service temporarily unavailable' : 'Too many login attempts' },
      { status: rate.unavailable ? 503 : 429, headers: rate.unavailable ? undefined : { 'Retry-After': String(rate.retryAfter) } },
    )
  }

  const user = await db.user.findUnique({ where: { email } })
  if (!user?.password || user.accountStatus === 'suspended') {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
  }

  const valid = await bcrypt.compare(body.password, user.password)
  if (!valid) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
  }

  // Issue a 30-day token
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

  const token = await new SignJWT({
    sub:   user.id,
    email: user.email,
    name:  user.name ?? '',
    plan:  user.plan,
    updatedAt: user.updatedAt.toISOString(),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(EXTENSION_TOKEN_ISSUER)
    .setAudience(EXTENSION_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(JWT_SECRET)

  return NextResponse.json({
    token,
    expiresAt: expiresAt.toISOString(),
    user: {
      id:    user.id,
      email: user.email,
      name:  user.name,
      plan:  user.plan,
    },
  })
}
