import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { adminUserMetadataSelect, toAdminUserMetadata } from '@/lib/admin/dto'
import { adminPageLimit, pageResult } from '@/lib/admin/pagination'
import { db } from '@/lib/db'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { normalizeEmail } from '@/lib/auth-identifiers'

export async function POST(request: NextRequest) {
  const actor = await requireAdmin('admin_members.manage', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const body = await request.json().catch(() => null) as { email?: unknown; roleKey?: unknown; reason?: unknown } | null
  const email = typeof body?.email === 'string' ? normalizeEmail(body.email) : ''
  const roleKey = typeof body?.roleKey === 'string' ? body.roleKey.trim() : ''
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const key = request.headers.get('idempotency-key')
  if (!email.includes('@') || email.length > 320 || !roleKey || reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'Invalid admin member grant' }, { status: 400 })
  const [users, role] = await Promise.all([
    db.user.findMany({ where: { email: { equals: email, mode: 'insensitive' } }, take: 2, select: { id: true, email: true, name: true } }),
    db.adminRole.findUnique({ where: { key: roleKey }, select: { id: true, key: true, name: true } }),
  ])
  const user = users.length === 1 ? users[0] : null
  if (!user || !role) return NextResponse.json({ error: 'User or role not found' }, { status: 404 })
  const existing = await db.adminMembership.findUnique({ where: { userId: user.id }, select: { id: true } })
  if (existing) return NextResponse.json({ error: 'User already has an admin membership' }, { status: 409 })
  const result = await runAdminMutation({
    actorUserId: actor.userId,
    action: 'admin_members.granted',
    idempotencyKey: key,
    targetId: user.id,
    audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'admin_member', targetId: user.id, tenantUserId: user.id, reason, outcome: 'success', after: { email: user.email, roleKey: role.key } },
    mutate: (tx) => tx.adminMembership.create({ data: { userId: user.id, roleId: role.id, grantedById: actor.userId }, select: { id: true, status: true, role: { select: { key: true, name: true } } } }),
  })
  if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  return NextResponse.json({ member: { ...result.value, user } }, { status: 201, headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('admin_members.read', request)
  if (isAdminResponse(actor)) return actor
  const params = new URL(request.url).searchParams
  const limit = adminPageLimit(params.get('limit'))
  const cursor = params.get('cursor')
  const rows = await db.adminMembership.findMany({
    select: { id: true, status: true, mfaLevel: true, sessionVersion: true, grantedAt: true, revokedAt: true, user: { select: adminUserMetadataSelect }, role: { select: { key: true, name: true } } },
    orderBy: { id: 'asc' }, cursor: cursor ? { id: cursor } : undefined, skip: cursor ? 1 : undefined, take: limit + 1,
  })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'admin_members.list_viewed', outcome: 'success' })
  return NextResponse.json(pageResult(rows.map((row) => ({ ...row, user: toAdminUserMetadata(row.user) })), limit), { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
