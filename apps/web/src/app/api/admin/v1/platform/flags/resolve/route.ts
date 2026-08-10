import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { db } from '@/lib/db'

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('feature_flags.read', request)
  if (isAdminResponse(actor)) return actor
  const environment = request.nextUrl.searchParams.get('environment')
  if (!environment || !['development', 'staging', 'production'].includes(environment)) return NextResponse.json({ error: 'Invalid environment' }, { status: 400 })
  const flags = await db.platformFeatureFlag.findMany({ where: { environment, status: 'active', enabled: true }, select: { key: true, rolloutPercent: true, targetPlans: true, version: true, rollbackAt: true } })
  const now = new Date()
  const snapshot = flags.filter((flag) => !flag.rollbackAt || flag.rollbackAt > now).map((flag) => ({ key: flag.key, rolloutPercent: flag.rolloutPercent, targetPlans: flag.targetPlans, version: flag.version }))
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'feature_flags.snapshot_viewed', outcome: 'success' })
  return NextResponse.json({ environment, generatedAt: now, flags: snapshot }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
