import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { db } from '@/lib/db'

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('ats.registry.manage', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const id = Number((await context.params).id)
  const body = await request.json().catch(() => null) as { name?: string | null; reason?: string } | null
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 160) : null
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const key = request.headers.get('idempotency-key')?.trim() ?? ''
  if (!Number.isInteger(id) || id < 1 || !name || !key || reason.length < 10 || reason.length > 500) return NextResponse.json({ error: 'A valid employer name, reason and Idempotency-Key are required' }, { status: 400 })
  const current = await db.atsEmployer.findUnique({ where: { id }, select: { id: true, atsType: true, slug: true, name: true } })
  if (!current) return NextResponse.json({ error: 'ATS employer not found' }, { status: 404 })
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'ats.registry_entry_updated', idempotencyKey: key, targetId: String(id), audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'ats_source', targetId: String(id), reason, outcome: 'success', before: current, after: { name } }, mutate: (tx) => tx.atsEmployer.update({ where: { id }, data: { name } }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true })
  return NextResponse.json({ employer: result.value }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
