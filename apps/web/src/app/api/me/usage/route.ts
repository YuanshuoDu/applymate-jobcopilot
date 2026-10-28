import { NextRequest, NextResponse } from 'next/server'
import { isErrorResponse, requireAuth } from '@/lib/api-helpers'
import { db } from '@/lib/db'
import { runWithTenantContext } from '@/lib/db/tenant-store'
import { readPersonalUsage, type PersonalUsageDays } from '@/lib/personal-usage'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'no-store' }

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) {
    auth.headers.set('Cache-Control', 'no-store')
    return auth
  }
  const values = new URL(request.url).searchParams.getAll('days')
  if (values.length > 1 || (values.length === 1 && values[0] !== '7' && values[0] !== '30')) {
    return NextResponse.json({ error: 'Choose a 7 or 30 day usage window' }, { status: 400, headers })
  }
  const days: PersonalUsageDays = values[0] === '7' ? 7 : 30
  try {
    // Never take an owner from query parameters. The transaction also applies
    // tenant RLS when enabled; the query retains its explicit owner predicate.
    const usage = await runWithTenantContext(auth.userId, () => db.$transaction(tx =>
      readPersonalUsage(tx, auth.userId, days),
    ))
    return NextResponse.json(usage, { headers })
  } catch {
    return NextResponse.json({ error: 'Usage data is temporarily unavailable' }, { status: 503, headers })
  }
}
