import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { db } from '@/lib/db'
import { runAdminMutation } from '@/lib/admin/write-transaction'

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('broadcasts.update', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { id } = await context.params
  const body = await request.json().catch(() => null) as { title?: unknown; body?: unknown; reason?: unknown } | null
  const title = typeof body?.title === 'string' ? body.title.replace(/<[^>]*>/g, ' ').trim() : null
  const content = typeof body?.body === 'string' ? body.body.replace(/<[^>]*>/g, ' ').trim() : null
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const key = request.headers.get('idempotency-key')
  if ((!title && !content) || (title !== null && (title.length === 0 || title.length > 120)) || (content !== null && (content.length === 0 || content.length > 2_000)) || reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'Invalid broadcast edit' }, { status: 400 })
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'broadcast.updated', idempotencyKey: key, targetId: id, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'broadcast', targetId: id, reason, outcome: 'success', after: { title: title ?? undefined, bodyUpdated: content !== null, approvalReset: true } }, mutate: (tx) => tx.adminBroadcast.updateMany({ where: { id, status: 'draft' }, data: { ...(title !== null ? { title } : {}), ...(content !== null ? { body: content } : {}), approvedById: null } }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true })
  if (!result.value.count) return NextResponse.json({ error: 'Only draft broadcasts can be edited' }, { status: 409 })
  return NextResponse.json({ id, status: 'draft' }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
