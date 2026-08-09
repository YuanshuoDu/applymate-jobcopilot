import { NextRequest, NextResponse } from 'next/server'
import { Plan } from '@prisma/client'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { adminUserMetadataSelect, toAdminUserMetadata } from '@/lib/admin/dto'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { parsePlan, reasonFrom } from '@/lib/admin/user-lifecycle'
import { db } from '@/lib/db'

type Params = { params: Promise<{ id: string }> }

export async function PATCH(request: NextRequest, { params }: Params) {
  const actor = await requireAdmin('billing.update', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const toPlan = parsePlan(body?.toPlan)
  const reason = reasonFrom(body?.reason, 'reason')
  const idempotencyKey = request.headers.get('idempotency-key')
  if (!toPlan || typeof reason !== 'string' || !idempotencyKey) return NextResponse.json({ error: toPlan ? typeof reason === 'string' ? 'Idempotency-Key is required' : reason.error : 'toPlan must be free, pro, or enterprise' }, { status: 400 })

  const { id } = await params
  const existing = await db.user.findUnique({ where: { id }, select: { plan: true } })
  if (!existing) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (existing.plan === toPlan) return NextResponse.json({ error: 'User already has this plan' }, { status: 409 })
  const result = await runAdminMutation({
    actorUserId: actor.userId,
    action: 'users.plan_updated',
    idempotencyKey,
    targetId: id,
    audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'user', targetId: id, tenantUserId: id, reason, outcome: 'success', before: { plan: existing.plan }, after: { plan: toPlan } },
    mutate: async (tx) => {
      await tx.userPlanChange.create({ data: { userId: id, fromPlan: existing.plan, toPlan, reason, actorUserId: actor.userId } })
      return tx.user.update({ where: { id }, data: { plan: toPlan }, select: adminUserMetadataSelect })
    },
  })
  if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  return NextResponse.json({ user: toAdminUserMetadata(result.value) }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

export async function GET(request: NextRequest, { params }: Params) {
  const actor = await requireAdmin('billing.read', request)
  if (isAdminResponse(actor)) return actor
  const { id } = await params
  const changes = await db.userPlanChange.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, fromPlan: true, toPlan: true, reason: true, actorUserId: true, createdAt: true } })
  return NextResponse.json({ changes }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
