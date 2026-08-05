import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { db } from '@/lib/db'

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('feature_flags.approve', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { id } = await context.params
  const payload = await request.json().catch(() => null) as { reason?: unknown; version?: unknown } | null
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  const version = typeof payload?.version === 'number' ? payload.version : -1
  if (reason.length < 10 || reason.length > 500 || !Number.isInteger(version) || !request.headers.get('idempotency-key')) return NextResponse.json({ error: 'Invalid approval request' }, { status: 400 })
  const flag = await db.platformFeatureFlag.findUnique({ where: { id }, select: { createdById: true } })
  if (!flag) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (flag.createdById === actor.userId) return NextResponse.json({ error: 'Creator cannot approve this flag' }, { status: 403 })
  const key = request.headers.get('idempotency-key') as string
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'feature_flag.approved', idempotencyKey: key, targetId: id, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'feature_flag', targetId: id, reason, outcome: 'success' }, mutate: (tx) => tx.platformFeatureFlag.updateMany({ where: { id, status: 'pending_approval', version }, data: { status: 'active', approvedById: actor.userId, updatedById: actor.userId, version: { increment: 1 } } }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  const updated = result.value
  if (!updated.count) return NextResponse.json({ error: 'Flag changed or is not pending approval' }, { status: 409 })
  return NextResponse.json({ flag: { id, status: 'active', version: version + 1 } }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
