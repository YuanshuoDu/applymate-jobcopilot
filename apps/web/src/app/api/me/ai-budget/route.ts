import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok } from '@/lib/api-helpers'
import { db } from '@/lib/db'

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
  const rows = await db.$queryRaw`
    SELECT used, "limit"
    FROM ai_budgets
    WHERE user_id = ${auth.userId} AND month = ${month}
    LIMIT 1
  ` as BudgetRow[]

  const row = rows[0]
  if (!row) {
    return ok({ used: 0, limit: MONTHLY_LIMIT, remaining: MONTHLY_LIMIT, hasBudget: false })
  }

  const used = Number(row.used)
  const limit = Number(row.limit)
  return ok({ used, limit, remaining: Math.max(limit - used, 0), hasBudget: true })
}
