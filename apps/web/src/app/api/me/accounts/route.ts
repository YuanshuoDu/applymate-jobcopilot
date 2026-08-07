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
    select: { provider: true, providerAccountId: true, scope: true },
  })

  const connected = new Map<string, { provider: string; account: string; disconnectable?: boolean; legacy?: boolean }>()
  for (const account of accounts) {
    if (account.provider === 'gmail') {
      connected.set(`gmail:${account.providerAccountId}`, {
        provider: 'gmail', account: account.providerAccountId,
      })
      continue
    }
    if (account.provider === 'google' && account.scope?.includes('gmail')) {
      const key = `gmail:${account.providerAccountId}`
      if (!connected.has(key)) {
        connected.set(key, {
          provider: 'gmail', account: account.providerAccountId, disconnectable: false, legacy: true,
        })
      }
      continue
    }
    connected.set(`${account.provider}:${account.providerAccountId}`, {
      provider: account.provider, account: account.providerAccountId,
    })
  }

  return ok({ accounts: [...connected.values()] })
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { provider } = await req.json().catch(() => ({}))
  if (!provider) return err('provider is required', 400)
  if (provider !== 'gmail' && provider !== 'github') {
    return err('Unsupported account provider', 400)
  }
  if (provider === 'gmail') {
    await db.account.deleteMany({
      where: {
        userId: auth.userId,
        provider: 'gmail',
      },
    })
  } else {
    await db.account.deleteMany({ where: { userId: auth.userId, provider } })
  }

  return ok({ disconnected: provider })
}
