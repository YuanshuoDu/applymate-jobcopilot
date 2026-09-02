import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { AdminMutationConflict, runAdminMutation } from '@/lib/admin/write-transaction'

type RouteContext = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, context: RouteContext) {
  const actor = await requireAdmin('admin_members.manage', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError

  const { id } = await context.params
  const payload = await request.json().catch(() => null) as { reason?: unknown } | null
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? ''
  if (!id || reason.length < 10 || reason.length > 500 || !idempotencyKey) {
    return NextResponse.json({ error: 'Invalid invitation revocation request' }, { status: 400 })
  }

  let result
  try {
    result = await runAdminMutation({
      actorUserId: actor.userId,
      action: 'admin_invitation.revoked',
      idempotencyKey,
      targetId: id,
      audit: {
        requestId: actor.requestId,
        actorRoleKey: actor.roleKey,
        targetType: 'admin_member',
        targetId: id,
        reason,
        outcome: 'success',
        after: { status: 'revoked' },
      },
      mutate: async (tx) => {
        const invitation = await tx.adminInvitation.findUnique({ where: { id }, select: { email: true, status: true } })
        if (!invitation) throw new AdminMutationConflict('Invitation not found')
        if (invitation.status !== 'pending') throw new AdminMutationConflict('Invitation is no longer pending')
        const updated = await tx.adminInvitation.updateMany({ where: { id, status: 'pending' }, data: { status: 'revoked' } })
        if (updated.count !== 1) throw new AdminMutationConflict('Invitation changed before it could be revoked')
        return { id, email: invitation.email }
      },
    })
  } catch (error) {
    if (error instanceof AdminMutationConflict) return NextResponse.json({ error: error.message, code: 'INVITATION_STATE_CONFLICT' }, { status: 409 })
    throw error
  }

  if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  return NextResponse.json({ revoked: true, invitation: result.value }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
