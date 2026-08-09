import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { db } from '@/lib/db'

const transitions: Record<string, string[]> = { requested: ['processing', 'cancelled'], processing: ['completed', 'cancelled'] }

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('users.deletion.manage', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const body = await request.json().catch(() => null) as { status?: string; version?: number; reason?: string; note?: string } | null
  const id = (await params).id
  const status = typeof body?.status === 'string' ? body.status : ''
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 2000) : null
  const version = body?.version
  const key = request.headers.get('idempotency-key')?.trim() ?? ''
  if (!key || !reason || reason.length < 10 || reason.length > 500 || !['processing', 'completed', 'cancelled'].includes(status) || !Number.isInteger(version)) return NextResponse.json({ error: 'status, version, reason and Idempotency-Key are required' }, { status: 400 })
  const current = await db.adminDataDeletionRequest.findUnique({ where: { id }, select: { id: true, userId: true, status: true, version: true } })
  if (!current) return NextResponse.json({ error: 'Deletion request not found' }, { status: 404 })
  if (!transitions[current.status]?.includes(status)) return NextResponse.json({ error: 'Invalid deletion request transition' }, { status: 409 })
  if (version !== current.version) return NextResponse.json({ error: 'Deletion request changed; refresh before updating' }, { status: 409 })
  const completed = status === 'completed' || status === 'cancelled'
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'users.deletion_request_updated', idempotencyKey: key, targetId: id, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'user', targetId: current.userId, tenantUserId: current.userId, reason, outcome: 'success', before: { status: current.status, version: current.version }, after: { status, version: current.version + 1 } }, mutate: async (tx) => {
    const updated = await tx.adminDataDeletionRequest.updateMany({ where: { id, version: current.version, status: current.status }, data: { status, note, processedAt: completed ? new Date() : null, processedById: completed ? actor.userId : null, version: { increment: 1 } } })
    if (updated.count !== 1) throw new Error('Deletion request changed during update')
    const user = await tx.user.findUnique({ where: { id: current.userId }, select: { preferences: true } })
    const preferences = user?.preferences && typeof user.preferences === 'object' && !Array.isArray(user.preferences) ? { ...(user.preferences as Record<string, unknown>), dataDeletionRequestStatus: status } : { dataDeletionRequestStatus: status }
    await tx.user.update({ where: { id: current.userId }, data: { preferences: preferences as Prisma.InputJsonValue } })
    return tx.adminDataDeletionRequest.findUniqueOrThrow({ where: { id } })
  } })
  if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
  return NextResponse.json({ request: result.value }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
