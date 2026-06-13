/**
 * GET /api/me/accounts — list connected OAuth providers for the current user
 * DELETE /api/me/accounts — disconnect an OAuth provider
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'

export async function GET() {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const accounts = await db.account.findMany({
    where: { userId: auth.userId },
    select: { provider: true, providerAccountId: true },
  })

  const connected = accounts.map(a => ({
    provider: a.provider,
    account:  a.providerAccountId,
  }))

  return ok({ accounts: connected })
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { provider } = await req.json().catch(() => ({}))
  if (!provider) return err('provider is required', 400)

  await db.account.deleteMany({
    where: { userId: auth.userId, provider },
  })

  return ok({ disconnected: provider })
}
