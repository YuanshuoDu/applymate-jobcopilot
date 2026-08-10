import { createHmac } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { db } from '@/lib/db'

function csvCell(value: string | number) {
  return `"${String(value).replaceAll('"', '""')}"`
}

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('users.export_anonymized', request)
  if (isAdminResponse(actor)) return actor
  const salt = process.env.ADMIN_EXPORT_SALT || process.env.NEXTAUTH_SECRET
  if (!salt) return NextResponse.json({ error: 'Anonymized export is not configured' }, { status: 503 })
  const rows = await db.user.findMany({ orderBy: { id: 'asc' }, take: 5_000, select: { id: true, plan: true, accountStatus: true, createdAt: true } })
  const lines = [
    'user_hash,plan,account_status,created_at',
    ...rows.map(row => [createHmac('sha256', salt).update(row.id).digest('hex'), row.plan, row.accountStatus, row.createdAt.toISOString()].map(csvCell).join(',')),
  ]
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'users.anonymized_exported', targetType: 'user', outcome: 'success', after: { rowCount: rows.length } })
  return new NextResponse(`${lines.join('\n')}\n`, { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="applymate-anonymized-users.csv"', 'x-request-id': actor.requestId } })
}
