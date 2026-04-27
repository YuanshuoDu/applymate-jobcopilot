import { auth } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/** Get authenticated userId — supports both NextAuth session and Extension Bearer token */
export async function requireAuth(
  req?: NextRequest,
): Promise<{ userId: string } | NextResponse> {
  // 1. Extension Bearer token (injected as x-user-id by middleware)
  if (req) {
    const uid = req.headers.get('x-user-id')
    if (uid) return { userId: uid }
  }

  // 2. NextAuth session (web app)
  const session = await auth()
  if (session?.user?.id) return { userId: session.user.id }

  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

export function isErrorResponse(val: unknown): val is NextResponse {
  return val instanceof NextResponse
}

export function ok<T>(data: T, status = 200) {
  return NextResponse.json(data, { status })
}

export function err(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}
