import { AdminIncidentSeverity, AdminIncidentStatus } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { db } from '@/lib/db'
import { runAdminMutation } from '@/lib/admin/write-transaction'

const severities = Object.values(AdminIncidentSeverity)
const statuses = Object.values(AdminIncidentStatus)

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('incidents.manage', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { id } = await context.params
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const status = typeof body?.status === 'string' && statuses.includes(body.status as AdminIncidentStatus) ? body.status as AdminIncidentStatus : null
  const severity = typeof body?.severity === 'string' && severities.includes(body.severity as AdminIncidentSeverity) ? body.severity as AdminIncidentSeverity : undefined
  const summary = typeof body?.summary === 'string' && body.summary.trim().length <= 2_000 ? body.summary.trim() : undefined
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const key = request.headers.get('idempotency-key')
  if (!status || !reason || reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'Invalid incident update' }, { status: 400 })
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'incident.updated', idempotencyKey: key, targetId: id, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'incident', targetId: id, reason, outcome: 'success', after: { status, severity: severity ?? null } }, mutate: (tx) => tx.adminIncident.update({ where: { id }, data: { status, ...(severity ? { severity } : {}), ...(summary ? { summary } : {}), resolvedAt: status === 'resolved' ? new Date() : null, updatedById: actor.userId } }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true })
  return NextResponse.json({ incident: result.value }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
