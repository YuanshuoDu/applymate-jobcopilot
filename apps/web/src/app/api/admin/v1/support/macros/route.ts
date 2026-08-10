import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { db } from '@/lib/db'

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('support_cases.read', request)
  if (isAdminResponse(actor)) return actor
  const macros = await db.supportMacro.findMany({ where: { active: true }, orderBy: [{ category: 'asc' }, { name: 'asc' }], select: { id: true, name: true, category: true, body: true } })
  return NextResponse.json({ macros }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

export async function POST(request: NextRequest) {
  const actor = await requireAdmin('support_macros.manage', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const body = await request.json().catch(() => null) as { name?: string; category?: string; body?: string; reason?: string } | null
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 120) : ''
  const content = typeof body?.body === 'string' ? body.body.trim().slice(0, 5000) : ''
  const category = typeof body?.category === 'string' ? body.category.trim().slice(0, 80) || null : null
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const key = request.headers.get('idempotency-key')?.trim() ?? ''
  if (!name || !content || !key || reason.length < 10 || reason.length > 500) return NextResponse.json({ error: 'name, body, reason and Idempotency-Key are required' }, { status: 400 })
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'support.macro_created', idempotencyKey: key, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'support_case', reason, outcome: 'success', after: { name, category } }, mutate: (tx) => tx.supportMacro.create({ data: { name, category, body: content, createdById: actor.userId, updatedById: actor.userId }, select: { id: true, name: true, category: true, body: true } }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true })
  return NextResponse.json({ macro: result.value }, { status: 201, headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
