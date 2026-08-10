import { createHash, randomBytes } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { db } from '@/lib/db'

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('admin_members.read', request)
  if (isAdminResponse(actor)) return actor
  const invitations = await db.adminInvitation.findMany({ where: { status: 'pending', expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, email: true, status: true, expiresAt: true, createdAt: true, role: { select: { key: true, name: true } } } })
  return NextResponse.json({ invitations }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

export async function POST(request: NextRequest) {
  const actor = await requireAdmin('admin_members.manage', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const body = await request.json().catch(() => null) as { email?: string; roleKey?: string; reason?: string } | null
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const roleKey = typeof body?.roleKey === 'string' ? body.roleKey.trim() : ''
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? ''
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 320 || !roleKey || reason.length < 10 || reason.length > 500 || !idempotencyKey) return NextResponse.json({ error: 'Invalid admin invitation' }, { status: 400 })
  const role = await db.adminRole.findUnique({ where: { key: roleKey }, select: { id: true, key: true, name: true } })
  if (!role) return NextResponse.json({ error: 'Role not found' }, { status: 404 })
  const token = randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000)
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'admin_invitation.created', idempotencyKey, targetId: email, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'admin_member', targetId: email, reason, outcome: 'success', after: { email, roleKey: role.key, expiresAt } }, mutate: (tx) => tx.adminInvitation.create({ data: { email, roleId: role.id, tokenHash, invitedById: actor.userId, expiresAt }, select: { id: true, email: true, expiresAt: true, role: { select: { key: true, name: true } } } }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true })
  const origin = request.headers.get('origin') ?? new URL(request.url).origin
  return NextResponse.json({ invitation: result.value, inviteUrl: `${origin}/invite/admin?token=${encodeURIComponent(token)}` }, { status: 201, headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
