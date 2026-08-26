import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { adminPageLimit, pageResult } from '@/lib/admin/pagination'
import { POLICIES } from '@/lib/agent/pace/policies'
import { isManagedAtsRegistrySource, MANAGED_ATS_REGISTRY_SOURCES } from '@/lib/admin/ats-service'
import { db } from '@/lib/db'
import type { Prisma } from '@prisma/client'

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('ats.read', request)
  if (isAdminResponse(actor)) return actor
  const params = new URL(request.url).searchParams
  const limit = adminPageLimit(params.get('limit'))
  const cursorValue = params.get('cursor')
  const cursor = cursorValue && /^\d+$/.test(cursorValue) ? Number(cursorValue) : undefined
  const sort = params.get('sort')
  const direction = params.get('direction') === 'desc' ? 'desc' : 'asc'
  const query = params.get('q')?.trim().slice(0, 160) ?? ''
  const atsType = params.get('atsType')?.trim().toLowerCase() ?? ''
  const enabled = params.get('enabled')
  if (atsType && !isManagedAtsRegistrySource(atsType)) return NextResponse.json({ error: 'Employer registry is managed only for Greenhouse and Lever' }, { status: 400 })
  if (enabled && !['true', 'false'].includes(enabled)) return NextResponse.json({ error: 'Invalid registry state' }, { status: 400 })
  const where: Prisma.AtsEmployerWhereInput = {
    atsType: atsType || { in: [...MANAGED_ATS_REGISTRY_SOURCES] },
    ...(enabled ? { enabled: enabled === 'true' } : {}),
    ...(query ? { OR: [
      { name: { contains: query, mode: 'insensitive' } },
      { slug: { contains: query, mode: 'insensitive' } },
      { country: { contains: query, mode: 'insensitive' } },
    ] } : {}),
  }
  const primaryOrder: Prisma.AtsEmployerOrderByWithRelationInput = sort === 'lastSeen'
    ? { lastSeen: direction }
    : sort === 'jobCount'
      ? { jobCount: direction }
      : sort === 'name'
        ? { name: direction }
        : sort === 'source'
          ? { atsType: direction }
          : { id: 'asc' }
  const rows = await db.atsEmployer.findMany({
    where,
    select: { id: true, atsType: true, slug: true, name: true, country: true, enabled: true, version: true, firstSeen: true, lastSeen: true, jobCount: true, createdAt: true, updatedAt: true },
    orderBy: [primaryOrder, { id: 'asc' }], cursor: cursor ? { id: cursor } : undefined, skip: cursor ? 1 : undefined, take: limit + 1,
  })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'ats.registry_viewed', outcome: 'success' })
  const page = pageResult(rows.map((row) => ({
    ...row,
    rateLimitRps: POLICIES[row.atsType]?.rps ?? null,
    credentialRequirement: 'none',
    runtimeManaged: isManagedAtsRegistrySource(row.atsType),
  })), limit)
  return NextResponse.json(page, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
