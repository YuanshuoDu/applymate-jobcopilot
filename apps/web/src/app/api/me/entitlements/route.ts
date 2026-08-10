import { NextRequest, NextResponse } from 'next/server'
import { isErrorResponse, requireAuth } from '@/lib/api-helpers'
import { getEffectiveEntitlements } from '@/lib/entitlements'

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth
  return NextResponse.json(await getEffectiveEntitlements(auth.userId), { headers: { 'Cache-Control': 'no-store' } })
}
