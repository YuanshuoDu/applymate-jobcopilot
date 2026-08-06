import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { AdminMutationConflict, runAdminMutation } from '@/lib/admin/write-transaction'
import { db } from '@/lib/db'

type BreakGlassApprovalResult = { permission: string; expiresAt: Date }

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('break_glass.approve', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { id } = await context.params
  const payload = await request.json().catch(() => null) as { reason?: unknown } | null
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  const key = request.headers.get('idempotency-key')
  if (reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'Invalid break-glass approval' }, { status: 400 })
  const grant = await db.adminBreakGlassGrant.findUnique({ where: { id }, select: { requesterId: true, expiresAt: true, approverId: true, permission: true } })
  if (!grant) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (grant.requesterId === actor.userId) return NextResponse.json({ error: 'Requester cannot approve their own grant' }, { status: 403 })
  if (grant.expiresAt <= new Date() || grant.approverId) return NextResponse.json({ error: 'Grant expired or was already approved' }, { status: 409 })
  try {
    const result = await runAdminMutation<BreakGlassApprovalResult>({
      actorUserId: actor.userId,
      action: 'break_glass.approved',
      idempotencyKey: key,
      targetId: id,
      audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetId: id, reason, after: { permission: grant.permission }, outcome: 'success' },
      mutate: async (tx) => {
        const current = await tx.adminBreakGlassGrant.findUnique({ where: { id }, select: { permission: true, expiresAt: true, approverId: true } })
        if (!current || current.expiresAt <= new Date() || current.approverId) throw new AdminMutationConflict('Grant expired, changed, or was already approved')
        const approved = await tx.adminBreakGlassGrant.updateMany({ where: { id, approverId: null, revokedAt: null, expiresAt: { gt: new Date() } }, data: { approverId: actor.userId } })
        if (!approved.count) throw new AdminMutationConflict('Grant changed')
        return { permission: current.permission, expiresAt: current.expiresAt }
      },
    })
    if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
    return NextResponse.json({ id, permission: result.value.permission, expiresAt: result.value.expiresAt }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
  } catch (error) {
    if (error instanceof AdminMutationConflict) return NextResponse.json({ error: error.message }, { status: 409 })
    throw error
  }
}
