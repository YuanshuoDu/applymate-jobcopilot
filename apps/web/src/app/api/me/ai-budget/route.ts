import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok } from '@/lib/api-helpers'
import { db } from '@/lib/db'
import { resolveEntitlement } from '@/lib/entitlements'

const MONTHLY_LIMIT = 30

function currentMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

type BudgetRow = { used: number; limit: number }

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const month = currentMonth()
  const entitlement = await resolveEntitlement(auth.userId, 'ai_credits')
  const entitlementLimit = entitlement?.kind === 'limit' && entitlement.limit !== null
    ? entitlement.enabled ? entitlement.limit : 0
    : undefined
  const defaultLimit = entitlementLimit ?? MONTHLY_LIMIT

  let rows: BudgetRow[]
  try {
    rows = await db.$queryRaw`
      SELECT used, "limit"
      FROM ai_budgets
      WHERE user_id = ${auth.userId} AND month = ${month}
      LIMIT 1
    ` as BudgetRow[]
  } catch {
    // The budget table was added after the original AI routes. Keep the
    // candidate dashboard readable while the deployment migration catches up.
    return ok({ used: 0, limit: defaultLimit, remaining: defaultLimit, hasBudget: false })
  }

  const row = rows[0]
  if (!row) {
    return ok({ used: 0, limit: defaultLimit, remaining: defaultLimit, hasBudget: false })
  }

  const used = Number(row.used)
  const limit = entitlementLimit ?? Number(row.limit)
  return ok({ used, limit, remaining: Math.max(limit - used, 0), hasBudget: true })
}
