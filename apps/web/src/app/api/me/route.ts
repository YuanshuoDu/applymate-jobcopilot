/**
 * GET   /api/me  — current user profile
 * PATCH /api/me  — update profile fields (name, phone, location, linkedin, github, preferences)
 */
import { NextRequest } from 'next/server'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { mergeUserPreferences, sanitizeUserPreferences, validateAvatarValue, validateUserProfilePatch } from '@/lib/settings-preferences'

function safeProfile<T extends { preferences: unknown }>(user: T): T {
  return { ...user, preferences: sanitizeUserPreferences(user.preferences) }
}

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
  return ok(safeProfile(user))
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const validation = validateUserProfilePatch(body)
  if (!validation.valid) return err(validation.error)

  const allowed = ['name', 'phone', 'location', 'linkedin', 'github', 'preferences', 'image']
  const data: Record<string, unknown> = {}
  for (const key of allowed) {
    if (body[key] !== undefined) data[key] = body[key]
  }

  if (Object.keys(data).length === 0) return err('No valid fields to update')

  if (body.image !== undefined) {
    const avatar = validateAvatarValue(body.image)
    if (!avatar.valid) return err(avatar.error)
  }

  if (body.preferences !== undefined) {
    const current = await db.user.findUnique({
      where: { id: auth.userId },
      select: { preferences: true },
    })
    if (!current) return err('User not found', 404)
    data.preferences = mergeUserPreferences(current.preferences, body.preferences) as Prisma.InputJsonValue
  }

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

  return ok(safeProfile(user))
}
