import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { writeAdminAudit } from '@/lib/admin/audit'
import { parseBroadcastInput } from '@/lib/admin/broadcast-service'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { adminPageLimit, pageResult } from '@/lib/admin/pagination'
import { db } from '@/lib/db'

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('broadcasts.create', request)
  if (isAdminResponse(actor)) return actor
  const params = new URL(request.url).searchParams
  const limit = adminPageLimit(params.get('limit'))
  const cursor = params.get('cursor')
  const rows = await db.adminBroadcast.findMany({
    select: { id: true, title: true, body: true, audienceType: true, status: true, approvedById: true, recipientCount: true, deliveredCount: true, failedCount: true, scheduledAt: true, createdAt: true, updatedAt: true },
    orderBy: { id: 'desc' }, cursor: cursor ? { id: cursor } : undefined, skip: cursor ? 1 : undefined, take: limit + 1,
  })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'broadcasts.list_viewed', outcome: 'success' })
  return NextResponse.json(pageResult(rows, limit), { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

export async function POST(request: NextRequest) {
  const actor = await requireAdmin('broadcasts.create', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const idempotencyKey = request.headers.get('idempotency-key')
  const payload = await request.json().catch(() => null) as { reason?: unknown } | null
  const input = parseBroadcastInput(payload)
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  if (!input || !idempotencyKey || reason.length < 10 || reason.length > 500) return NextResponse.json({ error: 'Invalid broadcast draft' }, { status: 400 })
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'broadcast.created', idempotencyKey, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'broadcast', reason, outcome: 'success' }, mutate: (tx) => tx.adminBroadcast.create({ data: { title: input.title, body: input.body, audienceType: input.audience.type, audience: input.audience.value, createdById: actor.userId, createIdempotencyKey: idempotencyKey }, select: { id: true, status: true, createdAt: true } }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true })
  const broadcast = result.value
  return NextResponse.json({ broadcast }, { status: 201, headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
