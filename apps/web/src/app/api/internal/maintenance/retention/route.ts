import { NextRequest, NextResponse } from 'next/server'
import { purgeRetainedDeletionRecords } from '@/lib/admin/retention'

function authorized(request: NextRequest) {
  const authorization = request.headers.get('authorization')
  const secrets = [process.env.WEB_MAINTENANCE_CRON_SECRET, process.env.CRON_SECRET].filter((value): value is string => Boolean(value?.trim()))
  return secrets.some(secret => authorization === `Bearer ${secret}`)
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const result = await purgeRetainedDeletionRecords()
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
}

export async function GET(request: NextRequest) {
  return POST(request)
}
