import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWrite } from '@/lib/admin/csrf'
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
  const existing = await db.supportCaseMessage.findUnique({ where: { idempotencyKey }, select: { id: true, caseId: true } })
  if (existing) return NextResponse.json({ message: existing, duplicate: true })
  const supportCase = await db.supportCase.findUnique({ where: { id }, select: { requesterUserId: true } })
  if (!supportCase) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'support.internal_note_added', targetType: 'support_case', targetId: id, tenantUserId: supportCase.requesterUserId, reason, outcome: 'success' })
  const created = await db.supportCaseMessage.create({ data: { caseId: id, authorType: 'internal_note', authorUserId: actor.userId, idempotencyKey, body: note.body, redacted: note.redacted } })
  return NextResponse.json({ message: created }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
}
