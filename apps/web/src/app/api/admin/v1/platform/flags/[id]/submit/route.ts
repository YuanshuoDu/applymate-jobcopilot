import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { db } from '@/lib/db'

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('feature_flags.update', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { id } = await context.params
  const payload = await request.json().catch(() => null) as { reason?: unknown; version?: unknown } | null
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  const version = typeof payload?.version === 'number' ? payload.version : -1
  if (reason.length < 10 || reason.length > 500 || !Number.isInteger(version) || !request.headers.get('idempotency-key')) return NextResponse.json({ error: 'Invalid approval submission' }, { status: 400 })
  const updated = await db.platformFeatureFlag.updateMany({ where: { id, status: 'draft', version }, data: { status: 'pending_approval', version: { increment: 1 }, updatedById: actor.userId } })
  if (!updated.count) return NextResponse.json({ error: 'Flag changed or is not a draft' }, { status: 409 })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'feature_flag.submitted', targetType: 'feature_flag', targetId: id, reason, outcome: 'success' })
  return NextResponse.json({ flag: { id, status: 'pending_approval', version: version + 1 } }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
