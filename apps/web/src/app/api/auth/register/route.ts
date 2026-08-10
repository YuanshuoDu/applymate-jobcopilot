/**
 * POST /api/auth/register — create a new account with email + password
 */
import { NextRequest } from 'next/server'
import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'
import { ok, err } from '@/lib/api-helpers'
import { normalizeEmail } from '@/lib/auth-identifiers'
import { checkAuthRateLimit } from '@/lib/auth-rate-limit'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const password = typeof body.password === 'string' ? body.password : ''
  const name = body.name === undefined || body.name === null ? null : typeof body.name === 'string' ? body.name.trim() : ''
  const email = typeof body.email === 'string' ? normalizeEmail(body.email) : ''
  if (!email || !password || (body.name !== undefined && body.name !== null && !name)) return err('email and password are required')
  const rate = await checkAuthRateLimit(req, 'register', email, { ipLimit: 10, identityLimit: 3, windowMs: 60 * 60_000 })
  if (!rate.ok) return err(rate.unavailable ? 'Authentication service temporarily unavailable' : 'Too many requests — retry later', rate.unavailable ? 503 : 429)
  if (password.length < 8)  return err('Password must be at least 8 characters')
  if (password.length > 256 || email.length > 320 || (name && name.length > 120)) return err('Registration details are too long')

  const existing = await db.user.findUnique({ where: { email } })
  if (existing) return err('Email already registered', 409)

  const hashed = await bcrypt.hash(password, 12)
  const user = await db.user.create({
    data: { email, name, password: hashed },
    select: { id: true, email: true, name: true, plan: true, createdAt: true },
  })

  return ok(user, 201)
}
