/**
 * POST /api/auth/register — create a new account with email + password
 */
import { NextRequest } from 'next/server'
import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'
import { ok, err } from '@/lib/api-helpers'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { email, password, name } = body
  if (!email || !password) return err('email and password are required')
  if (password.length < 8)  return err('Password must be at least 8 characters')

  const existing = await db.user.findUnique({ where: { email } })
  if (existing) return err('Email already registered', 409)

  const hashed = await bcrypt.hash(password, 12)
  const user = await db.user.create({
    data: { email, name: name ?? null, password: hashed },
    select: { id: true, email: true, name: true, plan: true, createdAt: true },
  })

  return ok(user, 201)
}
