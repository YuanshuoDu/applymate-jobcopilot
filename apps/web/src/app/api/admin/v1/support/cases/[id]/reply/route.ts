import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { parseReply } from '@/lib/contact-us'
import { db } from '@/lib/db'

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('support_cases.reply', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { id } = await context.params
  const payload = await request.json().catch(() => null) as { body?: unknown; reason?: unknown } | null
  const message = parseReply(payload)
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  const idempotencyKey = request.headers.get('idempotency-key')
  if (!message || reason.length < 10 || reason.length > 500 || !idempotencyKey) return NextResponse.json({ error: 'Invalid support reply' }, { status: 400 })
  const existing = await db.supportCaseMessage.findUnique({ where: { idempotencyKey }, select: { id: true, caseId: true } })
  if (existing) return NextResponse.json({ message: existing, duplicate: true })
  const supportCase = await db.supportCase.findUnique({ where: { id }, select: { requesterUserId: true } })
  if (!supportCase) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'support.reply_sent', targetType: 'support_case', targetId: id, tenantUserId: supportCase.requesterUserId, reason, outcome: 'success' })
  const created = await db.$transaction(async (tx) => {
    const staffReply = await tx.supportCaseMessage.create({ data: { caseId: id, authorType: 'staff_reply', authorUserId: actor.userId, idempotencyKey, body: message.body, redacted: message.redacted } })
    await tx.supportCase.update({ where: { id }, data: { status: 'waiting_on_customer', assignedAdminId: actor.userId, firstRespondedAt: new Date() } })
    await tx.notification.create({ data: { userId: supportCase.requesterUserId, type: 'contact_us_reply', title: 'New support reply', body: 'A support team member replied to your case.' } })
    return staffReply
  })
  return NextResponse.json({ message: created }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
}
