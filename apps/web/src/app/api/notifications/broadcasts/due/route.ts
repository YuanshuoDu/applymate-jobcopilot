import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audienceWhere, storedAudience } from '@/lib/admin/broadcast-service'
import { writeAdminAudit } from '@/lib/admin/audit'

const BATCH_SIZE = 500

function authorized(request: NextRequest) {
  const authorization = request.headers.get('authorization')
  const secrets = [process.env.WEB_MAINTENANCE_CRON_SECRET, process.env.CRON_SECRET, process.env.AGENT_AUTOMATION_CRON_SECRET].filter((value): value is string => Boolean(value?.trim()))
  return secrets.some(secret => authorization === `Bearer ${secret}`)
}

async function processDue(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const due = await db.adminBroadcast.findMany({ where: { status: 'scheduled', scheduledAt: { lte: new Date() } }, take: 20, orderBy: { scheduledAt: 'asc' }, select: { id: true, title: true, body: true, audienceType: true, audience: true } })
  const processed: Array<{ id: string; status: string; deliveredCount?: number }> = []
  for (const item of due) {
    const claimed = await db.adminBroadcast.updateMany({ where: { id: item.id, status: 'scheduled' }, data: { status: 'publishing' } })
    if (!claimed.count) continue
    try {
      const audience = storedAudience(item.audience, item.audienceType)
      if (!audience) throw new Error('Invalid broadcast audience')
      const where = audienceWhere(audience)
      const recipientCount = await db.user.count({ where })
      let cursor: string | undefined
      let deliveredCount = 0
      while (true) {
        const recipients = await db.user.findMany({ where, select: { id: true }, orderBy: { id: 'asc' }, cursor: cursor ? { id: cursor } : undefined, skip: cursor ? 1 : undefined, take: BATCH_SIZE })
        if (!recipients.length) break
        const created = await db.notification.createMany({ data: recipients.map(recipient => ({ userId: recipient.id, broadcastId: item.id, type: 'platform_broadcast', title: item.title, body: item.body })), skipDuplicates: true })
        deliveredCount += created.count
        cursor = recipients[recipients.length - 1]?.id
        if (recipients.length < BATCH_SIZE) break
      }
      await db.adminBroadcast.update({ where: { id: item.id }, data: { status: 'published', recipientCount, deliveredCount: { increment: deliveredCount } } })
      processed.push({ id: item.id, status: 'published', deliveredCount })
    } catch {
      await db.adminBroadcast.update({ where: { id: item.id }, data: { status: 'failed' } })
      processed.push({ id: item.id, status: 'failed' })
    }
  }
  await writeAdminAudit({ requestId: 'broadcast-cron', action: 'broadcasts.due_processed', targetType: 'broadcast', outcome: 'success', after: { count: processed.length } }).catch(() => undefined)
  return NextResponse.json({ processed })
}

export async function GET(request: NextRequest) {
  return processDue(request)
}

export async function POST(request: NextRequest) {
  return processDue(request)
}
