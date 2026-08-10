import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { db } from '@/lib/db'
import { runAdminMutation } from '@/lib/admin/write-transaction'

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('security.webauthn.manage', request)
  if (isAdminResponse(actor)) return actor
  const { id } = await context.params
  const membership = await db.adminMembership.findFirst({ where: { OR: [{ id }, { userId: id }] }, select: { userId: true } })
  if (!membership) return NextResponse.json({ error: 'Administrator membership not found' }, { status: 404 })
  const credentials = await db.adminWebAuthnCredential.findMany({ where: { userId: membership.userId, revokedAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true, deviceName: true, deviceType: true, createdAt: true, lastUsedAt: true } })
  return NextResponse.json({ credentials }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('security.webauthn.manage', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { id } = await context.params
  const membership = await db.adminMembership.findFirst({ where: { OR: [{ id }, { userId: id }] }, select: { userId: true, role: { select: { key: true } } } })
  if (!membership) return NextResponse.json({ error: 'Administrator membership not found' }, { status: 404 })
  const userId = membership.userId
  const credentialId = request.nextUrl.searchParams.get('credentialId')?.trim() ?? ''
  const reason = request.headers.get('x-admin-reason')?.trim() ?? ''
  const key = request.headers.get('idempotency-key')?.trim()
  if (!credentialId || credentialId.length > 300 || reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'credentialId, reason and Idempotency-Key are required' }, { status: 400 })
  const credential = await db.adminWebAuthnCredential.findFirst({ where: { id: credentialId, userId, revokedAt: null }, select: { id: true, userId: true } })
  if (!credential) return NextResponse.json({ error: 'Credential not found' }, { status: 404 })
  const activeCount = await db.adminWebAuthnCredential.count({ where: { userId, revokedAt: null } })
  if (activeCount <= 1 && membership.role.key === 'super_admin') return NextResponse.json({ error: 'Register another WebAuthn credential before revoking the last super-admin key' }, { status: 409 })
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'admin.webauthn_credential_revoked', idempotencyKey: key, targetId: credentialId, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'admin_member', targetId: id, tenantUserId: userId, reason, outcome: 'success', after: { credentialId } }, mutate: tx => tx.adminWebAuthnCredential.updateMany({ where: { id: credentialId, userId, revokedAt: null }, data: { revokedAt: new Date() } }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true })
  return NextResponse.json({ revoked: result.value.count === 1 }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
