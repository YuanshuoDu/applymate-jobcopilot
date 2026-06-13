/**
 * PATCH  /api/directions/[id] — update a direction
 * DELETE /api/directions/[id] — delete a direction (returns 204)
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'

async function getOwned(auth: { userId: string }, id: string) {
  return db.direction.findFirst({
    where: { id, userId: auth.userId },
  })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const { id } = await params
  const existing = await getOwned(auth, id)
  if (!existing) return err('Direction not found', 404)

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { name, color, icon, sortOrder } = body

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) return err('name cannot be empty')
    if (name.trim().length > 100) return err('name must be ≤ 100 characters', 422)
  }

  try {
    const updated = await db.direction.update({
      where: { id },
      data: {
        ...(name      !== undefined && { name:      name.trim() }),
        ...(color     !== undefined && { color }),
        ...(icon      !== undefined && { icon }),
        ...(sortOrder !== undefined && { sortOrder }),
      },
      include: { _count: { select: { resumes: true } } },
    })
    return ok(updated)
  } catch (e: unknown) {
    if (typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'P2002') {
      return err('A direction with that name already exists', 409)
    }
    throw e
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const { id } = await params
  const existing = await getOwned(auth, id)
  if (!existing) return err('Direction not found', 404)

  await db.direction.delete({ where: { id } })

  return new NextResponse(null, { status: 204 })
}
