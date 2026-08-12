import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { safeAuth } from '@/lib/safe-auth'
import { writeAdminAudit } from '@/lib/admin/audit'
import { db } from '@/lib/db'
import { isAdminHost, isLocalHost } from '@/lib/host-routing'
import { normalizeEmail } from '@/lib/auth-identifiers'

export async function POST(request: NextRequest) {
  if (!isAdminHost(request.nextUrl.hostname) && !isLocalHost(request.nextUrl.hostname)) {
    return NextResponse.json({ error: 'Administrator API is only available on the administrator host' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
  }
  const session = await safeAuth()
  const userId = session?.user?.id
  const email = session?.user?.email ? normalizeEmail(session.user.email) : ''
  const body = await request.json().catch(() => null) as { token?: string } | null
  const token = typeof body?.token === 'string' ? body.token.trim() : ''
  if (!userId || !email || token.length < 20) return NextResponse.json({ error: 'Sign in with the invited email before accepting this invitation' }, { status: 401 })
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const invitation = await db.adminInvitation.findUnique({ where: { tokenHash }, select: { id: true, email: true, roleId: true, expiresAt: true, status: true } })
  if (!invitation || normalizeEmail(invitation.email) !== email || invitation.status !== 'pending' || invitation.expiresAt <= new Date()) return NextResponse.json({ error: 'Invitation is invalid or expired' }, { status: 400 })
  const membership = await db.adminMembership.findUnique({ where: { userId }, select: { id: true } })
  if (membership) return NextResponse.json({ error: 'This account already has administrator access' }, { status: 409 })
  await db.$transaction(async (tx) => {
    await tx.adminMembership.create({ data: { userId, roleId: invitation.roleId } })
    await tx.adminInvitation.updateMany({ where: { id: invitation.id, status: 'pending' }, data: { status: 'accepted', acceptedAt: new Date() } })
  })
  await writeAdminAudit({ requestId: request.headers.get('x-request-id') ?? crypto.randomUUID(), actorUserId: userId, action: 'admin_invitation.accepted', targetType: 'admin_member', tenantUserId: userId, outcome: 'success', after: { invitationId: invitation.id } })
  return NextResponse.json({ accepted: true }, { headers: { 'Cache-Control': 'no-store' } })
}
