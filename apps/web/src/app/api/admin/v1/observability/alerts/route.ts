import { AdminIncidentSeverity } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { db } from '@/lib/db'
import { runAdminMutation } from '@/lib/admin/write-transaction'

const metrics = ['success_rate', 'captcha_rate', 'avg_duration_ms'] as const
const operators = ['gt', 'gte', 'lt', 'lte'] as const

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('observability.read', request)
  if (isAdminResponse(actor)) return actor
  const [rules, events] = await Promise.all([
    db.adminAlertRule.findMany({ orderBy: { key: 'asc' } }),
    db.adminAlertEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }),
  ])
  return NextResponse.json({ rules, events }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

export async function POST(request: NextRequest) {
  const actor = await requireAdmin('observability.alerts.manage', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const body = await request.json().catch(() => null) as { key?: string; name?: string; metric?: string; operator?: string; threshold?: number; windowMin?: number; severity?: string; enabled?: boolean; reason?: string } | null
  const key = typeof body?.key === 'string' ? body.key.trim().toLowerCase() : ''
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 120) : ''
  const metric = body?.metric as typeof metrics[number]
  const operator = body?.operator as typeof operators[number]
  const severity = body?.severity as AdminIncidentSeverity
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? ''
  if (!/^[a-z][a-z0-9_.-]{2,80}$/.test(key) || !name || !metrics.includes(metric) || !operators.includes(operator) || !Object.values(AdminIncidentSeverity).includes(severity) || typeof body?.threshold !== 'number' || !Number.isFinite(body.threshold) || !Number.isInteger(body?.windowMin) || (body.windowMin as number) < 1 || (body.windowMin as number) > 10_080 || !idempotencyKey || reason.length < 10 || reason.length > 500) return NextResponse.json({ error: 'Invalid alert rule' }, { status: 400 })
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'observability.alert_rule_updated', idempotencyKey, targetId: key, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'incident', targetId: key, reason, outcome: 'success', after: { key, metric, operator, threshold: body.threshold, windowMin: body.windowMin, severity, enabled: body.enabled !== false } }, mutate: (tx) => tx.adminAlertRule.upsert({ where: { key }, create: { key, name, metric, operator, threshold: body.threshold as number, windowMin: body.windowMin as number, severity, enabled: body.enabled !== false, createdById: actor.userId, updatedById: actor.userId }, update: { name, metric, operator, threshold: body.threshold as number, windowMin: body.windowMin as number, severity, enabled: body.enabled !== false, updatedById: actor.userId } }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true })
  return NextResponse.json({ rule: result.value }, { status: 201, headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
