import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { isErrorResponse, ok } from '@/lib/api-helpers'
import { requireSettingsAdmin } from '@/lib/admin/settings-access'
import { platformIntegrationStatus } from '@/lib/admin/integration-status'

function adminOk<T>(data: T) {
  const response = ok(data)
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('x-request-id', crypto.randomUUID())
  return response
}

async function deletionRequestCounts(): Promise<{ requested: number; processing: number }> {
  try {
    const rows = await db.$queryRaw<Array<{ status: string; count: number }>>`
      SELECT preferences->>'dataDeletionRequestStatus' AS status, COUNT(*)::int AS count
      FROM "User"
      WHERE preferences->>'dataDeletionRequestStatus' IN ('requested', 'processing')
      GROUP BY preferences->>'dataDeletionRequestStatus'
    `
    return {
      requested: Number(rows.find(row => row.status === 'requested')?.count ?? 0),
      processing: Number(rows.find(row => row.status === 'processing')?.count ?? 0),
    }
  } catch {
    // Older/local databases may not have JSON values in the expected shape;
    // the per-user admin view remains the source of truth in that case.
    return { requested: 0, processing: 0 }
  }
}

export async function GET(_req: NextRequest) {
  const actor = await requireSettingsAdmin(_req)
  if (isErrorResponse(actor)) return actor

  const [total, plans, applies, deletionRequests] = await Promise.all([
    db.user.count(),
    db.user.groupBy({ by: ['plan'], _count: { _all: true } }),
    db.applyResult.count(),
    deletionRequestCounts(),
  ])

  const byPlan = { free: 0, pro: 0, enterprise: 0 }
  for (const row of plans) {
    if (row.plan in byPlan) byPlan[row.plan as keyof typeof byPlan] = Number(row._count._all)
  }

  return adminOk({
    users: { total: Number(total), byPlan },
    applies: { total: Number(applies) },
    deletionRequests,
    integrations: platformIntegrationStatus(),
    generatedAt: new Date().toISOString(),
  })
}
