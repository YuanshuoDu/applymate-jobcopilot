import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { db } from '@/lib/db'
import { runAdminMutation } from '@/lib/admin/write-transaction'

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('users.read', request)
  if (isAdminResponse(actor)) return actor
  const { id } = await context.params
  const keys = await db.userApiKeys.findUnique({ where: { userId: id }, select: {
    id: true, adzunaAppId: true, adzunaAppIdEnc: true, adzunaAppKey: true, adzunaAppKeyEnc: true,
    rapidapiKey: true, rapidapiKeyEnc: true, createdAt: true, updatedAt: true,
  } })
  return NextResponse.json({ keys: keys ? {
    id: keys.id,
    providers: {
      adzuna: Boolean((keys.adzunaAppId || keys.adzunaAppIdEnc) && (keys.adzunaAppKey || keys.adzunaAppKeyEnc)),
      rapidapi: Boolean(keys.rapidapiKey || keys.rapidapiKeyEnc),
    },
    createdAt: keys.createdAt,
    updatedAt: keys.updatedAt,
  } : null }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('users.api_keys.revoke', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { id } = await context.params
  const reason = request.headers.get('x-admin-reason')?.trim() ?? ''
  const key = request.headers.get('idempotency-key')?.trim()
  if (reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'A reason and Idempotency-Key are required' }, { status: 400 })
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'user.api_keys_revoked', idempotencyKey: key, targetId: id, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'user', targetId: id, tenantUserId: id, reason, outcome: 'success' }, mutate: tx => tx.userApiKeys.deleteMany({ where: { userId: id } }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true })
  return NextResponse.json({ revoked: result.value.count > 0 }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
