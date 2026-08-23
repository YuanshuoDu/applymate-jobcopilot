import { NextRequest, NextResponse } from 'next/server'
import type { SupportCaseMessage } from '@prisma/client'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { AdminMutationConflict, runAdminMutation } from '@/lib/admin/write-transaction'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { supportCaseScope } from '@/lib/admin/support-case'
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
  const scope = supportCaseScope(actor)
  const supportCase = await db.supportCase.findFirst({ where: { id, ...scope }, select: { requesterUserId: true } })
  if (!supportCase) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const tenantUserId = supportCase.requesterUserId ?? undefined
  try {
    const result = await runAdminMutation<SupportCaseMessage>({ actorUserId: actor.userId, action: 'support.reply_sent', idempotencyKey, targetId: id, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'support_case', targetId: id, tenantUserId, reason, outcome: 'success' }, mutate: async (tx) => {
      const claimed = await tx.supportCase.updateMany({
        where: { id, ...scope },
        data: { status: 'waiting_on_customer', assignedAdminId: actor.userId, firstRespondedAt: new Date(), version: { increment: 1 } },
      })
      if (!claimed.count) throw new AdminMutationConflict('Case changed or access is no longer available')
      const staffReply = await tx.supportCaseMessage.create({ data: { caseId: id, authorType: 'staff_reply', authorUserId: actor.userId, idempotencyKey, body: message.body, redacted: message.redacted } })
      await tx.notification.create({ data: { userId: supportCase.requesterUserId, type: 'contact_us_reply', title: 'New support reply', body: 'A support team member replied to your case.' } })
      return staffReply
    } })
    if (result.duplicate) return NextResponse.json({ duplicate: true })
    const created = result.value
    return NextResponse.json({ message: created }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof AdminMutationConflict) return NextResponse.json({ error: error.message }, { status: 409 })
    throw error
  }
}
