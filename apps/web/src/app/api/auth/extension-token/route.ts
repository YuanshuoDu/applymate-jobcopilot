/**
 * POST /api/auth/extension-token
 * Chrome Extension 专用登录接口
 * 验证邮箱密码后返回可用于 Bearer 认证的长效 JWT
 */
import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { SignJWT } from 'jose'
import { db } from '@/lib/db'

const JWT_SECRET = new TextEncoder().encode(
  process.env.AUTH_SECRET ?? 'fallback-secret-change-this',
)

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body?.email || !body?.password) {
    return NextResponse.json({ error: 'email and password required' }, { status: 400 })
  }

  const user = await db.user.findUnique({ where: { email: body.email } })
  if (!user?.password) {
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
  })
    .setProtectedHeader({ alg: 'HS256' })
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
