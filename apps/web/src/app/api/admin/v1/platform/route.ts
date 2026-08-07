import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok } from '@/lib/api-helpers'
import { writeAdminAudit } from '@/lib/admin/audit'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { platformIntegrationStatus } from '@/lib/admin/integration-status'

function adminOk<T>(data: T, requestId: string) {
  const response = ok(data)
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('x-request-id', requestId)
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

export async function GET(req: NextRequest) {
  const actor = await requireAdmin('observability.read', req)
  if (isAdminResponse(actor)) return actor

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

  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'platform.viewed', outcome: 'success' })

  return adminOk({
    users: { total: Number(total), byPlan },
    applies: { total: Number(applies) },
    deletionRequests,
    integrations: platformIntegrationStatus(),
    generatedAt: new Date().toISOString(),
  }, actor.requestId)
}
