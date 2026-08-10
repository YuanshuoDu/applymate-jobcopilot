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
          provider: 'gmail', account: account.providerAccountId, legacy: true,
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
    await db.$transaction(async (tx) => {
      await tx.account.deleteMany({
        where: {
          userId: auth.userId,
          provider: 'gmail',
        },
      })
      // Older Gmail connections shared an Auth.js Google identity row. Keep
      // that identity so Google sign-in still works, but remove its Gmail
      // credentials and scope so the compatibility path cannot reconnect it.
      await tx.account.updateMany({
        where: { userId: auth.userId, provider: 'google', scope: { contains: 'gmail' } },
        data: {
          access_token: null,
          accessTokenEnc: null,
          refresh_token: null,
          refreshTokenEnc: null,
          expires_at: null,
          token_type: null,
          scope: null,
          id_token: null,
          idTokenEnc: null,
          session_state: null,
        },
      })
    })
  } else {
    await db.account.deleteMany({ where: { userId: auth.userId, provider } })
  }

  return ok({ disconnected: provider })
}
