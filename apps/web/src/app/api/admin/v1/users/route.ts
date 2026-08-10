import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { adminUserMetadataSelect, toAdminUserMetadata } from '@/lib/admin/dto'
import { adminPageLimit, pageResult } from '@/lib/admin/pagination'
import { db } from '@/lib/db'
import { Plan, UserAccountStatus, type Prisma } from '@prisma/client'

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('users.read', request)
  if (isAdminResponse(actor)) return actor
  const params = new URL(request.url).searchParams
  const limit = adminPageLimit(params.get('limit'))
  const cursor = params.get('cursor')
  const search = params.get('q')?.trim().slice(0, 100)
  const planValue = params.get('plan')
  const plan = planValue === 'free' || planValue === 'pro' || planValue === 'enterprise' ? planValue as Plan : undefined
  const statusValue = params.get('status')
  const accountStatus = statusValue === 'active' || statusValue === 'suspended' ? statusValue as UserAccountStatus : undefined
  const sort = params.get('sort')
  const direction = params.get('direction') === 'desc' ? 'desc' : 'asc'
  const orderBy: Prisma.UserOrderByWithRelationInput = sort === 'createdAt' ? { createdAt: direction } : sort === 'name' ? { name: direction } : sort === 'plan' ? { plan: direction } : sort === 'accountStatus' ? { accountStatus: direction } : { id: 'asc' }
  const rows = await db.user.findMany({
    where: { ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { email: { contains: search, mode: 'insensitive' } }] } : {}), ...(plan ? { plan } : {}), ...(accountStatus ? { accountStatus } : {}) },
    select: adminUserMetadataSelect,
    orderBy,
    cursor: cursor ? { id: cursor } : undefined,
    skip: cursor ? 1 : undefined,
    take: limit + 1,
  })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'users.list_viewed', outcome: 'success' })
  const page = pageResult(rows.map(toAdminUserMetadata), limit)
  return NextResponse.json(page, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
