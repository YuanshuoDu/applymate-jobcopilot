import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { audienceWhere, storedAudience } from '@/lib/admin/broadcast-service'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { db } from '@/lib/db'

const RECIPIENT_BATCH_SIZE = 500

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('broadcasts.publish', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { id } = await context.params
  const payload = await request.json().catch(() => null) as { reason?: unknown; confirmation?: unknown } | null
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  const idempotencyKey = request.headers.get('idempotency-key')
  if (payload?.confirmation !== 'publish' || reason.length < 10 || reason.length > 500 || !idempotencyKey) return NextResponse.json({ error: 'A confirmed publish request is required' }, { status: 400 })
  const broadcast = await db.adminBroadcast.findUnique({ where: { id }, select: { title: true, body: true, audienceType: true, audience: true, status: true, approvedById: true, publishIdempotencyKey: true } })
  if (!broadcast) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (broadcast.status === 'published' && broadcast.publishIdempotencyKey === idempotencyKey) return NextResponse.json({ broadcast: { id, status: 'published' }, duplicate: true })
  const audience = storedAudience(broadcast.audience, broadcast.audienceType)
  if (!audience || !broadcast.approvedById || broadcast.status !== 'draft') return NextResponse.json({ error: 'Broadcast must be approved before publishing' }, { status: 409 })
  const where = audienceWhere(audience)
  const recipientCount = await db.user.count({ where })
  const claimResult = await runAdminMutation({ actorUserId: actor.userId, action: 'broadcast.publish_started', idempotencyKey, targetId: id, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'broadcast', targetId: id, reason, outcome: 'success' }, mutate: (tx) => tx.adminBroadcast.updateMany({ where: { id, status: 'draft', approvedById: { not: null } }, data: { status: 'publishing', publishIdempotencyKey: idempotencyKey, publishedById: actor.userId, recipientCount } }) })
  if (claimResult.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  const claimed = claimResult.value
  if (!claimed.count) return NextResponse.json({ error: 'Broadcast is already being processed' }, { status: 409 })
  let cursor: string | undefined
  let deliveredCount = 0
  try {
    while (true) {
      const recipients = await db.user.findMany({ where, select: { id: true }, orderBy: { id: 'asc' }, cursor: cursor ? { id: cursor } : undefined, skip: cursor ? 1 : undefined, take: RECIPIENT_BATCH_SIZE })
      if (!recipients.length) break
      await db.adminBroadcastDelivery.createMany({ data: recipients.map((recipient) => ({ broadcastId: id, userId: recipient.id, status: 'pending' })), skipDuplicates: true })
      await db.notification.createMany({ data: recipients.map((recipient) => ({ userId: recipient.id, broadcastId: id, type: 'platform_broadcast', title: broadcast.title, body: broadcast.body })), skipDuplicates: true })
      const delivered = await db.adminBroadcastDelivery.updateMany({ where: { broadcastId: id, userId: { in: recipients.map(recipient => recipient.id) } }, data: { status: 'delivered', deliveredAt: new Date(), attempts: { increment: 1 }, error: null } })
      deliveredCount += delivered.count
      cursor = recipients[recipients.length - 1]?.id
      if (recipients.length < RECIPIENT_BATCH_SIZE) break
    }
    const published = await db.adminBroadcast.update({ where: { id }, data: { status: 'published', deliveredCount: { increment: deliveredCount } }, select: { id: true, status: true, recipientCount: true, deliveredCount: true } })
    return NextResponse.json({ broadcast: published }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
  } catch {
    const failed = await db.adminBroadcastDelivery.updateMany({ where: { broadcastId: id, status: 'pending' }, data: { status: 'failed', attempts: { increment: 1 }, error: 'Broadcast delivery failed' } }).catch(() => ({ count: 0 }))
    await db.adminBroadcast.update({ where: { id }, data: { status: 'failed', failedCount: { increment: failed.count } } }).catch(() => undefined)
    return NextResponse.json({ error: 'Broadcast delivery failed' }, { status: 500 })
  }
}
