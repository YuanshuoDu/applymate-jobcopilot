/**
 * GET   /api/me  — current user profile
 * PATCH /api/me  — update profile fields (name, phone, location, linkedin, github, preferences)
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'

export async function GET() {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const user = await db.user.findUnique({
    where: { id: auth.userId },
    select: {
      id: true, email: true, name: true, image: true, plan: true,
      phone: true, location: true, linkedin: true, github: true,
      preferences: true, createdAt: true, onboardedAt: true, onboardingGoals: true,
    },
  })

  if (!user) return err('User not found', 404)
  return ok(user)
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const allowed = ['name', 'phone', 'location', 'linkedin', 'github', 'preferences', 'image']
  const data: Record<string, unknown> = {}
  for (const key of allowed) {
    if (body[key] !== undefined) data[key] = body[key]
  }

  if (Object.keys(data).length === 0) return err('No valid fields to update')

  const user = await db.user.update({
    where: { id: auth.userId },
    data,
    select: {
      id: true, email: true, name: true, image: true, plan: true,
      phone: true, location: true, linkedin: true, github: true,
      preferences: true, createdAt: true,
      onboardedAt: true, onboardingGoals: true,
    },
  })

  return ok(user)
}
