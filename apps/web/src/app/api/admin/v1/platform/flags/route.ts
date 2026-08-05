import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { parseFeatureFlag } from '@/lib/admin/feature-flags'
import { adminPageLimit, pageResult } from '@/lib/admin/pagination'
import { db } from '@/lib/db'

const flagSelect = { id: true, key: true, environment: true, enabled: true, rolloutPercent: true, targetPlans: true, targetUserIds: true, status: true, version: true, createdById: true, approvedById: true, rollbackAt: true, updatedAt: true } as const

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('feature_flags.read', request)
  if (isAdminResponse(actor)) return actor
  const params = new URL(request.url).searchParams
  const limit = adminPageLimit(params.get('limit'))
  const cursor = params.get('cursor')
  const rows = await db.platformFeatureFlag.findMany({ select: flagSelect, orderBy: { id: 'desc' }, cursor: cursor ? { id: cursor } : undefined, skip: cursor ? 1 : undefined, take: limit + 1 })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'feature_flags.list_viewed', outcome: 'success' })
  return NextResponse.json(pageResult(rows, limit), { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

export async function POST(request: NextRequest) {
  const actor = await requireAdmin('feature_flags.update', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const payload = await request.json().catch(() => null) as { reason?: unknown } | null
  const input = parseFeatureFlag(payload)
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  if (!input || reason.length < 10 || reason.length > 500 || !request.headers.get('idempotency-key')) return NextResponse.json({ error: 'Invalid feature flag' }, { status: 400 })
  const existing = await db.platformFeatureFlag.findUnique({ where: { key_environment: { key: input.key, environment: input.environment } }, select: { id: true } })
  if (existing) return NextResponse.json({ error: 'A flag already exists for this environment' }, { status: 409 })
  const key = request.headers.get('idempotency-key') as string
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'feature_flag.created', idempotencyKey: key, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'feature_flag', reason, outcome: 'success' }, mutate: (tx) => tx.platformFeatureFlag.create({ data: { ...input, createdById: actor.userId, updatedById: actor.userId }, select: flagSelect }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  const flag = result.value
  return NextResponse.json({ flag }, { status: 201, headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
