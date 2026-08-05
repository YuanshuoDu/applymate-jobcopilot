import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { parseBreakGlassRequest } from '@/lib/admin/break-glass'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { claimAdminIdempotencyKey } from '@/lib/admin/idempotency'
import { db } from '@/lib/db'

export async function POST(request: NextRequest) {
  const actor = await requireAdmin('break_glass.request', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const payload = await request.json().catch(() => null) as { reason?: unknown } | null
  const input = parseBreakGlassRequest(payload)
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  const key = request.headers.get('idempotency-key')
  if (!input || reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'Invalid break-glass request' }, { status: 400 })
  if (!await claimAdminIdempotencyKey(actor.userId, 'break_glass.requested', key)) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'break_glass.requested', reason, outcome: 'success', after: { permission: input.permission, durationMinutes: input.durationMinutes } })
  const grant = await db.adminBreakGlassGrant.create({ data: { requesterId: actor.userId, permission: input.permission, reason, expiresAt: new Date(Date.now() + input.durationMinutes * 60_000) }, select: { id: true, permission: true, expiresAt: true } })
  return NextResponse.json({ grant }, { status: 201, headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('break_glass.approve', request)
  if (isAdminResponse(actor)) return actor
  const grants = await db.adminBreakGlassGrant.findMany({ where: { expiresAt: { gt: new Date() }, revokedAt: null }, select: { id: true, requesterId: true, approverId: true, permission: true, expiresAt: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 100 })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'break_glass.list_viewed', outcome: 'success' })
  return NextResponse.json({ grants }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
