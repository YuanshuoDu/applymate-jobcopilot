import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/admin/authorization'
import { storedAudience } from '@/lib/admin/broadcast'
import { broadcastWhere } from '@/lib/admin/broadcast'
import { adminError, adminJson, requestId } from '@/lib/admin/route-utils'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestId(request)
  try { await requireAdmin('broadcasts.preview', request); const { id } = await context.params; const broadcast = await db.adminBroadcast.findUnique({ where: { id }, select: { id: true, audienceType: true, audience: true } }); if (!broadcast) return adminJson({ error: 'BROADCAST_NOT_FOUND' }, 404, correlationId); const audience = storedAudience(broadcast); const where = broadcastWhere(audience); const recipientCount = await db.user.count({ where }); const planGroups = await db.user.groupBy({ by: ['plan'], where, _count: { _all: true } }); const locationGroups = await db.user.groupBy({ by: ['location'], where, _count: { _all: true } }); return adminJson({ recipientCount, planDistribution: planGroups.filter(group => group._count._all >= 20).map(group => ({ plan: group.plan, count: group._count._all })), locationDistribution: locationGroups.filter(group => group._count._all >= 20).map(group => ({ region: group.location ? group.location.split(',').at(-1)?.trim() ?? 'Unknown' : 'Unknown', count: group._count._all })) }, 200, correlationId) } catch (error) { return adminError(error, correlationId) }
}
