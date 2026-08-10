import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { db } from '@/lib/db'
import { runAdminMutation } from '@/lib/admin/write-transaction'

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('broadcasts.create', request)
  if (isAdminResponse(actor)) return actor
  const templates = await db.adminBroadcastTemplate.findMany({ where: { active: true }, orderBy: { updatedAt: 'desc' }, take: 100 })
  return NextResponse.json({ templates }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

export async function POST(request: NextRequest) {
  const actor = await requireAdmin('broadcasts.update', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const body = await request.json().catch(() => null) as { name?: unknown; title?: unknown; body?: unknown; reason?: unknown } | null
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const title = typeof body?.title === 'string' ? body.title.trim() : ''
  const content = typeof body?.body === 'string' ? body.body.trim() : ''
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const key = request.headers.get('idempotency-key')?.trim()
  if (name.length < 2 || name.length > 80 || title.length < 1 || title.length > 120 || content.length < 1 || content.length > 2_000 || reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'Invalid broadcast template' }, { status: 400 })
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'broadcast_template.created', idempotencyKey: key, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'broadcast', reason, outcome: 'success' }, mutate: tx => tx.adminBroadcastTemplate.create({ data: { name, title, body: content, createdById: actor.userId, updatedById: actor.userId } }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true })
  return NextResponse.json({ template: result.value }, { status: 201, headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
