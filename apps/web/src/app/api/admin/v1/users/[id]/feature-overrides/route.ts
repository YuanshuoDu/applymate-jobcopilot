import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { parseFeatureOverride, reasonFrom } from '@/lib/admin/user-lifecycle'
import { db } from '@/lib/db'

type Params = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const actor = await requireAdmin('users.read', request)
  if (isAdminResponse(actor)) return actor
  const { id } = await params
  const items = await db.userFeatureOverride.findMany({ where: { userId: id }, orderBy: { featureKey: 'asc' }, select: { id: true, featureKey: true, enabled: true, limit: true, expiresAt: true, reason: true, actorUserId: true, createdAt: true, updatedAt: true } })
  return NextResponse.json({ items }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const actor = await requireAdmin('users.feature_override', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const parsed = parseFeatureOverride(body)
  const reason = reasonFrom(body?.reason, 'reason')
  const idempotencyKey = request.headers.get('idempotency-key')
  if ('error' in parsed || typeof reason !== 'string' || !idempotencyKey) return NextResponse.json({ error: 'error' in parsed ? parsed.error : typeof reason === 'string' ? 'Idempotency-Key is required' : reason.error }, { status: 400 })
  const { id } = await params
  const exists = await db.user.findUnique({ where: { id }, select: { id: true } })
  if (!exists) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  const result = await runAdminMutation({
    actorUserId: actor.userId,
    action: 'users.feature_override_updated',
    idempotencyKey,
    targetId: id,
    audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'user', targetId: id, tenantUserId: id, reason, outcome: 'success', after: { featureKey: parsed.featureKey, enabled: parsed.enabled, limit: parsed.limit, expiresAt: parsed.expiresAt } },
    mutate: (tx) => tx.userFeatureOverride.upsert({ where: { userId_featureKey: { userId: id, featureKey: parsed.featureKey } }, create: { userId: id, ...parsed, reason, actorUserId: actor.userId }, update: { ...parsed, reason, actorUserId: actor.userId } }),
  })
  if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  return NextResponse.json({ item: result.value }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const actor = await requireAdmin('users.feature_override', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const featureKey = request.nextUrl.searchParams.get('featureKey')?.trim() ?? ''
  const reason = reasonFrom(request.nextUrl.searchParams.get('reason'), 'reason')
  const idempotencyKey = request.headers.get('idempotency-key')
  if (!featureKey || typeof reason !== 'string' || !idempotencyKey) return NextResponse.json({ error: typeof reason === 'string' ? 'featureKey, reason and Idempotency-Key are required' : reason.error }, { status: 400 })
  const { id } = await params
  const result = await runAdminMutation({
    actorUserId: actor.userId,
    action: 'users.feature_override_removed',
    idempotencyKey,
    targetId: id,
    audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'user', targetId: id, tenantUserId: id, reason, outcome: 'success', after: { featureKey, removed: true } },
    mutate: (tx) => tx.userFeatureOverride.deleteMany({ where: { userId: id, featureKey } }),
  })
  if (result.duplicate) return NextResponse.json({ duplicate: true })
  return NextResponse.json({ removed: result.value.count }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
