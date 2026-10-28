import { NextRequest, NextResponse } from 'next/server'
import { isErrorResponse, requireAuth } from '@/lib/api-helpers'
import { db } from '@/lib/db'
import { runWithTenantContext } from '@/lib/db/tenant-store'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'no-store' }

/** Recent Activity records for the signed-in account, not a complete audit trail. */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request)
    if (isErrorResponse(auth)) {
      auth.headers.set('Cache-Control', 'no-store')
      return auth
    }

    const records = await runWithTenantContext(auth.userId, () => db.$transaction(tx =>
      tx.activity.findMany({
        where: { userId: auth.userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 12,
        select: { id: true, text: true, createdAt: true },
      }),
    ))
    return NextResponse.json({ ownerId: auth.userId, items: records.map(({ id, text, createdAt }) => ({ id, text, createdAt })) }, { headers })
  } catch {
    return NextResponse.json({ error: 'Activity is temporarily unavailable' }, { status: 503, headers })
  }
}
