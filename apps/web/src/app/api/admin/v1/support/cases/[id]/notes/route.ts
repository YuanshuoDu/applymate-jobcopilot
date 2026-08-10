import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { AdminMutationConflict, runAdminMutation } from '@/lib/admin/write-transaction'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { supportCaseScope } from '@/lib/admin/support-case'
import { parseReply } from '@/lib/contact-us'
import { db } from '@/lib/db'

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('support_cases.note', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { id } = await context.params
  const payload = await request.json().catch(() => null) as { body?: unknown; reason?: unknown } | null
  const note = parseReply(payload)
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  const idempotencyKey = request.headers.get('idempotency-key')
  if (!note || reason.length < 10 || reason.length > 500 || !idempotencyKey) return NextResponse.json({ error: 'Invalid internal note' }, { status: 400 })
  const scope = supportCaseScope(actor)
  const supportCase = await db.supportCase.findFirst({ where: { id, ...scope }, select: { requesterUserId: true } })
  if (!supportCase) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    const result = await runAdminMutation({ actorUserId: actor.userId, action: 'support.internal_note_added', idempotencyKey, targetId: id, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'support_case', targetId: id, tenantUserId: supportCase.requesterUserId, reason, outcome: 'success' }, mutate: async (tx) => {
      const claimed = await tx.supportCase.updateMany({ where: { id, ...scope }, data: { version: { increment: 1 } } })
      if (!claimed.count) throw new AdminMutationConflict('Case changed or access is no longer available')
      return tx.supportCaseMessage.create({ data: { caseId: id, authorType: 'internal_note', authorUserId: actor.userId, idempotencyKey, body: note.body, redacted: note.redacted } })
    } })
    if (result.duplicate) return NextResponse.json({ duplicate: true })
    const created = result.value
    return NextResponse.json({ message: created }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof AdminMutationConflict) return NextResponse.json({ error: error.message }, { status: 409 })
    throw error
  }
}
