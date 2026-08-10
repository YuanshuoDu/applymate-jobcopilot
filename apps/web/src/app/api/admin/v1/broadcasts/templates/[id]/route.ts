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
  const body = await request.json().catch(() => null) as { name?: unknown; title?: unknown; body?: unknown; reason?: unknown } | null
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const title = typeof body?.title === 'string' ? body.title.trim() : ''
  const content = typeof body?.body === 'string' ? body.body.trim() : ''
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const key = request.headers.get('idempotency-key')?.trim()
  if (name.length < 2 || name.length > 80 || title.length < 1 || title.length > 120 || content.length < 1 || content.length > 2_000 || reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'Invalid broadcast template' }, { status: 400 })
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'broadcast_template.updated', idempotencyKey: key, targetId: id, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'broadcast', targetId: id, reason, outcome: 'success' }, mutate: tx => tx.adminBroadcastTemplate.updateMany({ where: { id, active: true }, data: { name, title, body: content, updatedById: actor.userId } }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true })
  if (!result.value.count) return NextResponse.json({ error: 'Template not found' }, { status: 404 })
  return NextResponse.json({ id, updated: true }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('broadcasts.update', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { id } = await context.params
  const reason = request.headers.get('x-admin-reason')?.trim() ?? ''
  const key = request.headers.get('idempotency-key')?.trim()
  if (reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'A reason and Idempotency-Key are required' }, { status: 400 })
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'broadcast_template.archived', idempotencyKey: key, targetId: id, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'broadcast', targetId: id, reason, outcome: 'success' }, mutate: tx => tx.adminBroadcastTemplate.updateMany({ where: { id, active: true }, data: { active: false, updatedById: actor.userId } }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true })
  return NextResponse.json({ archived: Boolean(result.value.count) }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
