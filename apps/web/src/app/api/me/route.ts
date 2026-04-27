/**
 * GET   /api/me  — current user profile
 * PATCH /api/me  — update name / image
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'

export async function GET() {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const user = await db.user.findUnique({
    where: { id: auth.userId },
    select: { id: true, email: true, name: true, image: true, plan: true, createdAt: true },
  })

  if (!user) return err('User not found', 404)
  return ok(user)
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { name, image } = body
  const data: Record<string, unknown> = {}
  if (name  !== undefined) data.name  = name
  if (image !== undefined) data.image = image

  const user = await db.user.update({
    where: { id: auth.userId },
    data,
    select: { id: true, email: true, name: true, image: true, plan: true },
  })

  return ok(user)
}
