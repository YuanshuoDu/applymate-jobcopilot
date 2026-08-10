import { NextRequest, NextResponse } from 'next/server'
import { advanceSubscriptionLifecycle } from '@/lib/subscription-lifecycle'

function authorized(request: NextRequest): boolean {
  const expected = process.env.WEB_MAINTENANCE_CRON_SECRET ?? process.env.CRON_SECRET
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  return Boolean(expected && supplied && supplied === expected)
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json({ result: await advanceSubscriptionLifecycle() }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function GET(request: NextRequest) { return POST(request) }
