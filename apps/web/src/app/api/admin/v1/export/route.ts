import { createHmac } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { db } from '@/lib/db'

function cell(value: unknown): string { return `"${String(value ?? '').replaceAll('"', '""')}"` }
function csv(headers: string[], rows: Array<Array<unknown>>): string { return [headers, ...rows].map(row => row.map(cell).join(',')).join('\n') + '\n' }

export async function GET(request: NextRequest) {
  const resource = request.nextUrl.searchParams.get('resource')
  const limit = Math.min(Math.max(Number(request.nextUrl.searchParams.get('limit') ?? '5000') || 5000, 1), 5000)
  const requestedIds = [...new Set((request.nextUrl.searchParams.get('ids') ?? '').split(',').map(value => value.trim()).filter(Boolean))].slice(0, 500)
  const actor = resource === 'users'
    ? await requireAdmin('users.export_anonymized', request)
    : resource === 'applications' ? await requireAdmin('applications.read', request)
      : resource === 'ats' ? await requireAdmin('ats.read', request)
        : resource === 'ai-budgets' ? await requireAdmin('ai_budget.read', request)
          : resource === 'audit' ? await requireAdmin('audit.read', request)
            : null
  if (!actor) return NextResponse.json({ error: 'Unsupported export resource' }, { status: 400 })
  if (isAdminResponse(actor)) return actor
  let content: string
  let filename: string
  let rowCount = 0
  if (resource === 'users') {
    const salt = process.env.ADMIN_EXPORT_SALT || process.env.NEXTAUTH_SECRET
    if (!salt) return NextResponse.json({ error: 'Anonymized export is not configured' }, { status: 503 })
    const rows = await db.user.findMany({ where: requestedIds.length ? { id: { in: requestedIds } } : undefined, orderBy: { id: 'asc' }, take: limit, select: { id: true, plan: true, accountStatus: true, createdAt: true } })
    content = csv(['user_hash', 'plan', 'account_status', 'created_at'], rows.map(row => [createHmac('sha256', salt).update(row.id).digest('hex'), row.plan, row.accountStatus, row.createdAt.toISOString()]))
    filename = 'applymate-users.csv'; rowCount = rows.length
  } else if (resource === 'ats') {
    const ids = requestedIds.map(Number).filter(Number.isInteger)
    const rows = await db.atsEmployer.findMany({ where: ids.length ? { id: { in: ids } } : undefined, orderBy: { id: 'asc' }, take: limit, select: { atsType: true, slug: true, name: true, jobCount: true, firstSeen: true, lastSeen: true } })
    content = csv(['ats_type', 'slug', 'name', 'job_count', 'first_seen', 'last_seen'], rows.map(row => [row.atsType, row.slug, row.name, row.jobCount, row.firstSeen.toISOString(), row.lastSeen.toISOString()]))
    filename = 'applymate-ats-sources.csv'; rowCount = rows.length
  } else if (resource === 'applications') {
    const ids = requestedIds.map(Number).filter(Number.isInteger)
    const rows = await db.applyResult.findMany({ where: ids.length ? { id: { in: ids } } : undefined, orderBy: { createdAt: 'desc' }, take: limit, select: { id: true, status: true, mode: true, atsType: true, flowUsed: true, durationMs: true, createdAt: true } })
    content = csv(['id', 'status', 'mode', 'ats_type', 'flow_used', 'duration_ms', 'created_at'], rows.map(row => [row.id, row.status, row.mode, row.atsType, row.flowUsed, row.durationMs, row.createdAt.toISOString()]))
    filename = 'applymate-applications.csv'; rowCount = rows.length
  } else if (resource === 'ai-budgets') {
    const rows = await db.aiBudget.findMany({ where: requestedIds.length ? { id: { in: requestedIds } } : undefined, orderBy: { updatedAt: 'desc' }, take: limit, select: { userId: true, month: true, used: true, limit: true, updatedAt: true } })
    content = csv(['user_id', 'month', 'used', 'limit', 'updated_at'], rows.map(row => [row.userId, row.month, row.used, row.limit, row.updatedAt.toISOString()]))
    filename = 'applymate-ai-budgets.csv'; rowCount = rows.length
  } else {
    const rows = await db.adminAuditLog.findMany({ where: requestedIds.length ? { id: { in: requestedIds } } : undefined, orderBy: { createdAt: 'desc' }, take: limit, select: { requestId: true, actorRoleKey: true, action: true, targetType: true, targetId: true, outcome: true, errorCode: true, createdAt: true } })
    content = csv(['request_id', 'actor_role', 'action', 'target_type', 'target_id', 'outcome', 'error_code', 'created_at'], rows.map(row => [row.requestId, row.actorRoleKey, row.action, row.targetType, row.targetId, row.outcome, row.errorCode, row.createdAt.toISOString()]))
    filename = 'applymate-audit.csv'; rowCount = rows.length
  }
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'admin.safe_export_created', targetType: resource === 'ats' ? 'ats_source' : resource === 'applications' ? 'application' : resource === 'ai-budgets' ? 'ai_budget' : resource === 'audit' ? undefined : 'user', outcome: 'success', after: { resource, rowCount } })
  return new NextResponse(content, { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'x-request-id': actor.requestId } })
}
