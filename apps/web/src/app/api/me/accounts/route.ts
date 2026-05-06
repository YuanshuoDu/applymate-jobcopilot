/**
 * GET /api/me/accounts — list connected OAuth providers for the current user
 */
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok } from '@/lib/api-helpers'

export async function GET() {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const accounts = await db.account.findMany({
    where: { userId: auth.userId },
    select: { provider: true, providerAccountId: true },
  })

  // Map provider IDs to friendly names
  const connected = accounts.map(a => ({
    provider: a.provider,
    account:  a.providerAccountId,
  }))

  return ok({ accounts: connected })
}
