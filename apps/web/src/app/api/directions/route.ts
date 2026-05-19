/**
 * GET  /api/directions — list directions for current user
 * POST /api/directions — create a new direction
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'

export async function GET() {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const directions = await db.direction.findMany({
    where:   { userId: auth.userId },
    orderBy: { sortOrder: 'asc' },
    include: { _count: { select: { resumes: true } } },
  })

  return ok(directions)
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { name, color, icon } = body
  if (!name || typeof name !== 'string' || !name.trim()) return err('name is required')
  if (name.trim().length > 100) return err('name must be ≤ 100 characters', 422)

  // Determine next sortOrder
  const last = await db.direction.findFirst({
    where:   { userId: auth.userId },
    orderBy: { sortOrder: 'desc' },
    select:  { sortOrder: true },
  })
  const sortOrder = (last?.sortOrder ?? -1) + 1

  try {
    const direction = await db.direction.create({
      data: {
        userId:    auth.userId,
        name:      name.trim(),
        color:     color ?? null,
        icon:      icon  ?? null,
        sortOrder,
      },
      include: { _count: { select: { resumes: true } } },
    })
    return ok(direction, 201)
  } catch (e: unknown) {
    // Prisma unique constraint violation
    if (typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'P2002') {
      return err('A direction with that name already exists', 409)
    }
    throw e
  }
}
