import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import type { PersonaField } from '@/lib/persona'
import type { Prisma } from '@prisma/client'

/**
 * GET /api/me/persona/fields — returns saved persona fields
 * POST /api/me/persona/fields — upsert (merge) persona fields
 * DELETE /api/me/persona/fields — delete a field by key
 */

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const user = await db.user.findUnique({
    where: { id: auth.userId },
    select: { personaFields: true },
  })
  const fields = (user?.personaFields ?? []) as unknown as PersonaField[]

  return ok({ fields })
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body?.fields || !Array.isArray(body.fields)) {
    return err('fields array is required')
  }

  const incoming: PersonaField[] = body.fields

  // Fetch existing fields
  const user = await db.user.findUnique({
    where: { id: auth.userId },
    select: { personaFields: true },
  })
  const existing = (user?.personaFields ?? []) as unknown as PersonaField[]

  // Merge: update existing by key, append new
  const map = new Map<string, PersonaField>()
  for (const f of existing) map.set(f.key, f)
  for (const f of incoming) {
    if (!f.key || !f.value) continue
    const now = new Date().toISOString()
    map.set(f.key, { ...f, updatedAt: now })
  }

  const merged = Array.from(map.values())

  await db.user.update({
    where: { id: auth.userId },
    data: { personaFields: merged as unknown as Prisma.InputJsonValue },
  })

  return ok({ fields: merged }, 200)
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body?.key) return err('key is required')

  const user = await db.user.findUnique({
    where: { id: auth.userId },
    select: { personaFields: true },
  })
  const existing = (user?.personaFields ?? []) as unknown as PersonaField[]
  const filtered = existing.filter(f => f.key !== body.key)

  await db.user.update({
    where: { id: auth.userId },
    data: { personaFields: filtered as unknown as Prisma.InputJsonValue },
  })

  return ok({ ok: true })
}
