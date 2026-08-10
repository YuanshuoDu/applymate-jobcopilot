import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { getDeletionRetentionPolicy, RETENTION_POLICY_KEY } from '@/lib/admin/retention'
import { db } from '@/lib/db'

const MAX_RETENTION_DAYS = 3_650

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('users.deletion.manage', request)
  if (isAdminResponse(actor)) return actor
  const policy = await getDeletionRetentionPolicy()
  return NextResponse.json({ policy }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

export async function PATCH(request: NextRequest) {
  const actor = await requireAdmin('users.deletion.manage', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const body = await request.json().catch(() => null) as { key?: unknown; retentionDays?: unknown; enabled?: unknown; version?: unknown; reason?: unknown } | null
  const key = body?.key === RETENTION_POLICY_KEY ? RETENTION_POLICY_KEY : ''
  const retentionDays = body?.retentionDays
  const enabled = body?.enabled
  const version = body?.version
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? ''
  if (!key || !Number.isInteger(retentionDays) || Number(retentionDays) < 1 || Number(retentionDays) > MAX_RETENTION_DAYS || typeof enabled !== 'boolean' || !Number.isInteger(version) || reason.length < 10 || reason.length > 500 || !idempotencyKey) {
    return NextResponse.json({ error: 'key, retentionDays, enabled, version, reason and Idempotency-Key are required' }, { status: 400 })
  }
  const current = await db.dataRetentionPolicy.findUnique({ where: { key } })
  if (current && current.version !== version) return NextResponse.json({ error: 'Retention policy changed; refresh before saving' }, { status: 409 })
  const days = retentionDays as number
  const nextEnabled = enabled as boolean
  const expectedVersion = version as number
  const result = await runAdminMutation({
    actorUserId: actor.userId,
    action: 'data_retention.policy_updated',
    idempotencyKey,
    targetId: key,
    audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, reason, outcome: 'success', after: { key, retentionDays: days, enabled: nextEnabled, version: current ? current.version + 1 : expectedVersion } },
    mutate: tx => current
      ? tx.dataRetentionPolicy.update({ where: { key, version: current.version }, data: { retentionDays: days, enabled: nextEnabled, updatedById: actor.userId, version: { increment: 1 } } })
      : tx.dataRetentionPolicy.create({ data: { key, name: 'Completed deletion queue records', retentionDays: days, enabled: nextEnabled, updatedById: actor.userId } }),
  })
  if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  return NextResponse.json({ policy: result.value }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
