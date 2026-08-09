import { AdminIncidentSeverity, AdminIncidentStatus } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { db } from '@/lib/db'
import { runAdminMutation } from '@/lib/admin/write-transaction'

const severities = Object.values(AdminIncidentSeverity)
const statuses = Object.values(AdminIncidentStatus)

function text(value: unknown, max: number) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max ? value.trim() : null
}

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('observability.read', request)
  if (isAdminResponse(actor)) return actor
  const params = new URL(request.url).searchParams
  const status = params.get('status') as AdminIncidentStatus | null
  const rows = await db.adminIncident.findMany({ where: status && statuses.includes(status) ? { status } : undefined, orderBy: { startedAt: 'desc' }, take: 100 })
  return NextResponse.json({ incidents: rows }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

export async function POST(request: NextRequest) {
  const actor = await requireAdmin('incidents.manage', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const title = text(body?.title, 120)
  const summary = text(body?.summary, 2_000)
  const service = text(body?.service, 80)
  const severity = typeof body?.severity === 'string' && severities.includes(body.severity as AdminIncidentSeverity) ? body.severity as AdminIncidentSeverity : null
  const reason = text(body?.reason, 500)
  const key = request.headers.get('idempotency-key')
  if (!title || !summary || !service || !severity || !reason || reason.length < 10 || !key) return NextResponse.json({ error: 'Invalid incident' }, { status: 400 })
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'incident.created', idempotencyKey: key, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'incident', reason, outcome: 'success', after: { title, service, severity } }, mutate: (tx) => tx.adminIncident.create({ data: { title, summary, service, severity, createdById: actor.userId, updatedById: actor.userId } }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true })
  return NextResponse.json({ incident: result.value }, { status: 201, headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
