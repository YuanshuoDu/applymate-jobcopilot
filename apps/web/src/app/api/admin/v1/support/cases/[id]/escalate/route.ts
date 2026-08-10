import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { supportCaseScope } from '@/lib/admin/support-case'
import { db } from '@/lib/db'

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('support_cases.escalate', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { id } = await context.params
  const body = await request.json().catch(() => null) as { service?: string; reason?: string } | null
  const service = typeof body?.service === 'string' ? body.service.trim().slice(0, 80) : ''
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const key = request.headers.get('idempotency-key')?.trim() ?? ''
  if (!service || !key || reason.length < 10 || reason.length > 500) return NextResponse.json({ error: 'service, reason and Idempotency-Key are required' }, { status: 400 })
  const supportCase = await db.supportCase.findFirst({ where: { id, ...supportCaseScope(actor) }, select: { id: true, requesterUserId: true, category: true, priority: true } })
  if (!supportCase) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const result = await runAdminMutation({
    actorUserId: actor.userId,
    action: 'support.case_escalated',
    idempotencyKey: key,
    targetId: id,
    audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'support_case', targetId: id, tenantUserId: supportCase.requesterUserId, reason, outcome: 'success', after: { service, category: supportCase.category, priority: supportCase.priority } },
    mutate: async (tx) => {
    const incident = await tx.adminIncident.create({ data: { title: `Support escalation ${id.slice(-8)}`, summary: `Escalated ${supportCase.category} case for ${service}. Priority: ${supportCase.priority}.`, service, severity: supportCase.priority === 'urgent' ? 'high' : 'medium', createdById: actor.userId, updatedById: actor.userId } })
    const escalation = await tx.supportCaseEscalation.create({ data: { caseId: id, incidentId: incident.id, service, reason, createdById: actor.userId } })
    return { incident, escalation }
    },
  })
  if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
  return NextResponse.json({ incidentId: result.value.incident.id, escalationId: result.value.escalation.id }, { status: 201, headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
