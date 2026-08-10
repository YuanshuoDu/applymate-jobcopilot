import { createHmac } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { db } from '@/lib/db'

function cell(value: unknown): string { return `"${String(value ?? '').replaceAll('"', '""')}"` }
function csv(headers: string[], rows: Array<Array<unknown>>): string { return [headers, ...rows].map(row => row.map(cell).join(',')).join('\n') + '\n' }

type AiProviderExportRow = { provider: string; model: string; calls: number; errors: number; cost: number; avgLatency: number | null }
type AtsQualityExportRow = { atsType: string; calls: number; successes: number; directCalls: number; directSuccesses: number; avgDuration: number | null }

export async function GET(request: NextRequest) {
  const resource = request.nextUrl.searchParams.get('resource')
  const limit = Math.min(Math.max(Number(request.nextUrl.searchParams.get('limit') ?? '5000') || 5000, 1), 5000)
  const requestedIds = [...new Set((request.nextUrl.searchParams.get('ids') ?? '').split(',').map(value => value.trim()).filter(Boolean))].slice(0, 500)
  const query = request.nextUrl.searchParams.get('q')?.trim().slice(0, 120) ?? ''
  const sort = request.nextUrl.searchParams.get('sort') ?? ''
  const direction: Prisma.SortOrder = request.nextUrl.searchParams.get('direction') === 'desc' ? 'desc' : 'asc'
  const actor = resource === 'users'
    ? await requireAdmin('users.export_anonymized', request)
    : resource === 'applications' ? await requireAdmin('applications.read', request)
      : resource === 'ats' || resource === 'ats-quality' ? await requireAdmin('ats.read', request)
        : resource === 'ai-budgets' || resource === 'ai-usage' ? await requireAdmin('ai_budget.read', request)
          : resource === 'audit' ? await requireAdmin('audit.read', request)
            : resource === 'support-cases' ? await requireAdmin('support_cases.read', request)
              : resource === 'broadcasts' ? await requireAdmin('broadcasts.preview', request)
                : resource === 'deletions' ? await requireAdmin('users.deletion.manage', request)
                  : resource === 'incidents' ? await requireAdmin('observability.read', request)
                    : resource === 'subscriptions' ? await requireAdmin('billing.read', request)
                      : resource === 'access-members' ? await requireAdmin('admin_members.read', request)
            : null
  if (!actor) return NextResponse.json({ error: 'Unsupported export resource' }, { status: 400 })
  if (isAdminResponse(actor)) return actor
  let content: string
  let filename: string
  let rowCount = 0
  if (resource === 'users') {
    const salt = process.env.ADMIN_EXPORT_SALT || process.env.NEXTAUTH_SECRET
    if (!salt) return NextResponse.json({ error: 'Anonymized export is not configured' }, { status: 503 })
    const plan = request.nextUrl.searchParams.get('plan')?.trim()
    const status = request.nextUrl.searchParams.get('status')?.trim()
    const where: Prisma.UserWhereInput = { ...(requestedIds.length ? { id: { in: requestedIds } } : {}), ...(plan ? { plan: plan as Prisma.UserWhereInput['plan'] } : {}), ...(status ? { accountStatus: status as Prisma.UserWhereInput['accountStatus'] } : {}), ...(query ? { OR: [{ name: { contains: query, mode: 'insensitive' } }, { email: { contains: query, mode: 'insensitive' } }] } : {}) }
    const orderBy: Prisma.UserOrderByWithRelationInput = sort === 'name' ? { name: direction } : sort === 'plan' ? { plan: direction } : sort === 'accountStatus' ? { accountStatus: direction } : { createdAt: direction }
    const rows = await db.user.findMany({ where, orderBy, take: limit, select: { id: true, plan: true, accountStatus: true, createdAt: true } })
    content = csv(['user_hash', 'plan', 'account_status', 'created_at'], rows.map(row => [createHmac('sha256', salt).update(row.id).digest('hex'), row.plan, row.accountStatus, row.createdAt.toISOString()]))
    filename = 'applymate-users.csv'; rowCount = rows.length
  } else if (resource === 'ats') {
    const ids = requestedIds.map(Number).filter(Number.isInteger)
    const where: Prisma.AtsEmployerWhereInput = { ...(ids.length ? { id: { in: ids } } : {}), ...(query ? { OR: [{ atsType: { contains: query, mode: 'insensitive' } }, { slug: { contains: query, mode: 'insensitive' } }, { name: { contains: query, mode: 'insensitive' } }] } : {}) }
    const orderBy: Prisma.AtsEmployerOrderByWithRelationInput = sort === 'jobCount' ? { jobCount: direction } : sort === 'lastSeen' ? { lastSeen: direction } : { id: direction }
    const rows = await db.atsEmployer.findMany({ where, orderBy, take: limit, select: { atsType: true, slug: true, name: true, jobCount: true, firstSeen: true, lastSeen: true } })
    content = csv(['ats_type', 'slug', 'name', 'job_count', 'first_seen', 'last_seen'], rows.map(row => [row.atsType, row.slug, row.name, row.jobCount, row.firstSeen.toISOString(), row.lastSeen.toISOString()]))
    filename = 'applymate-ats-sources.csv'; rowCount = rows.length
  } else if (resource === 'ats-quality') {
    const days = Math.min(Math.max(Number(request.nextUrl.searchParams.get('days') ?? '30') || 30, 1), 365)
    const since = new Date(Date.now() - days * 86_400_000)
    const rows = await db.$queryRaw<AtsQualityExportRow[]>`
      SELECT COALESCE(ats_type, 'unknown') AS "atsType", COUNT(*)::int AS calls,
        COUNT(*) FILTER (WHERE status = 'submitted')::int AS successes,
        COUNT(*) FILTER (WHERE mode = 'unattended')::int AS "directCalls",
        COUNT(*) FILTER (WHERE mode = 'unattended' AND status = 'submitted')::int AS "directSuccesses",
        ROUND(AVG(duration_ms))::int AS "avgDuration"
      FROM apply_results WHERE created_at >= ${since}
      GROUP BY ats_type ORDER BY calls DESC
    `
    content = csv(['ats_type', 'applications', 'successes', 'direct_apply', 'direct_successes', 'avg_duration_ms'], rows.map(row => [row.atsType, row.calls, row.successes, row.directCalls, row.directSuccesses, row.avgDuration ?? 0]))
    filename = 'applymate-ats-quality.csv'; rowCount = rows.length
  } else if (resource === 'applications') {
    const ids = requestedIds.map(Number).filter(Number.isInteger)
    const status = request.nextUrl.searchParams.get('status')?.trim()
    const mode = request.nextUrl.searchParams.get('mode')?.trim()
    const atsType = request.nextUrl.searchParams.get('atsType')?.trim()
    const where: Prisma.ApplyResultWhereInput = { ...(ids.length ? { id: { in: ids } } : {}), ...(status ? { status } : {}), ...(mode ? { mode } : {}), ...(atsType ? { atsType } : {}) }
    const orderBy: Prisma.ApplyResultOrderByWithRelationInput = sort === 'status' ? { status: direction } : sort === 'durationMs' ? { durationMs: direction } : { createdAt: direction }
    const rows = await db.applyResult.findMany({ where, orderBy, take: limit, select: { id: true, status: true, mode: true, atsType: true, flowUsed: true, durationMs: true, createdAt: true } })
    content = csv(['id', 'status', 'mode', 'ats_type', 'flow_used', 'duration_ms', 'created_at'], rows.map(row => [row.id, row.status, row.mode, row.atsType, row.flowUsed, row.durationMs, row.createdAt.toISOString()]))
    filename = 'applymate-applications.csv'; rowCount = rows.length
  } else if (resource === 'ai-budgets') {
    const where: Prisma.AiBudgetWhereInput = { ...(requestedIds.length ? { id: { in: requestedIds } } : {}), ...(query ? { OR: [{ userId: { contains: query, mode: 'insensitive' } }, { month: { contains: query, mode: 'insensitive' } }] } : {}) }
    const orderBy: Prisma.AiBudgetOrderByWithRelationInput = sort === 'used' ? { used: direction } : sort === 'limit' ? { limit: direction } : { updatedAt: direction }
    const rows = await db.aiBudget.findMany({ where, orderBy, take: limit, select: { userId: true, month: true, used: true, limit: true, updatedAt: true } })
    content = csv(['user_id', 'month', 'used', 'limit', 'updated_at'], rows.map(row => [row.userId, row.month, row.used, row.limit, row.updatedAt.toISOString()]))
    filename = 'applymate-ai-budgets.csv'; rowCount = rows.length
  } else if (resource === 'ai-usage') {
    const days = Math.min(Math.max(Number(request.nextUrl.searchParams.get('days') ?? '30') || 30, 1), 365)
    const since = new Date(Date.now() - days * 86_400_000)
    const rows = await db.$queryRaw<AiProviderExportRow[]>`
      SELECT provider, model, COUNT(*)::int AS calls,
        COUNT(*) FILTER (WHERE status = 'error')::int AS errors,
        COALESCE(SUM(estimated_cost_usd), 0)::float AS cost,
        ROUND(AVG(latency_ms))::int AS "avgLatency"
      FROM ai_usage_events WHERE created_at >= ${since}
      GROUP BY provider, model ORDER BY cost DESC, calls DESC
    `
    content = csv(['provider', 'model', 'calls', 'errors', 'estimated_cost_usd', 'avg_latency_ms'], rows.map(row => [row.provider, row.model, row.calls, row.errors, row.cost, row.avgLatency ?? 0]))
    filename = 'applymate-ai-usage.csv'; rowCount = rows.length
  } else if (resource === 'support-cases') {
    const status = request.nextUrl.searchParams.get('status')?.trim()
    const priority = request.nextUrl.searchParams.get('priority')?.trim()
    const assigned = request.nextUrl.searchParams.get('assigned')?.trim()
    const category = request.nextUrl.searchParams.get('category')?.trim()
    const sla = request.nextUrl.searchParams.get('sla')?.trim()
    const now = new Date()
    const dueSoon = new Date(now.getTime() + 24 * 60 * 60 * 1000)
    const where: Prisma.SupportCaseWhereInput = { ...(requestedIds.length ? { id: { in: requestedIds } } : {}), ...(query ? { OR: [{ id: { contains: query, mode: 'insensitive' } }, { subject: { contains: query, mode: 'insensitive' } }, { category: { contains: query, mode: 'insensitive' } }] } : {}), ...(status ? { status: status as Prisma.SupportCaseWhereInput['status'] } : {}), ...(priority ? { priority: priority as Prisma.SupportCaseWhereInput['priority'] } : {}), ...(category ? { category } : {}), ...(assigned === 'unassigned' ? { assignedAdminId: null } : assigned ? { assignedAdminId: assigned } : {}), ...(sla === 'overdue' ? { slaDueAt: { lt: now } } : sla === 'due_soon' ? { slaDueAt: { gte: now, lte: dueSoon } } : {}) }
    const rows = await db.supportCase.findMany({ where, orderBy: { updatedAt: 'desc' }, take: limit, select: { id: true, subject: true, category: true, status: true, priority: true, assignedAdminId: true, slaDueAt: true, createdAt: true, updatedAt: true } })
    content = csv(['id', 'subject', 'category', 'status', 'priority', 'assigned_admin_id', 'sla_due_at', 'created_at', 'updated_at'], rows.map(row => [row.id, row.subject, row.category, row.status, row.priority, row.assignedAdminId, row.slaDueAt?.toISOString(), row.createdAt.toISOString(), row.updatedAt.toISOString()]))
    filename = 'applymate-support-cases.csv'; rowCount = rows.length
  } else if (resource === 'broadcasts') {
    const rows = await db.adminBroadcast.findMany({ where: { ...(requestedIds.length ? { id: { in: requestedIds } } : {}), ...(query ? { title: { contains: query, mode: 'insensitive' } } : {}) }, orderBy: { createdAt: 'desc' }, take: limit, select: { id: true, title: true, audienceType: true, status: true, scheduledAt: true, recipientCount: true, deliveredCount: true, failedCount: true, createdAt: true } })
    content = csv(['id', 'title', 'audience_type', 'status', 'scheduled_at', 'recipient_count', 'delivered_count', 'failed_count', 'created_at'], rows.map(row => [row.id, row.title, row.audienceType, row.status, row.scheduledAt?.toISOString(), row.recipientCount, row.deliveredCount, row.failedCount, row.createdAt.toISOString()]))
    filename = 'applymate-broadcasts.csv'; rowCount = rows.length
  } else if (resource === 'deletions') {
    const rows = await db.adminDataDeletionRequest.findMany({ where: { ...(requestedIds.length ? { id: { in: requestedIds } } : {}), ...(query ? { OR: [{ id: { contains: query, mode: 'insensitive' } }, { status: { contains: query, mode: 'insensitive' } }] } : {}) }, orderBy: { requestedAt: 'desc' }, take: limit, select: { id: true, status: true, requestedAt: true, processedAt: true, version: true } })
    content = csv(['id', 'status', 'requested_at', 'processed_at', 'version'], rows.map(row => [row.id, row.status, row.requestedAt.toISOString(), row.processedAt?.toISOString(), row.version]))
    filename = 'applymate-deletion-queue.csv'; rowCount = rows.length
  } else if (resource === 'incidents') {
    const rows = await db.adminIncident.findMany({ where: { ...(requestedIds.length ? { id: { in: requestedIds } } : {}), ...(query ? { OR: [{ id: { contains: query, mode: 'insensitive' } }, { title: { contains: query, mode: 'insensitive' } }, { service: { contains: query, mode: 'insensitive' } }] } : {}) }, orderBy: { startedAt: 'desc' }, take: limit, select: { id: true, title: true, service: true, severity: true, status: true, startedAt: true, resolvedAt: true } })
    content = csv(['id', 'title', 'service', 'severity', 'status', 'started_at', 'resolved_at'], rows.map(row => [row.id, row.title, row.service, row.severity, row.status, row.startedAt.toISOString(), row.resolvedAt?.toISOString()]))
    filename = 'applymate-incidents.csv'; rowCount = rows.length
  } else if (resource === 'subscriptions') {
    const rows = await db.userPlanSubscription.findMany({ where: { ...(requestedIds.length ? { id: { in: requestedIds } } : {}) }, orderBy: { updatedAt: 'desc' }, take: limit, select: { id: true, userId: true, plan: true, status: true, trialEndsAt: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, scheduledPlan: true, updatedAt: true } })
    content = csv(['id', 'user_id', 'plan', 'status', 'trial_ends_at', 'current_period_end', 'cancel_at_period_end', 'scheduled_plan', 'updated_at'], rows.map(row => [row.id, row.userId, row.plan, row.status, row.trialEndsAt?.toISOString(), row.currentPeriodEnd?.toISOString(), row.cancelAtPeriodEnd, row.scheduledPlan, row.updatedAt.toISOString()]))
    filename = 'applymate-subscriptions.csv'; rowCount = rows.length
  } else if (resource === 'access-members') {
    const salt = process.env.ADMIN_EXPORT_SALT || process.env.NEXTAUTH_SECRET
    if (!salt) return NextResponse.json({ error: 'Anonymized export is not configured' }, { status: 503 })
    const rows = await db.adminMembership.findMany({ where: { ...(requestedIds.length ? { id: { in: requestedIds } } : {}) }, orderBy: { grantedAt: 'asc' }, take: limit, select: { id: true, userId: true, status: true, mfaLevel: true, grantedAt: true, role: { select: { key: true } } } })
    content = csv(['membership_id', 'user_id_hash', 'status', 'mfa_level', 'role', 'granted_at'], rows.map(row => [row.id, createHmac('sha256', salt).update(row.userId).digest('hex'), row.status, row.mfaLevel, row.role.key, row.grantedAt.toISOString()]))
    filename = 'applymate-access-members.csv'; rowCount = rows.length
  } else {
    const where: Prisma.AdminAuditLogWhereInput = { ...(requestedIds.length ? { id: { in: requestedIds } } : {}), ...(query ? { OR: [{ action: { contains: query, mode: 'insensitive' } }, { actorRoleKey: { contains: query, mode: 'insensitive' } }, { targetId: { contains: query, mode: 'insensitive' } }] } : {}) }
    const orderBy: Prisma.AdminAuditLogOrderByWithRelationInput = sort === 'action' ? { action: direction } : sort === 'outcome' ? { outcome: direction } : { createdAt: direction }
    const rows = await db.adminAuditLog.findMany({ where, orderBy, take: limit, select: { requestId: true, actorRoleKey: true, action: true, targetType: true, targetId: true, outcome: true, errorCode: true, createdAt: true } })
    content = csv(['request_id', 'actor_role', 'action', 'target_type', 'target_id', 'outcome', 'error_code', 'created_at'], rows.map(row => [row.requestId, row.actorRoleKey, row.action, row.targetType, row.targetId, row.outcome, row.errorCode, row.createdAt.toISOString()]))
    filename = 'applymate-audit.csv'; rowCount = rows.length
  }
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'admin.safe_export_created', targetType: resource === 'ats' || resource === 'ats-quality' ? 'ats_source' : resource === 'applications' ? 'application' : resource === 'ai-budgets' || resource === 'ai-usage' ? 'ai_budget' : resource === 'audit' ? undefined : resource === 'support-cases' ? 'support_case' : resource === 'broadcasts' ? 'broadcast' : resource === 'deletions' ? 'user' : resource === 'incidents' ? 'incident' : resource === 'subscriptions' ? 'plan' : resource === 'access-members' ? 'admin_member' : 'user', outcome: 'success', after: { resource, rowCount } })
  return new NextResponse(content, { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'x-request-id': actor.requestId } })
}
