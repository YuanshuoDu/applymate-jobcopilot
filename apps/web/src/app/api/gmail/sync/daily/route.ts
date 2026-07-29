import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { err, ok } from '@/lib/api-helpers'
import { syncGmailForUser } from '@/lib/gmail-tracking/sync'

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.GMAIL_SYNC_CRON_SECRET ?? process.env.CRON_SECRET
  if (!secret) return process.env.NODE_ENV !== 'production'
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  return bearer === secret || req.headers.get('x-gmail-sync-secret') === secret
}

async function runDailySync(req: NextRequest) {
  if (!isAuthorized(req)) return err('Unauthorized', 401)

  const accounts = await db.account.findMany({
    where: {
      OR: [
        { provider: 'gmail' },
        { provider: 'google', scope: { contains: 'gmail' } },
      ],
    },
    select: { userId: true },
    distinct: ['userId'],
    take: 100,
  })
  const settled = await Promise.allSettled(accounts.map((account) => syncGmailForUser(account.userId)))
  const synced = settled.filter((result) => result.status === 'fulfilled' && result.value.error === null).length
  const recommendations = settled.reduce((total, result) => (
    result.status === 'fulfilled' ? total + result.value.newRecommendations : total
  ), 0)

  return ok({ checked: accounts.length, synced, recommendations })
}

export async function GET(req: NextRequest) {
  return runDailySync(req)
}

export async function POST(req: NextRequest) {
  return runDailySync(req)
}
